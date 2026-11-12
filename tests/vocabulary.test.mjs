import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { englishTerm, russianTranslation, optionalField, splitEntry, vocabularyCommand, normalizeText } from '../.next/telegram-tests/lib/vocabulary/domain.js';
import { vocabularyStore, handleVocabularyMessage } from '../.next/telegram-tests/lib/telegram/vocabulary.js';
import { POST } from '../.next/telegram-tests/app/api/telegram/webhook/route.js';
import { parseSessionAction } from '../.next/telegram-tests/lib/telegram/quiz-domain.js';
const originalToken = process.env.TELEGRAM_BOT_TOKEN, originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
afterEach(() => { mock.restoreAll(); for (const [key, value] of [['TELEGRAM_BOT_TOKEN', originalToken], ['TELEGRAM_WEBHOOK_SECRET', originalSecret]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const message = (text, changes = {}) => ({ message_id: 12, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false }, text, ...changes });

test('vocabulary normalization preserves phrases and rejects malformed, empty and oversized input', () => {
  assert.equal(englishTerm('  Ｄｏｎ’ｔ\t give   up '), "Don't give up");
  assert.deepEqual(splitEntry('overwhelmed — подавленный'), ['overwhelmed', 'подавленный']);
  assert.deepEqual(splitEntry('give up'), ['give up', undefined]);
  assert.equal(russianTranslation('  быть\nготовым '), 'быть готовым');
  assert.equal(optionalField('-', 'example'), null);
  assert.equal(optionalField('phrasal verb', 'pos'), 'phrasal verb');
  for (const bad of ['', '  ', 'слово', 'word\u202e', '<script>', 'a'.repeat(81), '\u0000word']) assert.throws(() => englishTerm(bad));
  for (const bad of ['', 'english only', 'я'.repeat(121)]) assert.throws(() => russianTranslation(bad));
  assert.throws(() => optionalField('x'.repeat(161), 'example'));
  assert.throws(() => splitEntry('word — перевод — ещё'));
  assert.throws(() => normalizeText('a\ud800', 80));
  assert.equal(vocabularyCommand('/addition word'), null);
  assert.equal(vocabularyCommand('/add@WordFlow word').name, 'add');
  assert.equal(parseSessionAction('q:' + 'a'.repeat(24) + ':0:k').remembered, true);
  assert.equal(parseSessionAction('q:' + 'a'.repeat(24) + ':0:f').remembered, false);
});

test('vocabulary webhook authenticates sender, protects messages and binds translation prompts', async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test_secret'; process.env.TELEGRAM_BOT_TOKEN = '123:test';
  const args = [], sent = [], bound = [];
  mock.method(vocabularyStore, 'process', async (...values) => { args.push(values); return { text: 'Перевод?', promptToken: 'a'.repeat(24) }; });
  mock.method(vocabularyStore, 'bindPrompt', async (...values) => { bound.push(values); });
  mock.method(globalThis, 'fetch', async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ ok: true, result: { message_id: 101, chat: { id: 42, type: 'private' } } }); });
  const post = (m, secret = 'test_secret') => POST(new Request('https://example.com', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: 5, message: m }) }));
  assert.equal((await post(message('/add word'), 'bad')).status, 401); assert.equal(args.length, 0);
  assert.equal((await post(message('/add overwhelmed'))).status, 200);
  assert.deepEqual(args[0], [42, 12, '/add overwhelmed', undefined]);
  assert.equal(sent[0].protect_content, true); assert.deepEqual(bound[0], [42, 'a'.repeat(24), 101]);
  await post(message('подавленный', { reply_to_message: { message_id: 101 } }));
  assert.equal(args[1][3], 101);
  for (const m of [message('/mywords', { from: { id: 9, is_bot: false } }), message('/add word', { from: { id: 42, is_bot: true } }), message('/mywords', { chat: { id: -1, type: 'group' } }), message('/mywords', { forward_origin: {} }), message('случайный текст')]) await handleVocabularyMessage(m);
  assert.equal(args.length, 2);
});

test('vocabulary failures are sanitized and safely retryable at webhook boundary', async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test_secret';
  mock.method(vocabularyStore, 'process', async () => { throw new Error('postgresql://private-secret'); });
  const response = await POST(new Request('https://example.com', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test_secret' }, body: JSON.stringify({ update_id: 1, message: message('/mywords') }) }));
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /private-secret/);
});

test('maximum personal content stays within widget response budget after JSON escaping', () => {
  const response = { mode: 'REVIEW', revision: 1000, position: 9, total: 10, content: { term: englishTerm('a'.repeat(80)), partOfSpeech: optionalField('я'.repeat(40), 'pos'), options: [], kind: 'self' }, status: 'recall', answer: russianTranslation('я'.repeat(120)), example: optionalField('я'.repeat(160), 'example') };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024);
  assert.throws(() => optionalField('漢'.repeat(80) + '"'.repeat(80), 'example'));
});
