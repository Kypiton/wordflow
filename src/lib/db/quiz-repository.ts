import "server-only";

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { getDatabase } from "./prisma";
import type { PrivateWidgetQuery } from "../telegram/types";
import { isPrivateWidgetQuery, isPositiveId } from "../telegram/types";
import { expiredQuiz, invalidQuiz, parseSessionAction, quizFeedback } from "../telegram/quiz-domain";
import type { Feedback, QuizContent } from "../telegram/quiz-domain";

export type QueryResult = { feedback: Feedback; receiptId?: string; delivered?: boolean };
export interface QuizRepository {
  create(userId: number, chatId: number): Promise<{ id: string; content: QuizContent }>;
  bind(id: string, messageId: number): Promise<void>;
  revoke(id: string): Promise<void>;
  process(query: PrivateWidgetQuery): Promise<QueryResult>;
  delivered(id: string): Promise<void>;
}

const WORD_COUNT = 10;
const SESSION_DURATION_MS = 30 * 60_000;

function shuffle<T>(items: T[]): T[] {
  const values = [...items];
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export class PrismaQuizRepository implements QuizRepository {
  constructor(private database: () => PrismaClient = getDatabase) { }

  async create(userId: number, chatId: number): Promise<{ id: string; content: QuizContent }> {
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId !== chatId) throw new Error("Invalid quiz owner.");
    return this.database().$transaction(async tx => {
      const words = await tx.word.findMany({ include: { options: { orderBy: { position: "asc" } } } });
      const valid = words.filter(word =>
        word.options.length === 4 &&
        word.options.filter(option => option.isCorrect).length === 1 &&
        word.options.every((option, i) => option.position === i)
      );
      const unique = Array.from(new Map(valid.map(word => [word.term.toLowerCase(), word])).values());
      if (unique.length < WORD_COUNT) throw new Error("At least 10 valid vocabulary words are required.");
      const chosen = shuffle(unique).slice(0, WORD_COUNT);
      await tx.telegramUser.upsert({ where: { id: BigInt(userId) }, create: { id: BigInt(userId) }, update: {} });
      const id = randomBytes(12).toString("hex");
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      await tx.studySession.create({
        data: {
          id, userId: BigInt(userId), chatId: BigInt(chatId),
          expiresAt: new Date(clock.now.getTime() + SESSION_DURATION_MS),
          items: { create: chosen.map((word, position) => ({ wordId: word.id, position })) },
        }
      });
      const first = chosen[0];
      return { id, content: { term: first.term, partOfSpeech: first.partOfSpeech, options: first.options.map(o => o.text) } };
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
    const action = parseSessionAction(query.data);
    if (!action) return { feedback: invalidQuiz() };
    const fingerprint = createHash("sha256").update(JSON.stringify([
      query.from.id, query.chat.id, query.message_id, query.chat_instance, query.type.type, query.data,
    ])).digest("hex");

    return this.database().$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
      await tx.$queryRaw`SELECT id FROM "StudySession" WHERE id = ${action.sessionId} FOR UPDATE`;
      const session = await tx.studySession.findUnique({
        where: { id: action.sessionId },
        include: {
          items: {
            orderBy: { position: "asc" }, include: {
              attempt: true, word: { include: { options: { orderBy: { position: "asc" } } } },
            }
          }
        },
      });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!session) return { feedback: expiredQuiz() };
      if (session.userId !== BigInt(query.from.id) || session.chatId !== BigInt(query.chat.id) ||
        session.messageId !== BigInt(query.message_id) ||
        (session.chatInstance !== null && session.chatInstance !== query.chat_instance)) {
        return { feedback: invalidQuiz() };
      }
      if (session.revokedAt || session.expiresAt <= clock.now) return { feedback: expiredQuiz() };

      const previous = await tx.widgetQueryReceipt.findUnique({ where: { id: query.id } });
      if (previous) {
        if (previous.sessionId !== session.id || previous.fingerprint !== fingerprint) return { feedback: invalidQuiz() };
        return { feedback: previous.response as Feedback, receiptId: previous.id, delivered: previous.deliveredAt !== null };
      }

      const items = session.items;
      const currentIndex = items.findIndex(item => !item.attempt);
      const completed = currentIndex === -1;
      const summary = (): Feedback => {
        const correctCount = items.filter(item => item.attempt?.correct).length;
        return {
          status: "completed", total: items.length, correctCount,
          incorrectCount: items.length - correctCount,
          accuracy: items.length ? Math.round(100 * correctCount / items.length) : 0
        };
      };
      const question = (index: number): Feedback => {
        const item = items[index];
        return {
          status: "question", position: index, total: items.length, content: {
            term: item.word.term, partOfSpeech: item.word.partOfSpeech,
            options: item.word.options.map(option => option.text),
          }
        };
      };
      let feedback: Feedback;

      if (action.kind === "sync") {
        feedback = completed ? summary() : question(currentIndex);
      } else if (action.kind === "next") {
        // A Next request must follow an answered question. Repeated Next calls
        // return the same next question and cannot skip an unanswered item.
        if (action.position < 0 || action.position >= items.length || !items[action.position].attempt ||
          (!completed && action.position !== currentIndex - 1) ||
          (completed && action.position !== items.length - 1)) {
          feedback = invalidQuiz();
        } else {
          feedback = completed ? summary() : question(currentIndex);
        }
      } else {
        const index = action.position;
        const item = items[index];
        if (!item || index !== currentIndex || !item.word.options.some(o => o.isCorrect) ||
          item.word.options.filter(o => o.isCorrect).length !== 1 ||
          (action.kind === "answer" && !item.word.options.some(o => o.position === action.selected))) {
          feedback = invalidQuiz();
        } else {
          const correctOption = item.word.options.find(o => o.isCorrect)!;
          const selected = action.kind === "answer" ? action.selected : null;
          const attempt = await tx.reviewAttempt.create({
            data: {
              sessionItemId: item.id, selectedPosition: selected,
              correct: selected === correctOption.position,
            }
          });
          if (action.kind === "reveal") await tx.sessionItem.update({
            where: { id: item.id }, data: { revealedAt: clock.now },
          });
          const base = quizFeedback(attempt, action.kind === "reveal", correctOption);
          feedback = {
            ...base, correctIndex: correctOption.position, answer: correctOption.text,
            position: index, total: items.length, hasNext: true
          } as Feedback;
        }
      }

      if (session.chatInstance === null) await tx.studySession.update({
        where: { id: session.id }, data: { chatInstance: query.chat_instance },
      });
      await tx.widgetQueryReceipt.create({
        data: {
          id: query.id, sessionId: session.id, fingerprint,
          response: feedback as Prisma.InputJsonValue,
        }
      });
      return { feedback, receiptId: query.id, delivered: false };
    }, { isolationLevel: "ReadCommitted", maxWait: 1000, timeout: 3500 });
  }
}
