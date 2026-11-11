import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { POST } from "../.next/telegram-tests/app/api/telegram/webhook/route.js";
import { sendWidget, answerWidgetQuery } from "../.next/telegram-tests/lib/telegram/client.js";
import { QuizStore, quizStore } from "../.next/telegram-tests/lib/telegram/quiz.js";
import { quizWidgetHtml } from "../.next/telegram-tests/lib/telegram/quiz-widget.js";
import { isPrivateWidgetQuery } from "../.next/telegram-tests/lib/telegram/types.js";

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const token = "1234:widget_test_token";
let calls;
let nextId = 500;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_WEBHOOK_SECRET = "test_secret";
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ method: url.split("/").at(-1), options, body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: url.endsWith("answerWidgetQuery") ? true :
      { message_id: ++nextId, chat: { id: 42, type: "private" } } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [["TELEGRAM_BOT_TOKEN", originalToken], ["TELEGRAM_WEBHOOK_SECRET", originalSecret]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const post = body => POST(new Request("https://example.com/api/telegram/webhook", {
  method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "test_secret" }, body: JSON.stringify(body),
}));
const learn = (text = "/learn", type = "private", from = { id: 42, is_bot: false }) => ({
  update_id: 10, message: { message_id: 20, chat: { id: 42, type }, from, text },
});
const query = (session, action = "a2", changes = {}) => ({
  id: randomBytes(8).toString("hex"), from: { id: 42, is_bot: false },
  chat: { id: 42, type: "private" }, message_id: 900, chat_instance: "private-42",
  type: { type: "data" }, data: `q:${session}:${action}`, ...changes,
});
const postQuery = value => post({ update_id: 12, widget_query: value });
const createSession = (store = quizStore) => {
  const id = store.create(42, 42); store.bind(id, 900); return id;
};
const lastAnswer = () => JSON.parse(calls.at(-1).body.data);

