import "server-only";

import { answerWidgetQuery, sendWidget, sendMessage } from "./client";
import { quizWidgetHtml } from "./quiz-widget";
import { isPrivateWidgetQuery, isQueryId, isRecord } from "./types";
import { PrismaQuizRepository } from "../db/quiz-repository";
import type { SessionMode } from "./quiz-domain";
import { invalidQuiz } from "./quiz-domain";
import type { QueryResult, QuizRepository } from "../db/quiz-repository";

// The repository is stateless. Only the database holds sessions and receipts.
export const quizStore: QuizRepository = new PrismaQuizRepository();

export async function sendQuiz(userId: number, chatId: number, mode: SessionMode = "LEARN", requestId?: number): Promise<void> {
  const start = await quizStore.create(userId, chatId, mode, requestId);
  if (start.kind === "message") {
    await sendMessage({ chat_id: chatId, text: start.message });
    return;
  }
  const { id, content } = start;
  try {
    const message = await sendWidget({
      chat_id: chatId, html: quizWidgetHtml(id, content, { mode: start.mode ?? mode, total: start.total ?? 10, position: start.position ?? 0 }), allow_queries: true, protect_content: true,
      caption: start.notice ?? `WordFlow · ${start.mode ?? mode}`,
    });
    if (message.chat.id !== chatId || message.chat.type !== "private" || message.message_id <= 0) {
      throw new Error("Invalid widget response.");
    }
    await quizStore.bind(id, message.message_id, start.sendToken);
  } catch {
    // A sent-but-unbound card can never accept answers. Revocation is best effort.
    try { await quizStore.revoke(id, start.sendToken); } catch { /* Fail closed on unbound sessions. */ }
    throw new Error("Unable to send quiz.");
  }
}

export async function handleWidgetQuery(value: unknown): Promise<boolean> {
  if (!isRecord(value) || !isQueryId(value.id)) return false;
  let result: QueryResult = { feedback: invalidQuiz() };
  if (isPrivateWidgetQuery(value)) {
    try {
      result = await quizStore.process(value);
    } catch {
      // Still answer within the deadline; do not expose DB errors or credentials.
      result = { feedback: { status: "error", retryable: true, message: "Не удалось проверить. Нажмите ещё раз." } };
    }
  }
  if (result.delivered) return true;
  await answerWidgetQuery({ widget_query_id: value.id, data: JSON.stringify(result.feedback) });
  if (result.receiptId) {
    // Delivery acknowledgement is separate from grading. An ambiguous API failure
    // can resend the same result but can never insert another review attempt.
    try { await quizStore.delivered(result.receiptId); } catch { /* Safe to redeliver. */ }
  }
  return true;
}
