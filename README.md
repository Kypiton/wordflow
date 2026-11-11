# WordFlow

A Telegram-first English vocabulary learning app built with Next.js App Router and TypeScript. Supports `/start` onboarding and `/learn`, a real Bot API 10.4 HTML vocabulary quiz inside a private Telegram chat. No database, authentication system, Mini App, AI, or widget dependencies are used.

## Onboarding and setup

Use Node.js 22.9+ and npm.

```bash
npm install
cp -n .env.example .env.local
```

Keep an existing `.env.local`; fill in its placeholders locally:

- `TELEGRAM_BOT_TOKEN`: create a bot with Telegram's [@BotFather](https://t.me/BotFather) and copy its token.
- `TELEGRAM_WEBHOOK_SECRET`: generate a secret with `openssl rand -hex 32`. Use the same value on the deployed app and when registering the webhook.
- `TELEGRAM_WEBHOOK_URL`: the full public HTTPS URL, for example `https://wordflow.your-domain.com/api/telegram/webhook`.

These are server secrets: never use a `NEXT_PUBLIC_` prefix, commit them, or paste tokens into URLs in a browser. `.env.local` remains ignored; `.env.example` contains placeholders only.

```bash
npm run dev
```

The app runs at `http://localhost:3000`. Telegram cannot deliver public webhooks to localhost. Deploy the app to an HTTPS host, or use a public HTTPS tunnel pointing to port 3000. Configure the same environment variables on the host, and make sure the webhook route is reachable without a deployment login.

Once the public endpoint is running, register it:

```bash
npm run telegram:webhook
```

The script loads `.env.local` (existing shell environment variables take precedence), validates configuration, and calls Telegram's [`setWebhook`](https://core.telegram.org/bots/api#setwebhook). It rejects localhost, local hostnames, IP literals, and non-HTTPS URLs. Use a publicly resolvable domain. Registration replaces the bot's existing webhook, subscribes to `message` and `widget_query` updates, and preserves pending updates. Re-run it after changing the public URL or webhook secret. Registration is an explicit setup step; builds and app startup never register it automatically.

Open your bot in Telegram and send `/start` in a private chat. You should receive the WordFlow welcome message. `/start` with a deep-link argument or `@bot_username` suffix is supported. Send `/learn` to open the quiz. Other commands, non-text messages, and group chats are acknowledged without a reply.

## Interactive vocabulary quiz

After deploying Task #2, **run `npm run telegram:webhook` again** to enable `widget_query` updates. Use a Telegram client with HTML widget support. Send `/learn` in your private chat with the bot; it calls [`sendWidget`](https://core.telegram.org/bots/api#sendwidget) with inline HTML and `allow_queries: true`.

The lavender card asks for the Russian translation of **Reluctant**. Tap one of four options to receive server-validated correct/incorrect feedback inside the same card. **Неохотный** is correct. “Показать ответ” asks the server to reveal the answer; revealing first closes the attempt without recording a correct selection. Send `/learn` for another attempt.

