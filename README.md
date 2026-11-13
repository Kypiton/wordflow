# WordFlow

Telegram-first English vocabulary practice with Next.js App Router, TypeScript, PostgreSQL/Prisma 7, and Telegram Bot API HTML widgets. `/start` welcomes learners, `/learn` introduces new words, and `/review` practices words scheduled by a simple personalized SRS. Answers, reveals, navigation, and completion stay in the lavender widget.

## Menu-driven Telegram navigation (Task #6.1)

`/start` and `/menu` show a persistent Russian reply keyboard: **📚 Учить слова**, **🔁 Повторить**, **📖 Мой словарь**, **➕ Добавить слово**, **⚙️ Настройки**. `/help` explains the app in Russian. The reply keyboard keeps the menu accessible on mobile and desktop; inline keyboards handle actions tied to a particular message. Clients may let users collapse the keyboard; `/menu` opens it again.

- **Add:** tap Добавить слово → reply to the English-word prompt → reply to the Russian-translation prompt → tap **Сохранить** or **Отмена**. Replies must reference the current bot prompt, so unrelated conversation is ignored. `/add overwhelmed — перегруженный` skips directly to the same button confirmation. No token copying is needed. Saved words offer Add another, Learn my words, and My dictionary.
- **Learn:** tap Учить слова and select **Общий словарь**, **Мои слова**, or **Все слова**. The choice is saved and learning starts. Settings changes the same preference without starting a session. An existing session is resumed without replacing its word list; the chosen preference applies to the next session. Learn my words saves PERSONAL through the same transaction and session rules.
- **Dictionary:** open a five-entry page, select a word, then edit its translation/example/part of speech or explicitly confirm archive/restore. Edits and archive/restore return to the appropriate list. Ordering is stable by creation time and ID; edits do not reorder words. Pages are live: additions/archiving can change page contents, but buttons reference immutable collection IDs and are always owner-checked, never positional word numbers.
- **Personal cards:** Показать перевод → **Вспомнил / Не вспомнил**. Reveal alone still gives no credit. Completion and empty states point back to navigation; scheduling is unchanged.

Callback payloads use a bounded `v1:` format (at most 64 bytes), opaque IDs/tokens, and no vocabulary text. Every valid callback is acknowledged with `answerCallbackQuery` before database work. Confirmation requires the current draft, unexpired token, private owner and bound Telegram message. Edited/deleted/inaccessible/shared/forwarded contexts fail safely. Navigation normally edits its source message; guided input uses a protected ForceReply prompt.

No schema migration is required. Existing `VocabularyReceipt` rows store callback results in a **negative message-ID namespace**, derived from a 60-bit callback-ID hash; positive IDs remain ordinary Telegram messages. The fingerprint includes the full callback ID, data and source message, so hash collisions fail closed. Delivery IDs suppress completed webhook retries. Duplicate concurrent saves serialize under the existing user lock; mutation and receipt commit together. Learning callbacks use a separate high positive command-ID range with the existing quiz send lease. A crash between Telegram delivery and recording delivery may still duplicate a guided prompt; it cannot duplicate a saved word or study credit. The existing 20-management-actions/minute limit includes navigation.

Run `npm run telegram:webhook` **manually** after deploying: it now subscribes to `callback_query` as well as messages/widgets, and registers Russian command descriptions using `setMyCommands`. It preserves pending updates. This changes the selected bot's webhook and command menu; use a separate development bot for testing. No registration or deployment runs automatically.

## Personal vocabulary

All management commands work only in the private chat with WordFlow. No translation service or fabricated distractors are used.

