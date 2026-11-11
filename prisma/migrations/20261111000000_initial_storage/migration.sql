BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "TelegramUser" (
    "id" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TelegramUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Word" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "term" VARCHAR(80) NOT NULL,
    "partOfSpeech" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Word_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WordOption" (
    "id" UUID NOT NULL,
    "wordId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" VARCHAR(80) NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WordOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudySession" (
    "id" VARCHAR(24) NOT NULL,
    "userId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" BIGINT,
    "chatInstance" VARCHAR(256),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StudySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionItem" (
    "id" UUID NOT NULL,
    "sessionId" VARCHAR(24) NOT NULL,
    "wordId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "revealedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SessionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewAttempt" (
    "id" UUID NOT NULL,
    "sessionItemId" UUID NOT NULL,
    "selectedPosition" INTEGER,
    "correct" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetQueryReceipt" (
    "id" VARCHAR(256) NOT NULL,
    "sessionId" VARCHAR(24) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetQueryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Word_slug_version_key" ON "Word"("slug", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WordOption_wordId_position_key" ON "WordOption"("wordId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "WordOption_wordId_text_key" ON "WordOption"("wordId", "text");

-- CreateIndex
CREATE INDEX "StudySession_userId_createdAt_idx" ON "StudySession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "StudySession_expiresAt_idx" ON "StudySession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudySession_chatId_messageId_key" ON "StudySession"("chatId", "messageId");

-- CreateIndex
CREATE INDEX "SessionItem_wordId_idx" ON "SessionItem"("wordId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionItem_sessionId_position_key" ON "SessionItem"("sessionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SessionItem_sessionId_wordId_key" ON "SessionItem"("sessionId", "wordId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAttempt_sessionItemId_key" ON "ReviewAttempt"("sessionItemId");

-- CreateIndex
CREATE INDEX "ReviewAttempt_createdAt_idx" ON "ReviewAttempt"("createdAt");

-- CreateIndex
CREATE INDEX "WidgetQueryReceipt_sessionId_idx" ON "WidgetQueryReceipt"("sessionId");

-- CreateIndex
CREATE INDEX "WidgetQueryReceipt_createdAt_idx" ON "WidgetQueryReceipt"("createdAt");

-- AddForeignKey
ALTER TABLE "WordOption" ADD CONSTRAINT "WordOption_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TelegramUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionItem" ADD CONSTRAINT "SessionItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionItem" ADD CONSTRAINT "SessionItem_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "Word"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAttempt" ADD CONSTRAINT "ReviewAttempt_sessionItemId_fkey" FOREIGN KEY ("sessionItemId") REFERENCES "SessionItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetQueryReceipt" ADD CONSTRAINT "WidgetQueryReceipt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Database invariants not expressible in the Prisma schema.
CREATE UNIQUE INDEX "WordOption_one_correct_per_word" ON "WordOption"("wordId") WHERE "isCorrect";
ALTER TABLE "TelegramUser" ADD CONSTRAINT "TelegramUser_positive_id" CHECK ("id" > 0);
ALTER TABLE "Word" ADD CONSTRAINT "Word_positive_version" CHECK ("version" > 0);
ALTER TABLE "WordOption" ADD CONSTRAINT "WordOption_position_range" CHECK ("position" BETWEEN 0 AND 3);
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_private_owner" CHECK ("chatId" = "userId");
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_message_positive" CHECK ("messageId" IS NULL OR "messageId" > 0);
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_token_format" CHECK ("id" ~ '^[a-f0-9]{24}$');
ALTER TABLE "SessionItem" ADD CONSTRAINT "SessionItem_position_positive" CHECK ("position" >= 0);
ALTER TABLE "ReviewAttempt" ADD CONSTRAINT "ReviewAttempt_selection_range" CHECK ("selectedPosition" IS NULL OR "selectedPosition" BETWEEN 0 AND 3);
ALTER TABLE "ReviewAttempt" ADD CONSTRAINT "ReviewAttempt_reveal_no_credit" CHECK ("selectedPosition" IS NOT NULL OR NOT "correct");

COMMIT;
