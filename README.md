# WordFlow

Telegram-first English vocabulary practice using Next.js App Router, TypeScript, Bot API 10.4 HTML widgets, and PostgreSQL/Prisma. `/start` welcomes the learner; `/learn` sends the lavender **Reluctant** quiz. Answers and reveals stay inside the widget. The correct translation is **Неохотный**.

## First setup — a database must be provisioned

**No PostgreSQL database is bundled or provisioned. No migration or seed has been applied to a database.** Code generation and unit tests work offline; `/learn` requires the database and seed below. `/start` does not access the database.

1. Use **Node.js 24.x**, matching `package.json` and Vercel's Node runtime. Prisma CLI, client, and PostgreSQL adapter are pinned together at **7.10.1**; `pg` is **8.23.1**. PostgreSQL **16 or newer** is recommended for a new database.
2. Provision PostgreSQL with your chosen provider (for example, a Vercel-connected PostgreSQL service). Choose a region near the Vercel function. Obtain the provider-issued connection strings; do not use the placeholder credentials below.
3. Install dependencies and prepare local configuration:

   ```bash
   npm install
   cp -n .env.example .env.local
   ```

   Preserve an existing `.env.local`. Set:

   - `DATABASE_URL`: provider-issued PostgreSQL URL. Use the provider's pooled endpoint for Vercel/serverless traffic, with its required TLS parameters.
   - `DIRECT_URL`: optional provider-issued direct connection for migration/seed administration when the runtime URL uses a pooler. Otherwise leave empty; commands use `DATABASE_URL`.
   - `TELEGRAM_BOT_TOKEN`: the bot token from [@BotFather](https://t.me/BotFather).
   - `TELEGRAM_WEBHOOK_SECRET`: generate with `openssl rand -hex 32`; use the same value on the app and webhook registration.
   - `TELEGRAM_WEBHOOK_URL`: public HTTPS URL ending in `/api/telegram/webhook`.

   `.env.local` remains ignored by Git. Never use `NEXT_PUBLIC_` for these values. Prisma CLI loads `.env.local` without overwriting exported shell variables. Next.js loads it normally; no new dotenv package is needed.

4. After configuring the real database URL, apply the reviewed, additive initial migration and seed:

   ```bash
   npm run db:generate
   npm run db:validate
   npm run db:migrate
   npm run db:seed
   ```

   `db:migrate` runs **`prisma migrate deploy`**, applying committed migrations only. It does not reset a database. The initial SQL creates tables, constraints, and indexes; inspect `prisma/migrations/20261111000000_initial_storage/migration.sql` before applying it to an existing database. Use a fresh application database/schema to avoid table-name collisions. Do not use `migrate reset` or `db push` against production.

   `db:seed` compiles and runs an explicit idempotent seed. It creates `reluctant` version 1 and its four options once. Reruns preserve their IDs and content and never modify user progress. Generation, install, builds, and application startup do **not** migrate or seed.

5. Run locally with `npm run dev`. For Telegram delivery use a public HTTPS tunnel or a deployed endpoint, then run:

   ```bash
   npm run telegram:webhook
   ```

   Registration enables `message` and `widget_query`, preserves pending updates, and rejects local/IP URLs. It changes the bot's webhook, so use a separate development bot if production must keep receiving updates. In a compatible Telegram client, send `/start`, then `/learn` in a private chat.

## Vercel deployment

1. Select **Node.js 24.x** in Project Settings. Keep the webhook on the Node.js runtime; it is not an Edge function.
2. Add `DATABASE_URL`, the bot token, webhook secret, and public webhook URL to Vercel's **Production** environment. Use a connection pooler compatible with PostgreSQL transactions. `DIRECT_URL` is needed only where administrative commands run, not by the webhook.
3. Give Preview deployments their **own database and bot**; do not point them at production credentials. Vercel environment variables are available without `.env.local`.
4. From a trusted machine/CI with the target database's credentials, run `npm run db:migrate` and `npm run db:seed` explicitly before enabling the deployment. Keep these commands outside the automatic Vercel build to prevent previews from changing a production database.
5. Deploy with the default `npm run build`. `postinstall` and the build regenerate Prisma Client, including when Vercel caches dependencies. Generation does not require a live database. If using a custom install command, retain dev dependencies so the pinned Prisma CLI is available during build.
6. Register the public webhook again with `npm run telegram:webhook`, then perform the manual smoke test below. Ensure `/api/telegram/webhook` is publicly reachable without a deployment login.

Each warm function caches only a lazy Prisma client/connection pool (maximum two connections, short connection/query timeouts). **All quiz state is in PostgreSQL**, so sessions survive cold starts and deploys and can be handled by different Vercel instances. Do not disconnect Prisma after every request. Use provider pooling and monitor connection capacity as traffic grows. See [Prisma's Vercel guide](https://www.prisma.io/docs/orm/v7/prisma-client/deployment/serverless/deploy-to-vercel).

## Data and session lifecycle

The normalized schema contains:

| Model | Purpose and constraints |
| --- | --- |
| `TelegramUser` | Telegram numeric ID stored as PostgreSQL `BIGINT`; owns sessions. |
| `Word` | Immutable published word version, unique `(slug, version)`. |
| `WordOption` | Four ordered translations, unique word/position and word/text; a partial unique SQL index allows at most one correct option. Creation checks require exactly four options and one correct answer. |
| `StudySession` | Random 24-character token; owner, private chat, widget message and chat-instance binding; expiration, revocation, and timestamps. Unique chat/message; owner/date and expiration indexes. |
| `SessionItem` | Ordered session-to-word relation, unique session/position and session/word; reveal timestamp. |
| `ReviewAttempt` | Immutable first selection, or null selection for reveal-first. **Unique session item** guarantees at most one recorded outcome. `correct` records the outcome; reveal-first cannot award credit. |
| `WidgetQueryReceipt` | Unique Telegram query ID, canonical request fingerprint, stored result, and delivery timestamp. Enables retry/replay handling across instances. |

`/learn` creates the user if needed, a 30-minute session, and its first item in one transaction, then sends the real HTML widget with `allow_queries: true`. The returned Telegram message ID activates the session. A send/bind failure triggers best-effort revocation; an unbound card cannot accept answers. There is no external transaction covering Telegram and PostgreSQL: an ambiguous send can leave an unusable card, and duplicate `/learn` updates can create separate sessions. Send `/learn` again in that case.

Widget queries still require the secret header and a private, non-bot Telegram sender. The repository independently validates input, then checks owner, chat, message, chat instance, expiry using database time, and revocation. Unknown Task #2 in-memory cards cannot be recovered; send `/learn` after upgrading.

A short **READ COMMITTED transaction locks the session row with `SELECT … FOR UPDATE`**. It creates the attempt (only if absent), marks reveal state, and stores the query receipt atomically. Concurrent answers and reveal/answer races serialize across instances; the unique attempt constraint is a second safeguard. Different answer choices return the original result. Reusing a query ID with changed context/data is rejected. Progress is derived from review attempts, with no separate incrementing counter that can be awarded twice.

The database transaction commits **before** `answerWidgetQuery`. If Telegram delivery fails, replay uses the saved result without grading again. Delivery marking is best effort: simultaneous delivery or a crash can resend an API answer, but cannot insert another attempt. Expired/revoked sessions remain in the database for history and reject further grading; no destructive cleanup job runs automatically.

The API uses a five-second answer timeout; database transactions have a one-second acquisition/lock budget and a 3.5-second execution timeout. Webhook body reading is capped at two seconds/64 KiB. Database outages return a safe retryable message within the widget when Telegram is reachable. Cold starts, network outages, or late webhook delivery can still exceed Telegram's 15-second deadline; monitor latency in production.

The lavender HTML, synchronous click requests, selected-answer feedback, and reveal UI are preserved. Public word text comes from PostgreSQL and is HTML-escaped; answer flags, credentials, and grading logic never enter the widget. Published words should not be edited in place: create a new version for changed content. The models support multiple session items/words; current `/learn` intentionally selects `reluctant` version 1 and displays one item.

## Verification

Offline checks (no database credentials required):

```bash
npm run db:generate
npm run db:validate
npm run test:telegram
npm run lint
npm run typecheck
npm run build
```

The 31 Telegram/unit tests pass using fake credentials, mocked Telegram fetch calls, and an explicit repository test double. They test `/start`, `/learn`, UI behavior, byte/compression limits, input validation, safe database/API errors, delivery retries, and escaping. Prisma generation/schema validation, lint, and TypeScript checks also pass. **These tests do not establish real PostgreSQL concurrency or persistence.**

### Opt-in PostgreSQL integration suite

1. Provision a **dedicated disposable test database**, separate from production, and apply the same committed migration to it. For example, in a shell where `TEST_DATABASE_URL` holds that provider-issued URL:

   ```bash
   DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" npm run db:migrate
   ```

2. Set `TEST_DATABASE_URL` in `.env.local` or export it, then explicitly enable writes:

   ```bash
   WORDFLOW_DB_TESTS=1 npm run test:db
   ```

   The test runner never falls back to `DATABASE_URL`, never provisions/resets/migrates a database, and skips without both the test URL and opt-in flag. It creates the idempotent seed and random test-owned user/session records, then deletes only records belonging to that test user. The shared seed is retained.

   Tests exercise separate/fresh clients, persistence, concurrent duplicates, authorization, expiry, revocation, unbound cards, reveal semantics, receipt conflicts, unique constraints, and rollback after an injected write failure. Database integration remains **unverified until this suite runs against your provisioned database**.

Manual Telegram smoke test: `/start`; `/learn`; choose a wrong answer and reveal; create another quiz and choose “Неохотный”; tap repeatedly; redeploy/restart and answer a still-active card. Confirm the same stored outcome and at most one `ReviewAttempt` per item. Live Telegram delivery is not part of mocked tests.

### Build environment limitation

Task #3 reproduced the existing local restriction while Turbopack compiled the starter CSS: `binding to a port: Operation not permitted`, both normally and after a permission retry. Prisma generation completes; a generated-client import-resolution issue found during validation was fixed in the generator configuration. The production build still requires Vercel or a host permitting Turbopack worker ports. No build configuration workaround or database migration is hidden in the build command.

## Files

- `prisma/schema.prisma`, `prisma/migrations/`: models and reviewed initial SQL.
- `prisma.config.ts`, `prisma/seed.ts`, `tsconfig.database.json`: configuration and explicit seed/tool compilation.
- `src/lib/db/prisma.ts`, `quiz-repository.ts`: lazy connections and atomic storage.
- `src/lib/telegram/quiz-domain.ts`, `quiz.ts`, `quiz-widget.ts`: validation/feedback, orchestration, and the widget presentation.
- `src/app/api/telegram/webhook/route.ts`: existing Node.js webhook; `/start` stays independent of database availability.
- `tests/widget.test.mjs`, `quiz-fixture.mjs`, `database-unit.test.mjs`, `database.integration.mjs`: UI/webhook tests, database boundary checks, and opt-in real-database verification.