| Command | Example / behavior |
| --- | --- |
| `/add word` | `/add overwhelmed` asks for a Russian translation. Reply **to that bot prompt**, or send `/translation подавленный`. Unsolicited chat messages are ignored. |
| `/add word — перевод` | `/add overwhelmed — подавленный` opens a confirmation immediately. A spaced en/em dash or ` - ` separates the fields. |
| Save / Cancel buttons | Tap the inline confirmation. Drafts expire after 10 minutes; starting another add/edit replaces the previous draft. Nothing is saved before confirmation. `/cancel` also cancels a guided draft. |
| `/mywords` | Five active words per page, total collection size, translation, optional part of speech, and current-version SRS state. `/mywords 2` opens page 2; `/mywords archived 1` browses the archive. |
| `/edit word` | Requests a new translation; `/edit overwhelmed — перегруженный` also works. Confirmation is required. |
| `/pos word — value` | `/pos overwhelmed — adjective`; `-` clears the optional field. Confirm before saving. |
| `/example word — sentence` | `/example overwhelmed — I felt overwhelmed.`; `-` clears the example. Confirm before saving. |
| `/delete word` | Confirms **archiving**, never deletes study history. |
| `/restore word` | Confirms restoration of an archived entry, retaining its SRS history. |
| `/mode` | Shows the current vocabulary preference and commands for changing it. |

Terms are normalized with Unicode NFKC, collapsed whitespace, normalized apostrophes and case-insensitive duplicate keys. English multi-word expressions and common punctuation are accepted. Russian translations require Cyrillic text. Limits: term 80 characters, translation 120, part of speech 40, example 160; serialized UTF-8 limits also keep widget responses below 1 KiB. Invisible formatting/control characters are rejected. Each user can own up to 500 entries including archived ones, and can perform 20 management actions per database-timed minute. Exact webhook retries replay without consuming that limit. Names are unique **within a user's collection**; two users can independently add the same word.

Management messages use Telegram `protect_content`, plain text (no parse mode), and private sender checks. Pagination uses authenticated commands, not public links or shared widgets. Ordinary replies are accepted only for the currently bound translation prompt. Expired or superseded confirmation codes cannot mutate the dictionary. Fingerprinted message receipts and user-row locking make confirmations and edits idempotent; older previously unseen management messages are rejected. Replies may be redelivered after an ambiguous Telegram API failure, but mutations are not repeated. Failed prompt binding can be recovered using `/translation`.

### Vocabulary modes

- **GENERAL** (default): shared built-in vocabulary, preserving existing behavior.
- **PERSONAL**: only the owner's active current personal word versions.
- **MIXED**: shared vocabulary plus the owner's active personal versions. If eligible entries have the same normalized English term, the personal entry wins; a term never appears twice in one session.

Use `/mode PERSONAL`, `/mode GENERAL`, or `/mode MIXED`. The preference is persisted, and each new session stores its chosen vocabulary mode. Changing mode never deletes progress or replaces an active session; finish or let that session expire first. `/learn` stays new-only and `/review` stays due-only within the selected vocabulary. Sessions contain at most ten words, with clear shorter/empty-session messages.

### Personal self-review

The same lavender widget supports both built-in multiple choice and personal recall cards, including mixed sessions. A recall card shows the English term and optional part of speech without embedding the translation in initial HTML. Try recalling it, then select **Показать перевод**. The server records the reveal and returns the translation and optional example. Only then can **Вспомнил** or **Не вспомнил** be submitted. Self-ratings before reveal and multiple-choice actions against a recall card are rejected.

Reveal alone does not complete a personal attempt or award SRS credit. **Вспомнил** records a successful self-rated attempt and uses the normal correct-answer intervals; **Не вспомнил** records a lapse due in ten minutes. Abandoning a revealed card records no attempt; resume restores its revealed state until expiry. The explicit self-rating is stored separately from a multiple-choice selection. User ownership, reveal state, attempt uniqueness, scheduling, receipts and session advancement are checked/committed in the same transaction. Self-review necessarily relies on honest recall reporting; it is not an objectively graded translation test. Ordinary multiple-choice Reveal retains its previous unsuccessful-attempt behavior.

### Immutable edits and history