test("/learn sends actual sendWidget HTML with queries enabled and verified sender", async () => {
  for (const command of ["/learn", "/learn@WordFlowBot", "/learn topic"]) {
    assert.equal((await post(learn(command))).status, 200);
  }
  assert.equal(calls.length, 3);
  for (const call of calls.slice()) {
    assert.equal(call.method, "sendWidget");
    assert.equal(call.body.allow_queries, true);
    assert.equal(call.body.chat_id, 42);
    assert.match(call.body.html, /Reluctant/);
    const sessionId = call.body.html.match(/q:([a-f0-9]{24}):/)[1];
    const messageId = 501 + calls.indexOf(call);
    assert.equal((await postQuery(query(sessionId, "a2", { message_id: messageId }))).status, 200);
    assert.equal(lastAnswer().correct, true);
  }
});
test("/learn ignores groups and near-matching commands; rejects spoofed/missing sender", async () => {
  for (const body of [learn("/learn", "group"), learn("/learn", "channel"), learn("/learning")]) {
    assert.equal((await post(body)).status, 200);
  }
  for (const from of [undefined, { id: 43, is_bot: false }, { id: 42, is_bot: true }]) {
    const body = learn(); body.message.from = from;
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls.length, 0);
});
test("correct, incorrect, and reveal requests return feedback inside API data", async () => {
  for (const [choice, correct] of [[0, false], [2, true]]) {
    const id = createSession();
    assert.equal((await postQuery(query(id, `a${choice}`))).status, 200);
    assert.deepEqual(lastAnswer(), { status: "answered", selected: choice, correct });
    assert.equal(calls.at(-1).method, "answerWidgetQuery");
    assert.ok(Buffer.byteLength(calls.at(-1).body.data) <= 1024);
    assert.equal((await postQuery(query(id, "r"))).status, 200);
    assert.deepEqual(lastAnswer(), { status: "revealed", selected: choice, correct, correctIndex: 2, answer: "Неохотный" });
  }
});
test("duplicate and simultaneous queries deliver once, and changed choices never regrade", async () => {
  const id = createSession(); const first = query(id, "a0");
  const responses = await Promise.all([postQuery(first), postQuery(first), postQuery(query(id, "a2"))]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(JSON.parse(call.body.data).selected, 0);
  assert.equal((await postQuery(first)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal((await postQuery({ ...first, data: `q:${id}:a2` })).status, 400);
  assert.equal(calls.length, 2);
});
test("revealing before answering ends the attempt without awarding a correct answer", async () => {
  const id = createSession();
  await postQuery(query(id, "r"));
  await postQuery(query(id, "a2"));
  assert.equal(lastAnswer().selected, null);
  assert.equal(lastAnswer().correct, false);
  assert.equal(lastAnswer().status, "revealed");
});
test("invalid data, user, message, chat, type and inline/shared contexts cannot mutate a session", async () => {
  const id = createSession();
  const changes = [
    { from: { id: 43, is_bot: false } }, { from: { id: 42, is_bot: true } },
    { chat: { id: 43, type: "private" }, from: { id: 43, is_bot: false } },
    { chat: { id: 42, type: "group" } }, { message_id: 901 }, { message_id: 0 },
    { inline_message_id: "inline" }, { widget_id: "shared" }, { type: { type: "sign_data" } },
    { type: "data" }, { chat_instance: "" }, { data: `q:${id}:a4` },
    { data: `q:${id}:a2:extra` }, { data: "я".repeat(33) }, { data: "" }, { data: {} },
    { from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false } },
  ];
  for (const change of changes) {
    assert.equal((await postQuery(query(id, "a2", change))).status, 200);
    assert.equal(lastAnswer().status, "error");
  }
  await postQuery(query(id, "a0"));
  assert.equal(lastAnswer().selected, 0);
  await postQuery(query(id, "r", { chat_instance: "different" }));
  assert.equal(lastAnswer().status, "error");
});
test("bad query envelopes and oversized updates are rejected; query auth remains required", async () => {
  for (const body of [null, {}, { id: "" }, { id: "x".repeat(257) }]) {
    assert.equal((await postQuery(body)).status, 400);
  }
  assert.equal((await post({ update_id: 1, padding: "x".repeat(65536) })).status, 400);
  assert.equal((await post({ ...learn(), widget_query: query(createSession()) })).status, 400);
  assert.equal((await post({ ...learn(), update_id: -1 })).status, 400);
  const response = await POST(new Request("https://example.com", {
    method: "POST", body: JSON.stringify({ update_id: 1, widget_query: query(createSession()) }),
  }));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});
test("a stalled webhook body is cancelled before the widget response deadline", async () => {
  let cancelled = false;
  const started = Date.now();
  const response = await POST(new Request("https://example.com", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "test_secret" },
    body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: "half",
  }));
  assert.equal(response.status, 400);
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 5000);
  assert.equal(calls.length, 0);
});
test("session expiry, restart, and bounded capacity fail closed", () => {
  let now = 0;
  const store = new QuizStore(() => now, 1);
  const id = createSession(store);
  assert.throws(() => store.create(42, 42), /capacity/);
  now = 30 * 60_000;
  assert.equal(store.process(query(id)).status, "expired");
  assert.equal(new QuizStore().process(query(id)).status, "expired");
  assert.equal(store.process(query(createSession(store))).correct, true);
});
test("answer transport failure permits delivery retry while preserving the first choice", async () => {
  const id = createSession(); const first = query(id, "a0");
  const successFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(token); };
  const response = await postQuery(first);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(token));
  globalThis.fetch = successFetch;
  assert.equal((await postQuery(first)).status, 200);
  assert.equal(lastAnswer().selected, 0);
  await postQuery(query(id, "a2"));
  assert.equal(lastAnswer().correct, false);
});
test("widget client enforces UTF-8, maximum zlib and response limits before fetching", async () => {
  const payload = { chat_id: 42, html: "", allow_queries: true };
  for (const html of ["", "я".repeat(16385), randomBytes(5000).toString("hex")]) {
    assert.throws(() => sendWidget({ ...payload, html }), /Telegram request failed/);
  }
  assert.throws(() => answerWidgetQuery({ widget_query_id: "q", data: "я".repeat(513) }));
  assert.equal(calls.length, 0);
  assert.equal(await answerWidgetQuery({ widget_query_id: "q", data: "я".repeat(512) }), true);
  assert.equal(isPrivateWidgetQuery(query(createSession(), "a2", { data: "я".repeat(32) })), true);
  assert.equal(isPrivateWidgetQuery(query(createSession(), "a2", { data: "я".repeat(33) })), false);
});
test("widget API methods sanitize errors and require the documented result types", async () => {
  for (const result of [false, {}, "true", null]) {
    globalThis.fetch = async () => Response.json({ ok: true, result });
    await assert.rejects(answerWidgetQuery({ widget_query_id: "q", data: "{}" }), /Telegram request failed/);
    await assert.rejects(sendWidget({ chat_id: 42, html: "<p>Quiz</p>", allow_queries: true }), /Telegram request failed/);
  }
  globalThis.fetch = async () => Response.json({ ok: false, description: token });
  const response = await post(learn());
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(token));
});
test("widget response timeout is five seconds, below Telegram's answer deadline", async () => {
  const original = AbortSignal.timeout;
  const durations = [];
  AbortSignal.timeout = ms => { durations.push(ms); return original(ms); };
  try { await answerWidgetQuery({ widget_query_id: "q", data: "{}" }); }
  finally { AbortSignal.timeout = original; }
  assert.deepEqual(durations, [5000]);
});

