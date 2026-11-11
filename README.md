# WordFlow

A Telegram-first English vocabulary learning app built with Next.js App Router and TypeScript. Task #1 provides a private-chat `/start` welcome message. Vocabulary storage, authentication, Mini App UI, and HTML widgets are not implemented yet.

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

The script loads `.env.local` (existing shell environment variables take precedence), validates configuration, and calls Telegram's [`setWebhook`](https://core.telegram.org/bots/api#setwebhook). It rejects localhost, local hostnames, IP literals, and non-HTTPS URLs. Use a publicly resolvable domain. Registration replaces the bot's existing webhook, subscribes to `message` updates, and preserves pending updates. Re-run it after changing the public URL or webhook secret. Registration is an explicit setup step; builds and app startup never register it automatically.

Open your bot in Telegram and send `/start` in a private chat. You should receive the WordFlow welcome message. `/start` with a deep-link argument or `@bot_username` suffix is supported. Other commands, non-text messages, and group chats are acknowledged without a reply.

## Implementation and verification

- `src/lib/telegram/client.ts`: server-only, native-fetch Bot API client with typed inputs, runtime-validated responses, a timeout, and sanitized errors.
- `src/lib/telegram/types.ts`: minimal message/update types and validators. Unknown fields and update types are tolerated.
- `src/lib/telegram/webhook.ts`: constant-time comparison of fixed-size secret digests, command selection, and welcome text.
- `src/app/api/telegram/webhook/route.ts`: Node.js POST route; validates the secret before parsing updates.
- `scripts/register-telegram-webhook.mjs`: explicit registration with secret and `allowed_updates` settings.

The route returns `401` for a missing/incorrect secret, `400` for malformed updates, `503` for missing/invalid server secret configuration, and `502` if the welcome message cannot be sent. Successful or unsupported updates return `200`. Delivery is awaited so failures can be retried by Telegram. There is no durable deduplication yet: retries after an ambiguous send timeout can produce duplicate welcomes.

```bash
npm run test:telegram
npm run lint
npm run build
```

Tests mock Telegram fetch requests and use fake credentials; they do not register a webhook or send real messages. The client and update handler are separate so future Bot API 10.4 widget methods and update types can be added without changing secret verification. Add the corresponding `allowed_updates` types when implementing widgets.
