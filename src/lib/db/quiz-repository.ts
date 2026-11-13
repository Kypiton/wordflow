import "server-only";

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { getDatabase } from "./prisma";
import type { PrivateWidgetQuery } from "../telegram/types";
import { isPrivateWidgetQuery, isPositiveId } from "../telegram/types";
import { expiredQuiz, invalidQuiz, parseSessionAction, quizFeedback } from "../telegram/quiz-domain";
import { MODE_LABELS } from "../telegram/navigation";
import { scheduleReview } from "../srs/scheduler";
import type { Feedback, QuizContent, SessionMode } from "../telegram/quiz-domain";

export type QueryResult = { feedback: Feedback; receiptId?: string; delivered?: boolean };
export type SessionStart =
  | { kind: "message"; message: string }
  | { kind: "widget"; id: string; content: QuizContent; total: number; position: number; mode: SessionMode; sendToken: string; notice?: string; rebind?: boolean };
export interface QuizRepository {
  create(userId: number, chatId: number, mode?: SessionMode, requestId?: number, resumeExisting?: boolean): Promise<SessionStart>;
  bind(id: string, messageId: number, sendToken?: string): Promise<void>;
  revoke(id: string, sendToken?: string): Promise<void>;
  release(id: string, sendToken: string): Promise<void>;
  process(query: PrivateWidgetQuery): Promise<QueryResult>;
  delivered(id: string): Promise<void>;
}

