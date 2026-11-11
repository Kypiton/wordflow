import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { getDatabase } from "./prisma";
import type { PrivateWidgetQuery } from "../telegram/types";
import { isPrivateWidgetQuery, isPositiveId } from "../telegram/types";
import { expiredQuiz, invalidQuiz, parseQuizAction, quizFeedback } from "../telegram/quiz-domain";
import type { Feedback, QuizContent } from "../telegram/quiz-domain";

export type QueryResult = { feedback: Feedback; receiptId?: string; delivered?: boolean };
export interface QuizRepository {
  create(userId: number, chatId: number): Promise<{ id: string; content: QuizContent }>;
  bind(id: string, messageId: number): Promise<void>;
  revoke(id: string): Promise<void>;
  process(query: PrivateWidgetQuery): Promise<QueryResult>;
  delivered(id: string): Promise<void>;
}

export class PrismaQuizRepository implements QuizRepository {
  constructor(private database: () => PrismaClient = getDatabase) {}

  async create(userId: number, chatId: number): Promise<{ id: string; content: QuizContent }> {
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId !== chatId) throw new Error("Invalid quiz owner.");
    return this.database().$transaction(async tx => {
      const word = await tx.word.findUnique({
        where: { slug_version: { slug: "reluctant", version: 1 } },
        include: { options: { orderBy: { position: "asc" } } },
      });
      if (!word || word.options.length !== 4 || word.options.filter(o => o.isCorrect).length !== 1 ||
          word.options.some((option, i) => option.position !== i)) throw new Error("Quiz content is not configured.");
      await tx.telegramUser.upsert({ where: { id: BigInt(userId) }, create: { id: BigInt(userId) }, update: {} });
      const id = randomBytes(12).toString("hex");
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      await tx.studySession.create({ data: {
        id, userId: BigInt(userId), chatId: BigInt(chatId),
        expiresAt: new Date(clock.now.getTime() + 30 * 60_000),
        items: { create: { wordId: word.id, position: 0 } },
      } });
      return { id, content: { term: word.term, partOfSpeech: word.partOfSpeech, options: word.options.map(o => o.text) } };
    });
  }

  async bind(id: string, messageId: number): Promise<void> {
    if (!isPositiveId(messageId)) throw new Error("Invalid message.");
    const result = await this.database().studySession.updateMany({
      where: { id, messageId: null, revokedAt: null }, data: { messageId: BigInt(messageId) },
    });
    if (result.count !== 1) throw new Error("Quiz cannot be activated.");
  }

  async revoke(id: string): Promise<void> {
    await this.database().studySession.updateMany({ where: { id }, data: { revokedAt: new Date() } });
  }

  async delivered(id: string): Promise<void> {
    await this.database().widgetQueryReceipt.updateMany({ where: { id, deliveredAt: null }, data: { deliveredAt: new Date() } });
  }

  async process(query: PrivateWidgetQuery): Promise<QueryResult> {
    if (!isPrivateWidgetQuery(query)) return { feedback: invalidQuiz() };
    const action = parseQuizAction(query.data);
    if (!action) return { feedback: invalidQuiz() };
    // Hash only canonical relevant fields, never untrusted object key ordering.
    const fingerprint = createHash("sha256").update(JSON.stringify([
      query.from.id, query.chat.id, query.message_id, query.chat_instance, query.type.type, query.data,
    ])).digest("hex");
    return this.database().$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
      // Serialize all answer/reveal operations on this session across Vercel instances.
      // Parameterized SQL; READ COMMITTED sees the preceding lock holder's commit.
      await tx.$queryRaw`SELECT id FROM "StudySession" WHERE id = ${action.sessionId} FOR UPDATE`;
      const session = await tx.studySession.findUnique({ where: { id: action.sessionId }, include: {
        items: { where: { position: 0 }, include: { attempt: true, word: { include: { options: true } } } },
      } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!session) return { feedback: expiredQuiz() };
      if (session.userId !== BigInt(query.from.id) || session.chatId !== BigInt(query.chat.id) ||
          session.messageId !== BigInt(query.message_id) ||
          (session.chatInstance !== null && session.chatInstance !== query.chat_instance)) return { feedback: invalidQuiz() };
      if (session.revokedAt || session.expiresAt <= clock.now) return { feedback: expiredQuiz() };
      const previous = await tx.widgetQueryReceipt.findUnique({ where: { id: query.id } });
      if (previous) {
        if (previous.sessionId !== session.id || previous.fingerprint !== fingerprint) return { feedback: invalidQuiz() };
        return { feedback: previous.response as Feedback, receiptId: previous.id, delivered: previous.deliveredAt !== null };
      }
      const item = session.items[0];
      const correctOption = item?.word.options.find(o => o.isCorrect);
      if (!item || !correctOption || item.word.options.filter(o => o.isCorrect).length !== 1 ||
          (action.selected !== null && !item.word.options.some(o => o.position === action.selected))) return { feedback: invalidQuiz() };
      if (!session.chatInstance) await tx.studySession.update({ where: { id: session.id }, data: { chatInstance: query.chat_instance } });
      // One immutable attempt per item, protected by both the row lock and UNIQUE.
      const attempt = item.attempt ?? await tx.reviewAttempt.create({ data: {
        sessionItemId: item.id, selectedPosition: action.selected,
        correct: action.selected === correctOption.position,
      } });
      const revealed = item.revealedAt !== null || action.selected === null;
      if (action.selected === null && !item.revealedAt) await tx.sessionItem.update({ where: { id: item.id }, data: { revealedAt: clock.now } });
      const feedback = quizFeedback(attempt, revealed, correctOption);
      await tx.widgetQueryReceipt.create({ data: {
        id: query.id, sessionId: session.id, fingerprint, response: feedback as Prisma.InputJsonValue,
      } });
      return { feedback, receiptId: query.id, delivered: false };
    }, { isolationLevel: "ReadCommitted", maxWait: 1000, timeout: 3500 });
  }
}
