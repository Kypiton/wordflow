import assert from 'node:assert/strict';
import { test, mock, beforeEach, afterEach } from 'node:test';
import { POST } from '../.next/telegram-tests/app/api/telegram/webhook/route.js';
import { vocabularyStore } from '../.next/telegram-tests/lib/telegram/vocabulary.js';
import { quizStore } from '../.next/telegram-tests/lib/telegram/quiz.js';
import { confirmation } from '../.next/telegram-tests/lib/vocabulary/domain.js';
import { MAIN_KEYBOARD, modePicker, validCallbackData } from '../.next/telegram-tests/lib/telegram/navigation.js';
import { callbackReceiptKey } from '../.next/telegram-tests/lib/db/vocabulary-repository.js';
const env = { token: process.env.TELEGRAM_BOT_TOKEN, secret: process.env.TELEGRAM_WEBHOOK_SECRET };
let calls;
beforeEach(() => { calls = []; process.env.TELEGRAM_BOT_TOKEN = '123:test'; process.env.TELEGRAM_WEBHOOK_SECRET = 'test_secret';
  mock.method(globalThis, 'fetch', async (url, opts) => { const method = url.split('/').at(-1); calls.push({ method, data: JSON.parse(opts.body) }); return Response.json({ ok: true, result: method === 'answerCallbackQuery' ? true : { message_id: 90, chat: { id: 42, type: 'private' } } }); });
  mock.method(vocabularyStore, 'delivered', async () => {});
  mock.method(vocabularyStore, 'bindPrompt', async () => {});
});
afterEach(() => { mock.restoreAll(); for (const [key, value] of [['TELEGRAM_BOT_TOKEN', env.token], ['TELEGRAM_WEBHOOK_SECRET', env.secret]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const post = data => POST(new Request('https://example.com', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test_secret' }, body: JSON.stringify({ update_id: 4, ...data }) }));
const message = text => ({ message_id: 50, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text });
const callback = (data, changes = {}) => ({ id: 'cb-1', from: { id: 42, is_bot: false }, message: { ...message(''), message_id: 90 }, data, ...changes });
test('start/menu/help expose Russian persistent navigation without database dependence', async () => {
  for (const text of ['/start', '/menu', '/help', '/menu@WordFlow']) assert.equal((await post({ message: message(text) })).status, 200);
  for (const call of calls) assert.deepEqual(call.data.reply_markup, MAIN_KEYBOARD);
  assert.match(calls[2].data.text, /Повтор|повтор/);
});
test('menu labels open mode picker and guided add; no visible confirmation token', async () => {
  const seen = [];
  mock.method(vocabularyStore, 'process', async (...args) => { seen.push(args); return { text: 'Выберите словарь', keyboard: modePicker('GENERAL') }; });
  await post({ message: message('📚 Учить слова') }); await post({ message: message('➕ Добавить слово') });
  assert.deepEqual(seen.map(args => args[2]), ['/choose', '/add']);
  const token = 'a'.repeat(24), response = confirmation({ kind: 'add', term: 'achieve', translation: 'достигать', partOfSpeech: '', example: null }, token);
  assert.doesNotMatch(response.text, /[a-f0-9]{24}|\/confirm|\/cancel/);
  assert.equal(response.keyboard.inline_keyboard[0][0].text, 'Сохранить');
  for (const row of response.keyboard.inline_keyboard) for (const b of row) assert.ok(validCallbackData(b.callback_data));
});
test('callbacks are acknowledged before DB work, edit messages, and skip already delivered retries', async () => {
  let delivered = false;
  mock.method(vocabularyStore, 'process', async (...args) => { assert.equal(calls.at(-1).method, 'answerCallbackQuery'); assert.equal(args[4], 'cb-1'); return delivered ? { text: 'Сохранено', deliveredMessageId: 90 } : { text: 'Сохранено' }; });
  mock.method(vocabularyStore, 'delivered', async () => { delivered = true; });
  await post({ callback_query: callback('v1:save:' + 'a'.repeat(24)) });
  await post({ callback_query: callback('v1:save:' + 'a'.repeat(24)) });
  assert.deepEqual(calls.map(c => c.method), ['answerCallbackQuery', 'editMessageText', 'answerCallbackQuery']);
  assert.ok(callbackReceiptKey('cb-1') < 0); assert.equal(callbackReceiptKey('cb-1'), callbackReceiptKey('cb-1'));
});
test('forged, cross-user, inaccessible and oversized callbacks never reach the repository', async () => {
  const repo = mock.method(vocabularyStore, 'process', async () => { throw Error('must not run'); });
  for (const q of [callback('v2:save:x'), callback('v1:word:' + '-'.repeat(36)), callback('x'.repeat(65)), callback('v1:add', { from: { id: 43, is_bot: false } }), callback('v1:add', { message: { ...message(''), date: 0 } }), callback('v1:add', { inline_message_id: 'shared' }), callback('v1:add', { message: { ...message(''), forward_origin: {} } })]) assert.equal((await post({ callback_query: q })).status, 200);
  assert.equal(repo.mock.callCount(), 0); assert.ok(calls.every(c => c.method === 'answerCallbackQuery' && c.data.show_alert));
  assert.equal((await post({ message: message('/start'), callback_query: callback('v1:add') })).status, 400);
});
test('learn-my-words launches existing quiz orchestration only after persisted preference response', async () => {
  mock.method(vocabularyStore, 'process', async () => ({ text: 'Мои слова', learn: 'LEARN' }));
  const create = mock.method(quizStore, 'create', async () => ({ kind: 'message', message: 'Продолжим активное занятие' }));
  await post({ callback_query: callback('v1:learn:PERSONAL') });
  assert.deepEqual(create.mock.calls[0].arguments.slice(0, 3), [42, 42, 'LEARN']);
  assert.equal(calls.filter(c => c.method === 'sendWidget').length, 0);
});
test('database failures never expose details', async () => {
  mock.method(vocabularyStore, 'process', async () => { throw Error('secret database URL'); });
  const result = await post({ callback_query: callback('v1:settings') });
  assert.equal(result.status, 502); assert.doesNotMatch(await result.text(), /secret/);
  assert.equal(calls[0].method, 'answerCallbackQuery');
});

test('unchanged message edits are idempotent and other Telegram edit errors stay safe', async () => {
  mock.method(vocabularyStore, 'process', async () => ({ text: 'Сохранено' }));
  mock.method(globalThis, 'fetch', async (url) => url.endsWith('answerCallbackQuery')
    ? Response.json({ ok: true, result: true })
    : Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified: content unchanged' }, { status: 400 }));
  assert.equal((await post({ callback_query: callback('v1:settings') })).status, 200);
  mock.method(globalThis, 'fetch', async (url) => url.endsWith('answerCallbackQuery')
    ? Response.json({ ok: true, result: true })
    : Response.json({ ok: false, error_code: 400, description: 'private details' }, { status: 400 }));
  const failed = await post({ callback_query: callback('v1:settings') });
  assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /private details/);
});

test('guided input forces a private reply without displaying internal tokens', async () => {
  mock.method(vocabularyStore, 'process', async () => ({ text: 'Какое слово добавить?', promptToken: 'a'.repeat(24), forceReply: true }));
  await post({ callback_query: callback('v1:add') });
  assert.deepEqual(calls.map(c => c.method), ['answerCallbackQuery', 'sendMessage']);
  assert.deepEqual(calls[1].data.reply_markup, { force_reply: true });
  assert.equal(calls[1].data.protect_content, true);
  assert.doesNotMatch(calls[1].data.text, /a{24}/);
});