`PersonalWord` owns the normalized key and archive state. Its `Word` rows are immutable content versions; only one can be current. Personal words have a translation and no `WordOption` distractors. Each confirmed edit (including example/part-of-speech changes) creates a new version. Existing sessions continue with their original version, translation, and SRS history; the new version starts NEW. This deliberately avoids silently carrying mastery to changed content. Archive/restore only changes eligibility for **future** sessions; an existing bound session can still finish its snapshot. Restoration re-enables the current version's existing SRS schedule.

## Task #7 — Expanded CEFR vocabulary (303 entries)

**What is included.** The shared catalog now contains **303 distinct English entries**: 250 new curated entries (50 each in approximate A1, A2, B1, B2, C1 bands), the existing 50-word editorial list, and 3 original seed words not in that list. Each entry has an English term, part of speech, one selected Russian meaning, and an original English usage sentence. New shared multiple-choice questions have four fixed choices, one correct and three distinct same-part-of-speech distractors. The existing ten published cards, their word IDs and correct/incorrect options are preserved. These are teaching-level labels, **not official per-word CEFR certifications**; some words span multiple levels or senses.

**Commands and buttons.** Open **⚙️ Настройки → 🎯 Уровень английского**, or send `/level`, and select **Все уровни / A1 / A2 / B1 / B2 / C1**. `/level B1` and `/level ALL` also work. The persisted level applies to the **shared part** of future `/learn` and `/review` sessions. GENERAL selects only shared words of that level, PERSONAL ignores the CEFR preference (private user entries are not assigned a level), and MIXED combines all private words with level-filtered shared words. Existing sessions preserve the stored level snapshot and are never changed in place by settings. Default: **Все уровни**, matching old behavior. English examples appear underneath shared vocabulary terms inside the lavender quiz widget; personal recall examples still appear only after Reveal.

**Database migration.** `20261114000000_cefr_vocabulary` adds nullable `CefrLevel` metadata to `Word`, `TelegramUser`, and `StudySession`, and an index for shared-word selection. Existing shared words are temporarily marked B2 to remain available with a filter before the expanded seed runs. No table/column drops and no changes to prior options, progress, attempts or sessions. Shared seed later assigns the chosen level to the ten originals. There is no automatic deployment, schema push, webhook change, or production data access in the source package.

**Seed behavior.** `npm run db:seed` now invokes `seedExpandedVocabulary` through the existing guarded-by-config database script, **but its database target is controlled by `DIRECT_URL` / `DATABASE_URL`**. The seed is additive and repeatable: new rows use a unique `slug/version` and `createMany(... skipDuplicates)`, options are inserted only for previously optionless entries, and historical quiz choices are never overwritten. The old `seedInitialWord(db)` remains available for legacy test fixtures. If a shared word already has a partial set of answer choices, the expanded seed fails closed rather than changing them. Running a migration alone **does not import the 303 words** — run the seed as a separate, intentional action.

**Safe deployment order:**

1. Back up the current production Neon branch. Do not include `.env*` secrets in the source archive.
2. Use Node 24, run `npm ci` (or `npm install`) and `npm run db:generate`, `npm run typecheck`, `npm run lint`, `npm run test:telegram`, and `npx next build --webpack` locally.
3. On the dedicated allowlisted `ep-nameless-hall` Neon **test branch**, run `WORDFLOW_DB_TESTS=1 npm run db:test:migrate` and `WORDFLOW_DB_TESTS=1 npm run test:db`. The Task #7 integration suite runs after legacy suites and validates the expanded seed and level selection without using a production connection. Expect the expanded seed to add rows to the test branch, persisting across runs.
4. Review migration SQL and `prisma/seed.ts`. With **explicitly selected production database credentials** and webhook delivery safely paused/drained, apply `npm run db:migrate`, then `npm run db:seed` (verify connection target before either command). Never run `migrate reset` or `db push` against production.
5. Deploy the reviewed app through the normal GitHub/Vercel release process, resume Telegram webhook, check `/start`, `/level`, GENERAL/PERSONAL/MIXED `/learn`, `/review` and previously issued quiz widgets. Keep the new nullable columns and seeded rows when rolling back the app. Prefer a forward fix rather than dropping schema used by active sessions.