function contentOf(word: { term: string; partOfSpeech: string; personalWordId: string | null; example?: string | null; options: { text: string }[] }): QuizContent {
  return { term: word.term, partOfSpeech: word.partOfSpeech, options: word.options.map(o => o.text), ...(word.personalWordId ? { kind: "self" as const } : word.example ? { example: word.example } : {}) };
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

  async create(userId: number, chatId: number, mode: SessionMode = "LEARN", requestId?: number, resumeExisting = false): Promise<SessionStart> {
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
      const owner = await tx.telegramUser.findUniqueOrThrow({ where: { id: user } });
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
      // Replayed Telegram messages must not send a second widget. A fresh
      // /resume message is needed for every deliberate recovery attempt.
      if (resumeExisting && request) return { kind: "message", message: "Запрос продолжения уже обработан. Если карточка не открылась, нажмите «▶️ Продолжить занятие» ещё раз." };
      let isNew = false;
      if (!session && resumeExisting) return { kind: "message", message: "Активного занятия нет. Нажмите «📚 Учить слова» или «🔁 Повторить»." };
      if (!session) {
        const words = await tx.word.findMany({
          where: { isCurrent: true, AND: [
            owner.vocabularyMode === "GENERAL" ? { personalWordId: null, ...(owner.cefrLevel ? { cefrLevel: owner.cefrLevel } : {}) }
              : owner.vocabularyMode === "PERSONAL" ? { personalWord: { ownerId: user, archivedAt: null } }
              : { OR: [{ personalWordId: null, ...(owner.cefrLevel ? { cefrLevel: owner.cefrLevel } : {}) }, { personalWord: { ownerId: user, archivedAt: null } }] },
            mode === "REVIEW"
              ? { progress: { some: { userId: user, dueAt: { lte: clock.now } } } }
              : { progress: { none: { userId: user } }, items: { none: { session: { userId: user }, attempt: { isNot: null } } } },
          ] },
          include: { options: { orderBy: { position: "asc" } }, progress: { where: { userId: user } } },
        });
        const valid = words.filter(word => word.personalWordId ? Boolean(word.translation) && word.options.length === 0 : word.options.length === 4 && word.options.filter(o => o.isCorrect).length === 1 && word.options.every((o, i) => o.position === i));
        // Prefer the user's own version when a personal term also exists in the
        // global catalog. Both versions must never appear in the same session.
        const byTerm = new Map<string, (typeof valid)[number]>();
        for (const word of valid) {
          const key = word.term.toLowerCase();
          const previous = byTerm.get(key);
          if (!previous || (word.personalWordId && !previous.personalWordId)) byTerm.set(key, word);
        }
        const unique = Array.from(byTerm.values());
        const byDue = (a: (typeof valid)[number], b: (typeof valid)[number]) =>
          a.progress[0].dueAt.getTime() - b.progress[0].dueAt.getTime() || a.id.localeCompare(b.id);
        const ordered = mode === "LEARN" ? shuffle(unique) : unique.sort(byDue);
        let chosen: typeof valid;
        if (owner.vocabularyMode === "MIXED") {
          // Reserving slots prevents a large shared catalog from crowding out
          // personal words. Fill unused slots from either side when necessary.
          const personal = ordered.filter(word => word.personalWordId !== null);
          const general = ordered.filter(word => word.personalWordId === null);
          const personalQuota = Math.min(Math.ceil(WORD_COUNT / 2), personal.length);
          const generalQuota = Math.min(WORD_COUNT - personalQuota, general.length);
          chosen = [...personal.slice(0, personalQuota), ...general.slice(0, generalQuota)];
          if (chosen.length < WORD_COUNT) {
            const selected = new Set(chosen.map(word => word.id));
            chosen.push(...ordered.filter(word => !selected.has(word.id)).slice(0, WORD_COUNT - chosen.length));
          }
          chosen = mode === "LEARN" ? shuffle(chosen) : chosen.sort(byDue);
        } else {
          chosen = ordered.slice(0, WORD_COUNT);
        }
        if (!chosen.length) return { kind: "message", message: mode === "REVIEW"
          ? "Сейчас нет запланированных повторений. Загляните позже — слова появятся, когда подойдёт время."
          : `Новых слов пока нет в режиме ${MODE_LABELS[owner.vocabularyMode]}${owner.cefrLevel && owner.vocabularyMode !== "PERSONAL" ? ` (${owner.cefrLevel})` : ""}. Выберите другой уровень или словарь в настройках.` };
        session = await tx.studySession.create({ data: {
          id: randomBytes(12).toString("hex"), userId: user, chatId: user, mode, vocabularyMode: owner.vocabularyMode, cefrLevel: owner.cefrLevel, status: "ACTIVE",
          expiresAt: new Date(clock.now.getTime() + SESSION_DURATION_MS),
          items: { create: chosen.map((word, position) => ({ wordId: word.id, position })) },
        }, include });
        isNew = true;
      }
      if (requestId !== undefined && !request) await tx.learnRequest.create({ data: { userId: user, messageId: BigInt(requestId), sessionId: session.id } });
      if (session.messageId !== null && !resumeExisting) return { kind: "message", message:
        `У вас есть активное занятие ${session.mode === "LEARN" ? "изучения" : "повторения"}. Нажмите «▶️ Продолжить занятие» в меню снизу, чтобы получить карточку здесь. Прогресс сохранён.` };
      if (session.sendLeaseUntil && session.sendLeaseUntil > clock.now) return { kind: "message", message: "Виджет уже отправляется. Если он не появился, повторите команду через 30 секунд." };
      const sendToken = randomBytes(12).toString("hex");
      await tx.studySession.update({ where: { id: session.id }, data: { sendToken, sendLeaseUntil: new Date(clock.now.getTime() + 30_000) } });
      const position = Math.max(0, session.items.findIndex(item => !item.attempt));
      const first = session.items[position].word;
      return { kind: "widget", id: session.id, content: contentOf(first),
        total: session.items.length, position, mode: session.mode, sendToken,
        ...(session.messageId !== null ? { rebind: true } : {}),
        ...(isNew && session.items.length < WORD_COUNT ? { notice: `Сегодня доступно ${session.items.length} ${mode === "LEARN" ? "новых слов" : "слов для повторения"}. Начнём короткое занятие.` } : {}),
      };
    });
  }

  async bind(id: string, messageId: number, sendToken?: string): Promise<void> {
    if (!isPositiveId(messageId)) throw new Error("Invalid message.");
    const result = await this.database().studySession.updateMany({
      where: { id, revokedAt: null, status: { in: ["ACTIVE", "LEGACY"] }, ...(sendToken ? { sendToken } : { messageId: null }) },
      data: { messageId: BigInt(messageId), chatInstance: null, sendToken: null, sendLeaseUntil: null },
    });
    if (result.count !== 1) throw new Error("Quiz cannot be activated.");
  }

  async release(id: string, sendToken: string): Promise<void> {
    // Recovery failure must NOT invalidate the previously bound widget.
    await this.database().studySession.updateMany({
      where: { id, sendToken, revokedAt: null },
      data: { sendToken: null, sendLeaseUntil: null },
    });
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
              attempt: true, word: { include: { personalWord: true, options: { orderBy: { position: "asc" } } } },
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
      if (session.items.some(item => item.word.personalWord && item.word.personalWord.ownerId !== session.userId)) return { feedback: invalidQuiz() };
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
        const base = { mode: session.mode, revision: session.revision, position: index, total: items.length, content: contentOf(item.word) };
        return item.word.personalWordId && item.revealedAt
          ? { ...base, status: "recall", answer: item.word.translation!, ...(item.word.example ? { example: item.word.example } : {}) }
          : { ...base, status: "question" };

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
        const personal = Boolean(item?.word.personalWordId);
        const correctOption = item?.word.options.find(o => o.isCorrect);
        if (!item || index !== currentIndex ||
            (personal ? !item.word.translation || action.kind === "answer" || (action.kind === "rating" && !item.revealedAt)
              : action.kind === "rating" || !correctOption || item.word.options.filter(o => o.isCorrect).length !== 1 ||
                (action.kind === "answer" && !item.word.options.some(o => o.position === action.selected)))) {
          feedback = invalidQuiz();
        } else if (personal && action.kind === "reveal") {
          // Reveal alone is not an attempt. A later authenticated rating commits SRS.
          if (!item.revealedAt) {
            await tx.sessionItem.update({ where: { id: item.id }, data: { revealedAt: clock.now } });
            await tx.studySession.update({ where: { id: session.id }, data: { revision: { increment: 1 } } });
            item.revealedAt = clock.now;
            session.revision++;
          }
          feedback = question(index);
        } else {
          const selected = action.kind === "answer" ? action.selected : null;
          const correct = action.kind === "rating" ? action.remembered : selected === correctOption!.position;
          const attempt = await tx.reviewAttempt.create({ data: {
            sessionItemId: item.id, selectedPosition: selected, correct,
            selfRating: action.kind === "rating" ? action.remembered : null, createdAt: clock.now,
          } });
          const key = { userId: session.userId, wordId: item.wordId };
          const prior = await tx.userWordProgress.findUnique({ where: { userId_wordId: key } });
          const scheduled = scheduleReview(prior, action.kind === "reveal" ? "revealed" : correct ? "correct" : "incorrect", clock.now);
          await tx.userWordProgress.upsert({ where: { userId_wordId: key },
            create: { ...key, ...scheduled, lastAttemptId: attempt.id, createdAt: clock.now, updatedAt: clock.now },
            update: { ...scheduled, lastAttemptId: attempt.id, updatedAt: clock.now },
          });
          await tx.studySession.update({ where: { id: session.id }, data: {
            currentIndex: index + 1, revision: { increment: 1 }, updatedAt: clock.now,
            ...(index + 1 === items.length ? { status: "COMPLETED", completedAt: clock.now } : {}),
          } });
          if (action.kind === "reveal") await tx.sessionItem.update({ where: { id: item.id }, data: { revealedAt: clock.now } });
          feedback = {
            ...(personal ? { status: "answered", selected: null, correct } : quizFeedback(attempt, action.kind === "reveal", correctOption!)),
            ...(personal ? { answer: item.word.translation! } : { correctIndex: correctOption!.position, answer: correctOption!.text }),
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
