BEGIN;
CREATE TYPE "VocabularyMode" AS ENUM ('GENERAL', 'PERSONAL', 'MIXED');
ALTER TABLE "TelegramUser" ADD COLUMN "vocabularyMode" "VocabularyMode" NOT NULL DEFAULT 'GENERAL',
 ADD COLUMN "vocabularyWindowAt" TIMESTAMPTZ(3), ADD COLUMN "vocabularyRequestCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StudySession" ADD COLUMN "vocabularyMode" "VocabularyMode" NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "ReviewAttempt" ADD COLUMN "selfRating" BOOLEAN;
ALTER TABLE "ReviewAttempt" DROP CONSTRAINT "ReviewAttempt_reveal_no_credit";
ALTER TABLE "ReviewAttempt" ADD CONSTRAINT "ReviewAttempt_reveal_no_credit" CHECK (
 ("selfRating" IS NULL AND ("selectedPosition" IS NOT NULL OR NOT "correct")) OR
 ("selfRating" IS NOT NULL AND "selectedPosition" IS NULL AND "correct" = "selfRating")
);
CREATE TABLE "PersonalWord" (
 "id" UUID NOT NULL PRIMARY KEY, "ownerId" BIGINT NOT NULL, "termKey" VARCHAR(80) NOT NULL,
 "archivedAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "PersonalWord_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "TelegramUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PersonalWord_ownerId_termKey_key" ON "PersonalWord"("ownerId", "termKey");
CREATE INDEX "PersonalWord_ownerId_archivedAt_createdAt_idx" ON "PersonalWord"("ownerId", "archivedAt", "createdAt");
ALTER TABLE "Word" ADD COLUMN "personalWordId" UUID, ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true,
 ADD COLUMN "translation" VARCHAR(120), ADD COLUMN "example" VARCHAR(160),
 ADD CONSTRAINT "Word_personalWordId_fkey" FOREIGN KEY ("personalWordId") REFERENCES "PersonalWord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 ADD CONSTRAINT "Word_personal_translation" CHECK ("personalWordId" IS NULL OR length("translation") > 0 AND "translation" IS NOT NULL);
CREATE INDEX "Word_personalWordId_isCurrent_idx" ON "Word"("personalWordId", "isCurrent");
CREATE UNIQUE INDEX "Word_current_personal_version" ON "Word"("personalWordId") WHERE "personalWordId" IS NOT NULL AND "isCurrent";
CREATE TABLE "VocabularyDraft" (
 "userId" BIGINT NOT NULL PRIMARY KEY, "token" VARCHAR(24) NOT NULL, "data" JSONB NOT NULL, "promptMessageId" BIGINT,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "VocabularyDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TelegramUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VocabularyDraft_token_key" ON "VocabularyDraft"("token");
CREATE TABLE "VocabularyReceipt" (
 "userId" BIGINT NOT NULL, "messageId" BIGINT NOT NULL, "fingerprint" CHAR(64) NOT NULL, "response" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "VocabularyReceipt_pkey" PRIMARY KEY ("userId", "messageId"),
 CONSTRAINT "VocabularyReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TelegramUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
COMMIT;
