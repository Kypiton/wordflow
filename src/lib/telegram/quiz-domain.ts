export type QuizContent = { term: string; partOfSpeech: string; options: string[] };
export type Feedback = {
  status: "answered" | "revealed";
  selected: number | null;
  correct: boolean;
  correctIndex?: number;
  answer?: string;
} | { status: "error" | "expired"; message: string; retryable?: boolean };

export const invalidQuiz = (): Feedback => ({ status: "error", message: "Неверный запрос. Отправьте /learn для нового задания." });
export const expiredQuiz = (): Feedback => ({ status: "expired", message: "Задание истекло. Отправьте /learn и начните снова." });

export function parseQuizAction(data: string): { sessionId: string; selected: number | null } | null {
  const match = /^q:([a-f0-9]{24}):(a[0-3]|r)$/.exec(data);
  return match ? { sessionId: match[1], selected: match[2] === "r" ? null : Number(match[2][1]) } : null;
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