**Limitations:** No generated pronunciation audio/IPA (requires a vetted pronunciation dataset/service and separate UX work). No claim of formal CEFR accreditation or infallible disambiguation of every translation. Existing old widgets do not retroactively gain example sentences. Multi-sense words may need editorial refinement based on learner feedback.

## Commands and sessions

- `/learn`: selects up to 10 distinct words the user has never answered or revealed. Due reviews are **not** mixed in. New word order is randomized and stored in PostgreSQL.
- `/review`: selects up to 10 distinct words with `dueAt <=` current database time, oldest due first. If none are due, the bot says there are currently no scheduled reviews; it does not claim the user has no learned words.
- Fewer than 10 available words produce a shorter session with an explicit caption and accurate counters. Exhausted new vocabulary produces a friendly `/review` suggestion.
- One active session per user. Repeating either command while a bound session exists sends instructions to use **«Продолжить занятие»** in its existing widget. It does not send a second widget or change the mode. A cross-mode command asks the user to finish the active LEARN/REVIEW session first. The widget labels learning and review in Russian.
- Sessions expire after 30 minutes, without extending expiry on resume. Completed or expired sessions allow a new session. Previously recorded answers and SRS progress are retained.
- For built-in multiple choice, revealing consumes that question as an unsuccessful attempt. After answering, the correct option is shown; Next advances to the first unanswered question. Completion shows correct/incorrect totals and rounded accuracy for the actual session size.

## SRS algorithm

Scheduling is a pure function in `src/lib/srs/scheduler.ts`. `repetitions` means consecutive correct genuine attempts, not a user streak or XP. `lapses` counts incorrect/reveal attempts, including the first attempt. Times use the PostgreSQL clock and UTC elapsed durations; a day is exactly 1,440 minutes, including across DST changes.

| Outcome | Consecutive correct count | Next review | State |
| --- | --- | --- | --- |
| Incorrect or revealed | Reset to 0 | 10 minutes | LEARNING |
| First correct | 1 | 1 day | LEARNING |
| Second correct | 2 | 3 days | REVIEW |
| Third correct | 3 | 7 days | REVIEW |
| Fourth correct | 4 | 14 days | REVIEW |
| Fifth and later correct | 5+ | 30 days | MASTERED |

Correct attempts preserve the lapse count. MASTERED words continue to be scheduled every 30 days; no progressively longer intervals or ease score are used. The defensive repetition counter cap is 1,000,000. NEW is represented by absence of a progress row until a genuine attempt is committed.

## Database model and compatibility

