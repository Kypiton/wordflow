-- Task #7: additive metadata only. Existing IDs, options, progress and sessions stay intact.
BEGIN;
CREATE TYPE "CefrLevel" AS ENUM ('A1', 'A2', 'B1', 'B2', 'C1');
ALTER TABLE "Word" ADD COLUMN "cefrLevel" "CefrLevel";
ALTER TABLE "TelegramUser" ADD COLUMN "cefrLevel" "CefrLevel";
ALTER TABLE "StudySession" ADD COLUMN "cefrLevel" "CefrLevel";
-- Existing shared words remain eligible when a level is selected before seeding.
UPDATE "Word" SET "cefrLevel" = 'B2' WHERE "personalWordId" IS NULL AND "cefrLevel" IS NULL;
CREATE INDEX "Word_cefrLevel_isCurrent_idx" ON "Word"("cefrLevel", "isCurrent") WHERE "personalWordId" IS NULL;
COMMIT;
