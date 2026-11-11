BEGIN;
CREATE TYPE "SessionStatus" AS ENUM ('LEGACY', 'ACTIVE', 'COMPLETED', 'EXPIRED');
-- Existing sessions remain LEGACY; no attempt or content record is rewritten.
ALTER TABLE "StudySession"
  ADD COLUMN "status" "SessionStatus" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "currentIndex" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completedAt" TIMESTAMPTZ(3),
  ADD COLUMN "syncedRevision" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN "sendToken" VARCHAR(24),
  ADD COLUMN "sendLeaseUntil" TIMESTAMPTZ(3);
ALTER TABLE "SessionItem" ADD COLUMN "optionOrder" INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3];
CREATE TABLE "LearnRequest" (
  "userId" BIGINT NOT NULL,
  "messageId" BIGINT NOT NULL,
  "sessionId" VARCHAR(24) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearnRequest_pkey" PRIMARY KEY ("userId", "messageId"),
  CONSTRAINT "LearnRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LearnRequest_sessionId_idx" ON "LearnRequest"("sessionId");
CREATE UNIQUE INDEX "StudySession_one_active_user" ON "StudySession"("userId") WHERE "status" = 'ACTIVE';
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_progress_range" CHECK ("currentIndex" BETWEEN 0 AND 10 AND "revision" >= 0);
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_completion" CHECK ("status" <> 'COMPLETED' OR ("currentIndex" = 10 AND "completedAt" IS NOT NULL));
ALTER TABLE "SessionItem" ADD CONSTRAINT "SessionItem_option_permutation" CHECK (cardinality("optionOrder") = 4 AND "optionOrder" @> ARRAY[0,1,2,3]);
COMMIT;
