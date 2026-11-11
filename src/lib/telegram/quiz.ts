import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { answerWidgetQuery, sendWidget } from "./client";
import { quizWidgetHtml } from "./quiz-widget";
import { isPrivateWidgetQuery, isQueryId, isRecord } from "./types";
import type { PrivateWidgetQuery } from "./types";

const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 1000;
const CORRECT_INDEX = 2;
const CORRECT_ANSWER = "Неохотный";

type Feedback = {
  status: "answered" | "revealed";
  selected: number | null;
  correct: boolean;
  correctIndex?: number;
  answer?: string;
} | { status: "error" | "expired"; message: string };

type Session = {
  userId: number;
  chatId: number;
  messageId?: number;
  chatInstance?: string;
  expiresAt: number;
  selected?: number;
  revealed: boolean;
};

const invalid = (): Feedback => ({ status: "error", message: "Неверный запрос. Отправьте /learn для нового задания." });

/** One process only. Unknown/expired sessions fail closed; no client state is trusted. */
export class QuizStore {
  private sessions = new Map<string, Session>();

  constructor(private now: () => number = Date.now, private limit = MAX_SESSIONS) {}

  create(userId: number, chatId: number): string {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= this.now()) this.sessions.delete(id);
    }
    if (this.sessions.size >= this.limit) throw new Error("Quiz capacity reached.");
    const id = randomBytes(12).toString("hex");
    this.sessions.set(id, { userId, chatId, expiresAt: this.now() + SESSION_TTL_MS, revealed: false });
    return id;
  }

  bind(id: string, messageId: number): void {
    const session = this.sessions.get(id);
    if (session) session.messageId = messageId;
  }

  remove(id: string): void { this.sessions.delete(id); }

  process(query: PrivateWidgetQuery): Feedback {
    const match = /^q:([a-f0-9]{24}):(a[0-3]|r)$/.exec(query.data);
    if (!match) return invalid();
    const session = this.sessions.get(match[1]);
    if (!session || session.expiresAt <= this.now()) {
      this.sessions.delete(match[1]);
      return { status: "expired", message: "Задание истекло. Отправьте /learn и начните снова." };
    }
    if (session.userId !== query.from.id || session.chatId !== query.chat.id ||
        session.messageId !== query.message_id ||
        (session.chatInstance !== undefined && session.chatInstance !== query.chat_instance)) return invalid();
    session.chatInstance = query.chat_instance;
    // Synchronous mutation before any await: first answer wins, including concurrent
    // taps, changed choices, and retries after ambiguous answerWidgetQuery failures.
    if (match[2] === "r") session.revealed = true;
    else if (session.selected === undefined && !session.revealed) session.selected = Number(match[2][1]);
    return {
      status: session.revealed ? "revealed" : "answered",
      selected: session.selected ?? null,
      correct: session.selected === CORRECT_INDEX,
      ...(session.revealed ? { correctIndex: CORRECT_INDEX, answer: CORRECT_ANSWER } : {}),
    };
  }
}

export const quizStore = new QuizStore();

export async function sendQuiz(userId: number, chatId: number): Promise<void> {
  const id = quizStore.create(userId, chatId);
  try {
    const message = await sendWidget({
      chat_id: chatId,
      html: quizWidgetHtml(id),
      allow_queries: true,
      caption: "WordFlow · Your daily word",
    });
    if (message.chat.id !== chatId || message.chat.type !== "private" || message.message_id <= 0) {
      throw new Error("Invalid widget response.");
    }
    quizStore.bind(id, message.message_id);
  } catch {
    quizStore.remove(id);
    throw new Error("Unable to send quiz.");
  }
}

type Receipt = { fingerprint: string; expiresAt: number; delivery: Promise<void> };
const receipts = new Map<string, Receipt>();

export async function handleWidgetQuery(value: unknown): Promise<boolean> {
  if (!isRecord(value) || !isQueryId(value.id)) return false;
  const queryId = value.id;
  const now = Date.now();
  for (const [id, receipt] of receipts) {
    if (receipt.expiresAt <= now) receipts.delete(id);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const previous = receipts.get(queryId);
  if (previous) {
    // Reusing a query id with different data/context must never change the quiz.
    if (previous.fingerprint !== fingerprint) return false;
    await previous.delivery;
    return true;
  }
  if (receipts.size >= 2000) {
    await answerWidgetQuery({ widget_query_id: queryId, data: JSON.stringify(invalid()) });
    return true;
  }
  const delivery = Promise.resolve().then(async () => {
    const feedback = isPrivateWidgetQuery(value) ? quizStore.process(value) : invalid();
    await answerWidgetQuery({ widget_query_id: queryId, data: JSON.stringify(feedback) });
  });
  receipts.set(queryId, { fingerprint, expiresAt: now + 60_000, delivery });
  try {
    await delivery;
  } catch {
    // Permit delivery retry; the committed selection remains immutable.
    receipts.delete(queryId);
    throw new Error("Unable to answer widget query.");
  }
  return true;
}
