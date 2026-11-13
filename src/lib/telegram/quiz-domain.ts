export type QuizContent = { term: string; partOfSpeech: string; options: string[]; kind?: "self"; example?: string };

export type SessionMode = "LEARN" | "REVIEW";

export type Feedback = ({ mode?: SessionMode; revision?: number } & (
  | { status: "answered" | "revealed"; selected: number | null; correct: boolean; correctIndex?: number; answer?: string; position?: number; total?: number; hasNext?: boolean }
  | { status: "recall"; position: number; total: number; content: QuizContent; answer: string; example?: string }
  | { status: "question"; position: number; total: number; content: QuizContent }
  | { status: "completed"; total: number; correctCount: number; incorrectCount: number; accuracy: number }
  | { status: "error" | "expired"; message: string; retryable?: boolean }));

export const invalidQuiz = (): Feedback => ({ status: "error", message: "Неверный запрос. Отправьте /learn для нового задания." });
export const expiredQuiz = (): Feedback => ({ status: "expired", message: "Задание истекло. Отправьте /learn и начните снова." });

// Legacy format remains supported for backwards compatibility with already-sent widgets.
export function parseQuizAction(data: string): { sessionId: string; selected: number | null } | null {
  const match = /^q:([a-f0-9]{24}):(a[0-3]|r)$/.exec(data);
  return match ? { sessionId: match[1], selected: match[2] === "r" ? null : Number(match[2][1]) } : null;
}

export type SessionAction =
  | { sessionId: string; kind: "answer"; position: number; selected: number }
  | { sessionId: string; kind: "reveal"; position: number }
  | { sessionId: string; kind: "rating"; position: number; remembered: boolean }
  | { sessionId: string; kind: "next"; position: number }
  | { sessionId: string; kind: "sync" };

export function parseSessionAction(data: string): SessionAction | null {
  const legacy = parseQuizAction(data);
  if (legacy) return legacy.selected === null
    ? { sessionId: legacy.sessionId, kind: "reveal", position: 0 }
    : { sessionId: legacy.sessionId, kind: "answer", position: 0, selected: legacy.selected };

  const sync = /^q:([a-f0-9]{24}):s$/.exec(data);
  if (sync) return { sessionId: sync[1], kind: "sync" };

  const match = /^q:([a-f0-9]{24}):([0-9]|[1-9][0-9]):(a[0-3]|r|n|k|f)$/.exec(data);
  if (!match) return null;
  const position = Number(match[2]);
  if (position < 0 || position > 49) return null;
  const type = match[3];
  if (type === "k" || type === "f") return { sessionId: match[1], kind: "rating", position, remembered: type === "k" };
  if (type === "n") return { sessionId: match[1], kind: "next", position };
  if (type === "r") return { sessionId: match[1], kind: "reveal", position };
  return { sessionId: match[1], kind: "answer", position, selected: Number(type[1]) };
}

export function quizFeedback(
  attempt: { selectedPosition: number | null; correct: boolean },
  revealed: boolean,
  correctOption: { position: number; text: string },
): Feedback {
  return {
    status: revealed ? "revealed" : "answered",
    selected: attempt.selectedPosition,
    correct: attempt.correct,
    ...(revealed ? { correctIndex: correctOption.position, answer: correctOption.text } : {}),
  };
}