`TelegramUser`, immutable/versioned `Word`, `WordOption`, `StudySession`, `SessionItem`, `ReviewAttempt`, `WidgetQueryReceipt`, and `LearnRequest` remain in place. The original ten-word seed remains available for legacy integration fixtures; the runtime seed now expands the shared catalog to 303 entries (Task #7). The existing 50-word list in `prisma/vocabulary.ts` is now used by the expanded seed. Rerunning it preserves existing IDs, content, attempts, and progress. Published words should not be edited in place.

Migration **`20261112000000_spaced_repetition`** adds:

- `StudySession.mode` (LEARN/REVIEW), default LEARN for existing sessions.
- `UserWordProgress`: composite primary key `(userId, wordId)`, state, repetitions, lapses, interval in minutes, due/review timestamps, timestamps, and a unique reference to the latest `ReviewAttempt`.
- An index on `(userId, dueAt)` for due selection, word index, foreign keys, and nonnegative/time-order constraints.
- A relaxed completion check permitting 1–10 questions. Existing rows are not rewritten.

**Historical backfill decision:** the migration bootstraps one progress row from the latest historical attempt per user/word. A correct, non-revealed selection starts at repetition 1 and is due one day after that attempt. Incorrect/revealed attempts start at repetition 0, lapse 1, due ten minutes after that attempt. This deliberately does not infer a historical streak or lifetime lapse count. Old overdue attempts remain due immediately. The migration never updates or deletes existing `ReviewAttempt`, `SessionItem`, word, or session records. Existing unexpired LEGACY widgets and action formats remain usable; legacy sessions default to LEARN. Historical receipts replay without scheduling again. Legacy typed confirmations remain accepted for compatibility, but are not advertised in the new UI.

### Atomicity and delivery

A transaction locks the Telegram user row, then the session row, checks sender/chat/message/chat-instance ownership, expiry and question order, inserts one immutable attempt, updates SRS, advances session index/revision/status, and saves the query receipt. The unique session-item attempt, progress key and active-session index provide additional safeguards. User locking also serializes progress from multiple pre-existing LEGACY sessions. PostgreSQL holds all learning state; process memory only caches connections.

Repeated query IDs with the same fingerprint replay the stored result; changed fingerprints are rejected. Different query IDs for an answered question cannot insert another attempt or reschedule it. A failure in any write rolls back both grading and SRS. Next/sync actions never update SRS. A delayed lower-revision widget response is ignored.

The transaction commits before Telegram delivery. Delivery failure can replay feedback without changing learning progress. `LearnRequest` deduplicates commands by user/message ID; a 30-second send lease prevents concurrent widget sends. A failed old sender cannot revoke a newer sender's session. Telegram and PostgreSQL cannot share a transaction: an ambiguous send/bind failure can leave an unusable card. Retrying the command recovers an unbound session after its lease expires, or creates a replacement if revoked. Repeated informational command replies are harmless.

### Task #6 migration and rollback

`20261113000000_personal_vocabulary` adds `VocabularyMode` preferences/session snapshots, `PersonalWord`, `VocabularyDraft`, `VocabularyReceipt`, optional personal content/version fields on `Word`, and `ReviewAttempt.selfRating`. It adds ownership/uniqueness indexes and restrictive foreign keys. The old reveal constraint is extended only for explicitly marked self-ratings; historical null selections still cannot be correct. Existing words remain shared, existing users/sessions default to GENERAL, and existing attempt/content/SRS rows are not rewritten. No vocabulary backfill is needed.

Apply the committed migration on the dedicated test branch before production. During deployment, drain old webhook invocations and migrate before switching to the new application. Old fixed-HTML widgets remain usable for their original multiple-choice sessions; newly sent widgets support both card types. Do not drop the new tables or reverse the migration to roll back: they may contain real private content and progress. If reverting the application, stop personal-word interactions first; older code cannot serve recall cards or management commands. Preserve the schema/data and deploy a forward fix or a compatible application version. Take a backup before production changes.

## Local setup

Use Node.js **24.x**, matching Vercel. Prisma CLI/client/adapter are pinned together at 7.10.1. Obtain actual provider-issued PostgreSQL credentials; no database is provisioned by the app.

```bash
npm install
cp -n .env.example .env.local
```

Preserve existing `.env.local`. Configure:

- `DATABASE_URL`: Neon pooled runtime URL with provider-required TLS settings.
- `DIRECT_URL`: optional direct administrative URL for migrations/seed; otherwise commands use `DATABASE_URL`.
- `TELEGRAM_BOT_TOKEN`: token from BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: generate with `openssl rand -hex 32`.
- `TELEGRAM_WEBHOOK_URL`: public HTTPS endpoint ending in `/api/telegram/webhook`.

Secrets must never use `NEXT_PUBLIC_`. Local environment files remain ignored. Prisma config loads `.env.local` without replacing exported variables. The webhook uses a timing-safe secret comparison and safe error messages.

Review committed SQL before applying it to your intended database:

```bash
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:seed
npm run dev
```

`db:migrate` is `prisma migrate deploy`; it only applies committed migrations. Never use `db push` or `migrate reset` in production. Install, builds, and startup do **not** migrate or seed. `/start` works independently of the database.

With a development bot and a public HTTPS tunnel/deployment:

```bash
npm run telegram:webhook
```

This explicitly changes that bot's webhook, subscribes to `message`, `widget_query`, and `callback_query`, preserves pending updates, and rejects localhost/IP URLs. Widgets use native `sendWidget` with `allow_queries: true`, synchronous `TelegramWidget.request()` clicks and `answerWidgetQuery` data updates. No Mini App or external widget network calls are used.

## Verification

Offline checks:

```bash
npm run db:generate
npm run db:validate
npm run lint
npm run typecheck
npm run test:telegram
npm run build
```

The unit/widget suite covers scheduling transitions, UTC boundaries, due comparisons, `/start`, `/learn`, `/review`, small-session counters, completion, secret checks, payload/compression limits, safe errors and retries. These mocks alone cannot establish PostgreSQL locking behavior.

### Dedicated Neon integration tests

1. Use a **dedicated disposable Neon test branch**, never production. The runner retains the project's explicit allowlist: a Neon hostname beginning `ep-nameless-hall` and ending `.neon.tech`. For a different dedicated branch, deliberately review/update the guard in the runner and the integration files first; do not substitute the production host.
2. Put the provider-issued test connection string in ignored `.env.test.local`:

   ```dotenv
   TEST_DATABASE_URL=postgresql://USER:PASSWORD@DEDICATED_TEST_HOST/DATABASE?sslmode=verify-full
   ```

   Do not copy the placeholder literally. The runner loads only this test file, never `.env.local`, and overrides child `DATABASE_URL`/`DIRECT_URL` with the validated test URL. The explicit test-branch opt-in is required for migration and read-only status checks. `db:test:status` runs `prisma migrate status` against this branch only.
3. Run:

   ```bash
   npm run db:generate
   WORDFLOW_DB_TESTS=1 npm run db:test:migrate
   WORDFLOW_DB_TESTS=1 npm run db:test:status
   WORDFLOW_DB_TESTS=1 npm run test:db
   ```

   A read-only `SELECT 1` warm-up uses a ten-second connection budget for the allowlisted test branch before running the tests; application connection timeouts remain unchanged. Tests seed the shared vocabulary idempotently and create random synthetic users. Cleanup removes only synthetic users and their personal entries, progress, receipts, attempts and sessions; shared seed vocabulary is retained. The suite tests concurrent/repeated answers, independent clients, rollback, authorization, expiry, active-session conflicts, new-only selection, shorter sessions, completion, due-only review selection, private management, immutable edits, pagination, mode isolation, and reveal/rating atomicity.
4. To test due selection immediately, the suite changes `dueAt` and `lastReviewedAt` only on its synthetic test user's progress rows. It does **not** change the database clock. For a manual Telegram test, use a separate development bot and test deployment pointing to this branch, reveal a word, finish/expire the session, wait ten minutes, then use `/review`. Alternatively adjust only that test account's due timestamps in the test branch, keeping `dueAt >= lastReviewedAt`.
5. Smoke-test `/start`; `/learn`; same-mode resume; `/review` during LEARN; answer/reveal and Next; completion; `/review` with none due and with due words; rapid duplicate clicks; restart the development server and resume. Confirm one attempt per question and one progress row per user/word.

For the Task #6 smoke test, use two test accounts: add the same word with different translations, confirm, browse each dictionary, select PERSONAL, reveal/rate inside `/learn`, and verify the other account cannot use that widget. Check edit, archive/restore, PERSONAL/MIXED selection, `/review` when due, and resume after a server restart. Only adjust due timestamps for those test accounts on the test branch; never change the production clock.

Live Telegram delivery still requires this manual smoke test. Automated tests never send real Telegram messages.

## Production rollout (manual)

1. Review the SQL and conservative backfill above, take a Neon backup/branch, and verify the migration and integration suite on the dedicated test branch.
2. During cutover, temporarily stop accepting webhook traffic with a retryable response and drain old invocations. Apply the migration and deploy the new code before resuming traffic. This avoids an old deployment creating attempts after the historical backfill but before SRS-aware code is active. Preserve pending Telegram updates.
3. From trusted CI/a machine configured explicitly for the intended production database, run:

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

4. Deploy on Vercel with Node.js 24, `npm run build`, the pooled `DATABASE_URL` and existing Telegram secrets. Keep migrations outside automatic builds and Preview environments on their own database/bot. Preserve Prisma generation in install/build. The route remains a Node.js function, not Edge.
5. Resume webhook traffic. Register the webhook only if its URL/subscriptions changed. Verify `/start`, `/add`, `/mywords`, `/mode`, a new `/learn`, an existing widget, `/review`, and the completion summary. Check database records and safe error/latency monitoring.

No production migrations, environment changes, GitHub push, or deployment are performed automatically by this task.

## Provider and runtime limitations

Neon cold starts and remote network latency can exceed the existing one-second connection/lock budget or 3.5-second transaction deadline. Database failures return safe retryable widget feedback; committed outcomes remain replayable. Pools are capped at two connections per warm function; use pooling and keep Vercel close to Neon. Telegram answers use a five-second timeout within its 15-second deadline; prolonged outages or late delivery can still miss that deadline.

The widget retains the existing answer option ordering; SRS does not change old word records or fixed HTML bundles. Legacy cards may not display the new mode label, but their requests remain valid until expiry. Progress belongs to an immutable word ID/version. Study selection currently loads eligible current entries (personal dictionaries are capped at 500); management listing is paginated in PostgreSQL. A production-scale catalog may eventually need database-side sampling.

Task #6 verification: all 43 unit/widget tests and all 24 reported Neon integration tests (including three suite containers) passed. Prisma validation, TypeScript and ESLint passed. The guarded read-only migration-status check confirmed all four migrations are applied on the dedicated test branch. Migrations are tested only on the guarded dedicated test branch. Default `npm run build` hit the existing Turbopack worker-port restriction (`Operation not permitted`), including after a permission retry. `npm run build -- --webpack` passed after allowing the existing Google Font downloads. The default build configuration is unchanged. Run verification commands sequentially: Next builds clear `.next`, which also holds the compiled test helpers. No migrations are hidden in the build.


Telegram API reference: [protected messages and sendWidget](https://core.telegram.org/bots/api#sendwidget), [widget sandbox and payload limits](https://core.telegram.org/bots/widgets). Personal content is never sent as shared/public widget data; incoming forwarded/shared query contexts are rejected. Protection does not prevent a recipient from manually copying or photographing their own content.


Task #6.1 manual smoke test (development bot/test branch): open `/start` on desktop and mobile; add a word entirely through prompts/buttons; double-tap Save; browse page/detail; edit; archive and restore; choose My words; finish a recall session; check an active session survives a settings change; try an expired button; return through `/menu`. Also verify legacy `/learn`, `/review`, `/add word — перевод`, and `/mode PERSONAL`. Do not change production data to force due reviews.

Official navigation APIs: [reply keyboards](https://core.telegram.org/bots/api#replykeyboardmarkup), [callback acknowledgement](https://core.telegram.org/bots/api#answercallbackquery), [message editing](https://core.telegram.org/bots/api#editmessagetext), [command registration](https://core.telegram.org/bots/api#setmycommands).


### Возобновление занятия — Task #7.1

Если Telegram остановил HTML Widget или карточка осталась далеко в истории чата,
нажмите **▶️ Продолжить занятие** на постоянной клавиатуре либо отправьте `/resume`.
WordFlow отправит новый виджет внизу переписки **для той же активной сессии**.
Уже сохранённые ответы и интервалы SRS не изменяются. Старая карточка становится
неактуальной после успешной привязки новой; её повторные запросы отвергаются.
Если новое сообщение не удалось отправить, старая карточка остаётся действующей.
Повторная доставка той же команды Telegram не должна создавать ещё один виджет.
Когда активного занятия нет, бот предложит начать новое через меню.
Занятия по-прежнему имеют обычный срок действия; истёкшие не восстанавливаются.
Изменений Prisma-схемы и миграций для №7.1 нет.
