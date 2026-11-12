BEGIN;
SET LOCAL TIME ZONE 'UTC';
CREATE TYPE "SessionMode" AS ENUM ('LEARN', 'REVIEW');
CREATE TYPE "LearningState" AS ENUM ('NEW', 'LEARNING', 'REVIEW', 'MASTERED');
ALTER TABLE "StudySession" ADD COLUMN "mode" "SessionMode" NOT NULL DEFAULT 'LEARN';
-- Support a smaller session when fewer than ten new/due words are available.
-- Only the constraint changes; existing session and attempt rows are untouched.
ALTER TABLE "StudySession" DROP CONSTRAINT "StudySession_completion";
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_completion"
  CHECK ("status" <> 'COMPLETED' OR ("currentIndex" BETWEEN 1 AND 10 AND "completedAt" IS NOT NULL));
CREATE TABLE "UserWordProgress" (
  "userId" BIGINT NOT NULL,
  "wordId" UUID NOT NULL,
  "state" "LearningState" NOT NULL DEFAULT 'NEW',
  "repetitions" INTEGER NOT NULL DEFAULT 0,
  "lapses" INTEGER NOT NULL DEFAULT 0,
  "intervalMinutes" INTEGER NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMPTZ(3) NOT NULL,
  "lastReviewedAt" TIMESTAMPTZ(3) NOT NULL,
  "lastAttemptId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "UserWordProgress_pkey" PRIMARY KEY ("userId", "wordId"),
  CONSTRAINT "UserWordProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TelegramUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UserWordProgress_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UserWordProgress_lastAttemptId_fkey" FOREIGN KEY ("lastAttemptId") REFERENCES "ReviewAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UserWordProgress_nonnegative" CHECK ("repetitions" >= 0 AND "lapses" >= 0 AND "intervalMinutes" >= 0),
  CONSTRAINT "UserWordProgress_due_after_review" CHECK ("dueAt" >= "lastReviewedAt")
);
CREATE UNIQUE INDEX "UserWordProgress_lastAttemptId_key" ON "UserWordProgress"("lastAttemptId");
CREATE INDEX "UserWordProgress_userId_dueAt_idx" ON "UserWordProgress"("userId", "dueAt");
CREATE INDEX "UserWordProgress_wordId_idx" ON "UserWordProgress"("wordId");
-- Conservative bootstrap: use the last real attempt, never invent a past streak.
-- Existing ReviewAttempt, StudySession and word records are not updated.
INSERT INTO "UserWordProgress" ("userId", "wordId", "state", "repetitions", "lapses", "intervalMinutes", "dueAt", "lastReviewedAt", "lastAttemptId", "updatedAt")
SELECT "userId", "wordId",
  'LEARNING'::"LearningState",
  CASE WHEN success THEN 1 ELSE 0 END,
  CASE WHEN success THEN 0 ELSE 1 END,
  CASE WHEN success THEN 1440 ELSE 10 END,
  "createdAt" + CASE WHEN success THEN INTERVAL '1440 minutes' ELSE INTERVAL '10 minutes' END,
  "createdAt", id, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (s."userId", i."wordId") s."userId", i."wordId", a.id, a."createdAt",
    (a.correct AND a."selectedPosition" IS NOT NULL AND i."revealedAt" IS NULL) AS success
  FROM "ReviewAttempt" a JOIN "SessionItem" i ON i.id = a."sessionItemId"
  JOIN "StudySession" s ON s.id = i."sessionId"
  ORDER BY s."userId", i."wordId", a."createdAt" DESC, a.id DESC
) latest
ON CONFLICT ("userId", "wordId") DO NOTHING;
COMMIT;
