import "server-only";

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { getDatabase } from "./prisma";
import type { PrivateWidgetQuery } from "../telegram/types";
import { isPrivateWidgetQuery, isPositiveId } from "../telegram/types";
import { expiredQuiz, invalidQuiz, parseSessionAction, quizFeedback } from "../telegram/quiz-domain";
import { scheduleReview } from "../srs/scheduler";
import type { Feedback, QuizContent, SessionMode } from "../telegram/quiz-domain";

export type QueryResult = { feedback: Feedback; receiptId?: string; delivered?: boolean };
export type SessionStart =
  | { kind: "message"; message: string }
  | { kind: "widget"; id: string; content: QuizContent; total: number; position: number; mode: SessionMode; sendToken: string; notice?: string };
export interface QuizRepository {
  create(userId: number, chatId: number, mode?: SessionMode, requestId?: number): Promise<SessionStart>;
  bind(id: string, messageId: number, sendToken?: string): Promise<void>;
  revoke(id: string, sendToken?: string): Promise<void>;
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

  async create(userId: number, chatId: number, mode: SessionMode = "LEARN", requestId?: number): Promise<SessionStart> {
    if (!isPositiveId(userId) || userId !== chatId || !["LEARN", "REVIEW"].includes(mode) ||
        (requestId !== undefined && !isPositiveId(requestId))) throw new Error("Invalid quiz owner.");
    return this.database().$transaction(async tx => {
      const user = BigInt(userId);
      // Native ON CONFLICT handles simultaneous first-ever commands safely.
      await tx.telegramUser.createMany({ data: [{ id: user }], skipDuplicates: true });
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
      // Shared lock order with process(): user first, then session. This also
      // serializes SRS updates from multiple pre-existing LEGACY sessions.
      await tx.$queryRaw`SELECT id FROM "TelegramUser" WHERE id = ${user} FOR UPDATE`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      await tx.studySession.updateMany({ where: { userId: user, status: "ACTIVE", expiresAt: { lte: clock.now } }, data: { status: "EXPIRED", updatedAt: clock.now } });
      const include = { items: { orderBy: { position: "asc" as const }, include: { attempt: true, word: { include: { options: { orderBy: { position: "asc" as const } } } } } } };
      const request = requestId === undefined ? null : await tx.learnRequest.findUnique({
        where: { userId_messageId: { userId: user, messageId: BigInt(requestId) } }, include: { session: { include } },
      });
      let session = request?.session ?? null;
      if (session && (session.revokedAt || session.expiresAt <= clock.now || session.status === "COMPLETED")) {
        return { kind: "message", message: "Это занятие уже завершено или истекло. Отправьте новую команду /learn или /review." };
      }
      if (!session) {
        const candidates = await tx.studySession.findMany({
          where: { userId: user, revokedAt: null, expiresAt: { gt: clock.now }, status: { in: ["ACTIVE", "LEGACY"] } },
          orderBy: { createdAt: "desc" }, include,
        });
        session = candidates.find(candidate => candidate.status === "ACTIVE") ??
          candidates.find(candidate => candidate.items.some(item => !item.attempt)) ?? null;
      }
      let isNew = false;
      if (!session) {
        const words = await tx.word.findMany({
          where: mode === "REVIEW"
            ? { progress: { some: { userId: user, dueAt: { lte: clock.now } } } }
            : { progress: { none: { userId: user } }, items: { none: { session: { userId: user }, attempt: { isNot: null } } } },
          include: { options: { orderBy: { position: "asc" } }, progress: { where: { userId: user } } },
        });
        const valid = words.filter(word => word.options.length === 4 && word.options.filter(o => o.isCorrect).length === 1 && word.options.every((o, i) => o.position === i));
        const unique = Array.from(new Map(valid.map(word => [word.term.toLowerCase(), word])).values());
        const chosen = (mode === "LEARN" ? shuffle(unique) : unique.sort((a, b) =>
          a.progress[0].dueAt.getTime() - b.progress[0].dueAt.getTime() || a.id.localeCompare(b.id))).slice(0, WORD_COUNT);
        if (!chosen.length) return { kind: "message", message: mode === "REVIEW"
          ? "Сейчас нет запланированных повторений. Загляните позже — слова появятся, когда подойдёт время."
          : "Новых слов пока нет. Отправьте /review, чтобы проверить запланированные повторения." };
        session = await tx.studySession.create({ data: {
          id: randomBytes(12).toString("hex"), userId: user, chatId: user, mode, status: "ACTIVE",
          expiresAt: new Date(clock.now.getTime() + SESSION_DURATION_MS),
          items: { create: chosen.map((word, position) => ({ wordId: word.id, position })) },
        }, include });
        isNew = true;
      }
      if (requestId !== undefined && !request) await tx.learnRequest.create({ data: { userId: user, messageId: BigInt(requestId), sessionId: session.id } });
      if (session.messageId !== null) return { kind: "message", message:
        `${session.mode === mode ? "Продолжим" : "Сначала завершите"} активное занятие ${session.mode}. Нажмите «Продолжить занятие» в его виджете выше. Новое занятие не создано.` };
      if (session.sendLeaseUntil && session.sendLeaseUntil > clock.now) return { kind: "message", message: "Виджет уже отправляется. Если он не появился, повторите команду через 30 секунд." };
      const sendToken = randomBytes(12).toString("hex");
      await tx.studySession.update({ where: { id: session.id }, data: { sendToken, sendLeaseUntil: new Date(clock.now.getTime() + 30_000) } });
      const position = Math.max(0, session.items.findIndex(item => !item.attempt));
      const first = session.items[position].word;
      return { kind: "widget", id: session.id, content: { term: first.term, partOfSpeech: first.partOfSpeech, options: first.options.map(o => o.text) },
        total: session.items.length, position, mode: session.mode, sendToken,
        ...(isNew && session.items.length < WORD_COUNT ? { notice: `Сегодня доступно ${session.items.length} ${mode === "LEARN" ? "новых слов" : "слов для повторения"}. Начнём короткое занятие.` } : {}),
      };
    });
  }

