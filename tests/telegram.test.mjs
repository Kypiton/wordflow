import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { POST } from "../.next/telegram-tests/app/api/telegram/webhook/route.js";
import { sendMessage } from "../.next/telegram-tests/lib/telegram/client.js";
import { registerWebhook, webhookConfiguration } from "../scripts/register-telegram-webhook.mjs";

const token = "123456:fake_test_token";
const secret = "test_secret";
const config = {
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_WEBHOOK_SECRET: secret,
  TELEGRAM_WEBHOOK_URL: "https://wordflow.example.com/api/telegram/webhook",
};
const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
let calls;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_WEBHOOK_SECRET = secret;
  calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return Response.json({ ok: true, result: { message_id: 2, chat: { id: 42, type: "private" } } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = originalSecret;
});
const update = (text = "/start", type = "private") => ({
  update_id: 1, message: { message_id: 1, chat: { id: 42, type }, text },
});
const request = (body, header = secret) => new Request("https://wordflow.example.com/api/telegram/webhook", {
  method: "POST",
  headers: header === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": header },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("rejects missing, incorrect, and different-length secrets before reading JSON", async () => {
  for (const header of [null, "", "wrong", "x".repeat(300)]) {
    assert.equal((await POST(request("invalid JSON", header))).status, 401);
  }
  assert.equal(calls.length, 0);
});
test("fails closed when server secret is absent or invalid", async () => {
  for (const value of ["", "invalid secret"]) {
    process.env.TELEGRAM_WEBHOOK_SECRET = value;
    assert.equal((await POST(request(update()))).status, 503);
  }
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  assert.equal((await POST(request(update()))).status, 503);
});
test("rejects malformed JSON and invalid update shapes", async () => {
  for (const body of ["{", null, [], {}, { update_id: "1" }, { update_id: 1, message: null }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal(calls.length, 0);
});
test("welcomes private /start commands including deep links and bot suffix", async () => {
  for (const command of ["/start", "/start referral", "/start@WordFlowBot", "/start@WordFlowBot referral"]) {
    assert.equal((await POST(request(update(command)))).status, 200);
  }
  assert.equal(calls.length, 4);
  const [url, options] = calls[0];
  assert.equal(url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(options.method, "POST");
  assert.equal(options.cache, "no-store");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  const body = JSON.parse(options.body);
  assert.equal(body.chat_id, 42);
  assert.match(body.text, /WordFlow/);
  assert.match(body.text, /новыми словами/);
  assert.equal(body.reply_markup.is_persistent, true);
});
test("ignores non-private chats, other commands, non-text and future updates", async () => {
  for (const body of [update("/start", "group"), update("/start", "supergroup"), update("/start", "channel"),
    update("/started"), update("hello /start"), update("/unknown"), update(null),
    { update_id: 1, future_update: {} }, { update_id: 1, edited_message: update().message }]) {
    // Non-text Telegram messages omit text rather than setting it to null.
    if (body.message?.text === null) delete body.message.text;
    assert.equal((await POST(request(body))).status, 200);
  }
  assert.equal(calls.length, 0);
});
test("client sanitizes transport, API, HTTP, and malformed response errors", async () => {
  for (const mock of [
    async () => { throw new Error(`https://api.telegram.org/bot${token}/sendMessage`); },
    async () => Response.json({ ok: false, error_code: 400, description: token }),
    async () => Response.json({ ok: true, result: {} }),
    async () => new Response(token, { status: 500 }),
    async () => Response.json({ ok: true, result: update().message }, { status: 500 }),
  ]) {
    globalThis.fetch = mock;
    await assert.rejects(sendMessage({ chat_id: 42, text: "test" }), error => {
      assert.equal(error.message, "Telegram request failed.");
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(token));
      return true;
    });
    const response = await POST(request(update()));
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(token));
  }
});
test("missing bot token fails without a network request", async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  assert.equal((await POST(request(update()))).status, 502);
  assert.equal(calls.length, 0);
});
test("registration rejects local URLs and unsafe configuration before fetching", async () => {
  for (const origin of ["http://wordflow.example.com", "https://localhost", "https://foo.localhost", "https://localhost.",
    "https://127.0.0.1", "https://127.1", "https://[::1]", "https://10.0.0.1", "https://host.local",
    "https://user:password@wordflow.example.com", "https://wordflow.example.com:3000"]) {
    await assert.rejects(registerWebhook({ ...config, TELEGRAM_WEBHOOK_URL: `${origin}/api/telegram/webhook` }));
  }
  assert.throws(() => webhookConfiguration({ ...config, TELEGRAM_WEBHOOK_SECRET: "bad secret" }));
  assert.equal(calls.length, 0);
});
test("registration sends secret and message subscription without dropping updates", async () => {
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return Response.json({ ok: true, result: true });
  };
  await registerWebhook(config);
  assert.ok(calls[1][0].endsWith("/setMyCommands"));
  assert.ok(JSON.parse(calls[1][1].body).commands.some(c => c.command === "menu"));
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    url: config.TELEGRAM_WEBHOOK_URL, secret_token: secret, allowed_updates: ["message", "widget_query", "callback_query"],
  });
});
test("registration never exposes API or network errors", async () => {
  globalThis.fetch = async () => { throw new Error(token); };
  await assert.rejects(registerWebhook(config), error => !error.message.includes(token) && !error.cause);
});
