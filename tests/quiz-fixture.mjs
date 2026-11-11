import { createHash, randomBytes } from "node:crypto";
import { invalidQuiz, expiredQuiz, parseQuizAction, quizFeedback } from "../.next/telegram-tests/lib/telegram/quiz-domain.js";

export const initialContent = {
  term: "Reluctant", partOfSpeech: "adjective", options: ["Уверенный", "Любопытный", "Неохотный", "Щедрый"],
};

// Test double for webhook/UI tests only. Real PostgreSQL behavior is covered by
// database.integration.mjs; this fixture makes no claim to test DB persistence.
export class FakeQuizRepository {
  sessions = new Map();
  receipts = new Map();
  create(userId, chatId) {
    const id = randomBytes(12).toString("hex");
    this.sessions.set(id, { userId, chatId, expiresAt: Date.now() + 1800000, revealed: false });
    return { id, content: initialContent };
  }
  bind(id, messageId) { this.sessions.get(id).messageId = messageId; }
  revoke(id) { this.sessions.get(id).revoked = true; }
  delivered(id) { this.receipts.get(id).delivered = true; }
  process(query) {
    const action = parseQuizAction(query.data);
    if (!action) return { feedback: invalidQuiz() };
    const session = this.sessions.get(action.sessionId);
    if (!session || session.expiresAt <= Date.now() || session.revoked) return { feedback: expiredQuiz() };
    if (session.userId !== query.from.id || session.chatId !== query.chat.id || session.messageId !== query.message_id ||
        (session.chatInstance && session.chatInstance !== query.chat_instance)) return { feedback: invalidQuiz() };
    const fingerprint = createHash('sha256').update(JSON.stringify(query)).digest('hex');
    const prior = this.receipts.get(query.id);
    if (prior) return prior.fingerprint === fingerprint ? prior : { feedback: invalidQuiz() };
    session.chatInstance = query.chat_instance;
    session.attempt ??= { selectedPosition: action.selected, correct: action.selected === 2 };
    session.revealed ||= action.selected === null;
    const result = {
      feedback: quizFeedback(session.attempt, session.revealed, { position: 2, text: "Неохотный" }),
      receiptId: query.id, delivered: false, fingerprint,
    };
    this.receipts.set(query.id, result);
    return result;
  }
}