  async bind(id: string, messageId: number, sendToken?: string): Promise<void> {
    if (!isPositiveId(messageId)) throw new Error("Invalid message.");
    const result = await this.database().studySession.updateMany({
      where: { id, messageId: null, revokedAt: null, ...(sendToken ? { sendToken } : {}) }, data: { messageId: BigInt(messageId), sendToken: null, sendLeaseUntil: null },
    });
    if (result.count !== 1) throw new Error("Quiz cannot be activated.");
  }

  async revoke(id: string, sendToken?: string): Promise<void> {
    await this.database().studySession.updateMany({ where: { id, ...(sendToken ? { sendToken, messageId: null } : {}) }, data: { revokedAt: new Date(), status: "EXPIRED" } });
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
      await tx.$queryRaw`SELECT id FROM "TelegramUser" WHERE id = ${BigInt(query.from.id)} FOR UPDATE`;
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
          status: "completed", mode: session.mode, revision: session.revision, total: items.length, correctCount,
          incorrectCount: items.length - correctCount,
          accuracy: items.length ? Math.round(100 * correctCount / items.length) : 0
        };
      };
      const question = (index: number): Feedback => {
        const item = items[index];
        return {
          status: "question", mode: session.mode, revision: session.revision, position: index, total: items.length, content: {
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
              correct: selected === correctOption.position, createdAt: clock.now,
            }
          });
          const key = { userId: session.userId, wordId: item.wordId };
          const prior = await tx.userWordProgress.findUnique({ where: { userId_wordId: key } });
          const scheduled = scheduleReview(prior, action.kind === "reveal" ? "revealed" : attempt.correct ? "correct" : "incorrect", clock.now);
          await tx.userWordProgress.upsert({ where: { userId_wordId: key },
            create: { ...key, ...scheduled, lastAttemptId: attempt.id, createdAt: clock.now, updatedAt: clock.now },
            update: { ...scheduled, lastAttemptId: attempt.id, updatedAt: clock.now },
          });
          await tx.studySession.update({ where: { id: session.id }, data: {
            currentIndex: index + 1, revision: { increment: 1 }, updatedAt: clock.now,
            ...(index + 1 === items.length ? { status: "COMPLETED", completedAt: clock.now } : {}),
          } });
          if (action.kind === "reveal") await tx.sessionItem.update({
            where: { id: item.id }, data: { revealedAt: clock.now },
          });
          const base = quizFeedback(attempt, action.kind === "reveal", correctOption);
          feedback = {
            ...base, correctIndex: correctOption.position, answer: correctOption.text,
            mode: session.mode, revision: session.revision + 1, position: index, total: items.length, hasNext: true
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