// Small DOM/bridge harness runs the actual inline JS with no browser libraries.
function widgetHarness(bridge) {
  const element = (choice) => ({
    dataset: { choice }, disabled: false, textContent: "", classes: new Set(), listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    classList: { add() {}, remove() {} },
  });
  const buttons = [0, 1, 2, 3].map(i => element(String(i)));
  const feedback = element(); const reveal = element();
  const html = quizWidgetHtml("a".repeat(24));
  runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    window: { TelegramWidget: bridge },
    document: { querySelectorAll: () => buttons, getElementById: id => id === "feedback" ? feedback : reveal },
  });
  return { buttons, feedback, reveal, html };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test("HTML stays well below limits and contains no network access, secrets or answer key", () => {
  const html = quizWidgetHtml("a".repeat(24));
  assert.ok(Buffer.byteLength(html) < 32768);
  assert.ok(deflateSync(html, { level: 9 }).length < 3800);
  assert.ok(!html.includes(token));
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotMatch(script, /CORRECT|Неохотный|fetch\(|XMLHttpRequest|location|https:\/\//);
  assert.throws(() => quizWidgetHtml('</script>'));
});
test("click calls bridge synchronously, locks pending taps, and renders server feedback/reveal", async () => {
  let resolve; const requests = [];
  const ui = widgetHarness({ viewer: { id: 42 }, ready() {}, request(data) {
    requests.push(data); return new Promise(done => { resolve = done; });
  } });
  ui.buttons[0].listeners.click();
  assert.equal(requests.length, 1); // Before yielding to any promise/timer.
  assert.equal(requests[0], `q:${"a".repeat(24)}:a0`);
  assert.ok(ui.buttons.every(b => b.disabled));
  ui.buttons[1].listeners.click();
  assert.equal(requests.length, 1);
  resolve({ result: JSON.stringify({ status: "answered", selected: 0, correct: false }) });
  await flush();
  assert.match(ui.feedback.textContent, /Пока не совсем/);
  assert.ok(ui.buttons.every(b => b.disabled));
  assert.equal(ui.reveal.disabled, false);
  ui.reveal.listeners.click();
  assert.equal(requests[1], `q:${"a".repeat(24)}:r`);
  resolve({ result: JSON.stringify({ status: "revealed", selected: 0, correct: false, correctIndex: 2, answer: "Неохотный" }) });
  await flush();
  assert.equal(ui.feedback.textContent, "Reluctant — Неохотный");
  assert.equal(ui.reveal.disabled, true);
});
test("widget handles correct, expired, malformed, rate-limited and synchronous failure states", async () => {
  for (const [reply, text, locked] of [
    [{ status: "answered", selected: 2, correct: true }, /Верно/, true],
    [{ status: "expired", message: "Send /learn" }, /Send \/learn/, true],
    [null, /Не удалось/, false],
  ]) {
    const ui = widgetHarness({ viewer: {}, ready() {}, request: () => Promise.resolve({ result: JSON.stringify(reply) }) });
    ui.buttons[2].listeners.click(); await flush();
    assert.match(ui.feedback.textContent, text);
    assert.equal(ui.buttons[0].disabled, locked);
  }
  for (const request of [() => Promise.reject({ code: "RATE_LIMITED" }), () => { throw Error(); }]) {
    const ui = widgetHarness({ viewer: {}, ready() {}, request });
    ui.buttons[0].listeners.click(); await flush();
    assert.equal(ui.buttons[0].disabled, false);
    assert.match(ui.feedback.textContent, /нажмите|Нажмите/);
  }
  const preview = widgetHarness(undefined);
  assert.ok(preview.buttons.every(b => b.disabled));
});