The widget calls `TelegramWidget.request()` synchronously from the click handler. It disables controls while awaiting a response, renders the `result` returned by [`answerWidgetQuery`](https://core.telegram.org/bots/api#answerwidgetquery), and displays failures with a manual retry. It uses no external assets, network APIs, navigation, or client-side grading. Dark mode, narrow layouts, rounded touch targets, and a caption below the card keep controls clear of Telegram's timestamp.

### State and request safety

Run this task on **one long-running Node.js instance**. Up to 1,000 quiz sessions live in memory for 30 minutes. Sessions bind an opaque random identifier to the Telegram sender, private chat, and returned widget message ID; the first valid request also binds the chat instance. Only data queries from that original context are accepted. Inline/shared widgets, bot users, mismatched identities, malformed actions, and oversized input are rejected with safe feedback where a usable query ID exists.

The first selection is committed synchronously before network I/O. Repeated answers, changed choices, and simultaneous queries return that original outcome. A bounded 60-second receipt cache coalesces duplicate query IDs; changed payloads reusing an ID are rejected. Failed answer delivery may be retried without grading again. Reveals are idempotent. No score, reward, or other external side effect is recorded.

This is deliberately **not distributed or durable storage**: restarts, redeployments, and expiry make old cards return an expiry message. Multiple workers/serverless instances can reject sessions created by another worker. They cannot reconstruct or regrade an unknown session. Reopening a card resets its local display; the next tap retrieves the retained server outcome. Shared durable state is needed before scaling beyond one process. `/start` and `/learn` sends themselves remain subject to duplicate Telegram delivery after an ambiguous send timeout.

Webhook authentication still uses the secret header and constant-time digest comparison. Bodies are limited to 64 KiB and two seconds of reading. Query validation is local and `answerWidgetQuery` runs immediately with a five-second network timeout and no automatic retries, leaving headroom for Telegram's 15-second deadline. Network outages or delayed webhook delivery can still cause Telegram timeouts.

The [official widget limits](https://core.telegram.org/bots/widgets) are enforced: HTML ≤32,768 UTF-8 bytes, zlib level 9 ≤4,096 bytes, requests 1–64 bytes, and answers ≤1,024 bytes. This quiz measures 4,751 HTML bytes and about 2.2 KB using Python zlib level 9 (compression varies slightly with the session identifier); its action payloads are 28–29 bytes. Tests enforce limits on generated output as well as API inputs.

## Implementation and verification

- `src/lib/telegram/client.ts`: server-only, native-fetch Bot API client with typed inputs, runtime-validated responses, a timeout, and sanitized errors.
- `src/lib/telegram/types.ts`: minimal message/update types and validators. Unknown fields and update types are tolerated.
- `src/lib/telegram/webhook.ts`: bounded update reading, constant-time secret comparison, command selection, and welcome text.
- `src/lib/telegram/quiz-widget.ts`: compact HTML/CSS/vanilla JS presentation.
- `src/lib/telegram/quiz.ts`: session context, authoritative grading, reveal, and duplicate-query handling.
- `src/app/api/telegram/webhook/route.ts`: Node.js POST route; validates the secret before parsing updates.
- `scripts/register-telegram-webhook.mjs`: explicit registration with secret and `allowed_updates` settings.

The route returns `401` for a missing/incorrect secret, `400` for malformed updates, `503` for missing/invalid server secret configuration, and `502` if a Telegram API call fails. Invalid quiz senders or query envelopes also return `400`. Invalid query actions/context with a usable query ID receive safe error feedback through `answerWidgetQuery`. Successful or unsupported updates return `200`. Delivery is awaited so failures can be retried by Telegram. Query answer deduplication has the process-local scope described above.

```bash
npm run test:telegram
npm run lint
npm run typecheck
npm run build
```

Tests mock Telegram fetch requests and use fake credentials; they do not register a webhook or send real messages. The 26 tests cover `/start` regression, widget API payloads and limits, `/learn`, sender/context validation, correct/wrong/reveal outcomes, concurrent duplicates, changed answers, expiry/capacity, sanitized failures, delivery retries, stalled request bodies, and synchronous click behavior using the actual widget script in a DOM/bridge harness.

Manual Telegram smoke test after deployment: send `/start`, then `/learn`; choose a wrong answer and reveal it; open a new quiz and choose “Неохотный”; tap rapidly and reopen a card; verify that feedback stays inside the widget. Automated tests mock Telegram and cannot verify native Telegram rendering or live delivery.

### Task #2 verification environment

Tests, lint, and TypeScript checks pass. The 320px layout was visually checked in local headless Chrome with a mock Telegram bridge; production HTML contains no mock bridge. Live Telegram delivery still needs the deployment smoke test above.

`npm run build` was attempted normally and with elevated permission. Both hit the existing Turbopack CSS-worker restriction: `binding to a port: Operation not permitted` while processing `src/app/globals.css`. This environment cannot complete the production build; rerun it on a host that permits Turbopack's local worker ports. The app's build configuration has not been changed to mask the failure.
