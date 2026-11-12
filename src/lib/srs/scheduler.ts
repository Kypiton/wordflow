export type LearningState = "NEW" | "LEARNING" | "REVIEW" | "MASTERED";
export type SrsProgress = {
  state: LearningState;
  repetitions: number;
  lapses: number;
  intervalMinutes: number;
  dueAt: Date;
  lastReviewedAt: Date;
};

const CORRECT_INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;

/** Pure UTC duration arithmetic. Repetitions = consecutive successful attempts. */
export function scheduleReview(
  previous: Pick<SrsProgress, "repetitions" | "lapses"> | null,
  outcome: "correct" | "incorrect" | "revealed",
  reviewedAt: Date,
): SrsProgress {
  if (!Number.isFinite(reviewedAt.getTime()) ||
      (previous && (!Number.isSafeInteger(previous.repetitions) || previous.repetitions < 0 ||
        !Number.isSafeInteger(previous.lapses) || previous.lapses < 0))) throw new Error("Invalid SRS input.");
  const correct = outcome === "correct";
  const repetitions = correct ? Math.min((previous?.repetitions ?? 0) + 1, 1_000_000) : 0;
  const lapses = (previous?.lapses ?? 0) + (correct ? 0 : 1);
  const intervalMinutes = correct ? CORRECT_INTERVAL_DAYS[Math.min(repetitions, 5) - 1] * 1440 : 10;
  return {
    state: repetitions >= 5 ? "MASTERED" : repetitions >= 2 ? "REVIEW" : "LEARNING",
    repetitions, lapses, intervalMinutes,
    dueAt: new Date(reviewedAt.getTime() + intervalMinutes * 60_000),
    lastReviewedAt: new Date(reviewedAt),
  };
}

export function isDue(dueAt: Date, databaseNow: Date): boolean {
  return dueAt.getTime() <= databaseNow.getTime();
}
