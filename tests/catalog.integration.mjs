import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createDatabaseClient } from '../.next/database-tools/src/lib/db/prisma.js';
import { PrismaQuizRepository } from '../.next/database-tools/src/lib/db/quiz-repository.js';
import { VocabularyRepository } from '../.next/database-tools/src/lib/db/vocabulary-repository.js';
import { expandedEntries, seedExpandedVocabulary } from '../.next/database-tools/prisma/seed.js';

const url = process.env.TEST_DATABASE_URL;
let allowlisted = false;
try { const host = new URL(url).hostname; allowlisted = host.startsWith('ep-nameless-hall') && host.endsWith('.neon.tech'); } catch {}

test('Task #7: expanded CEFR vocabulary, historical preservation and learning filters', {
  skip: !(allowlisted && process.env.WORDFLOW_DB_TESTS === '1') && 'Dedicated test Neon branch required',
}, async t => {
  const db = createDatabaseClient(url);
  const quiz = new PrismaQuizRepository(() => db), vocab = new VocabularyRepository(() => db);
  const user = BigInt(Number.parseInt(randomBytes(6).toString('hex'), 16));
  let messageId = 60000;
  try {
    const original = await db.word.findUnique({ where: { slug_version: { slug: 'reluctant', version: 1 } },
      include: { options: { orderBy: { position: 'asc' } } } });
    assert.ok(original, 'Initial storage seed must exist');
    const entries = expandedEntries();
    assert.ok(entries.length >= 300 && entries.length <= 500);
    await t.test('seed is additive, idempotent and keeps original answers', async () => {
      assert.equal(await seedExpandedVocabulary(db), entries.length);
      const count = await db.word.count({ where: { personalWordId: null, version: 1 } });
      assert.equal(await seedExpandedVocabulary(db), entries.length);
      assert.equal(await db.word.count({ where: { personalWordId: null, version: 1 } }), count);
      const after = await db.word.findUnique({ where: { slug_version: { slug: 'reluctant', version: 1 } },
        include: { options: { orderBy: { position: 'asc' } } } });
      assert.equal(after.id, original.id);
      assert.deepEqual(after.options, original.options);
      for (const level of ['A1', 'A2', 'B1', 'B2', 'C1']) {
        assert.ok(await db.word.count({ where: { cefrLevel: level, personalWordId: null } }) >= 45, level);
      }
      const wrong = await db.word.findMany({ where: { personalWordId: null }, include: { options: true } });
      assert.ok(wrong.every(word => word.options.length === 4 && word.options.filter(option => option.isCorrect).length === 1 && new Set(word.options.map(o => o.text)).size === 4));
    });
    await t.test('level selection survives and snapshots do not replace active sessions', async () => {
      const id = Number(user);
      let result = await vocab.process(id, ++messageId, '/level A1');
      assert.match(result.text, /A1/);
      let session = await quiz.create(id, id);
      assert.equal(session.kind, 'widget', session.message);
      const rows = await db.sessionItem.findMany({ where: { sessionId: session.id }, include: { word: true } });
      assert.ok(rows.length >= 1 && rows.every(row => row.word.cefrLevel === 'A1' && row.word.personalWordId === null));
      assert.equal((await db.studySession.findUniqueOrThrow({ where: { id: session.id } })).cefrLevel, 'A1');
      result = await vocab.process(id, ++messageId, '/level C1');
      assert.match(result.text, /C1/);
      assert.equal((await quiz.create(id, id)).kind, 'message');
      assert.equal((await db.studySession.findUniqueOrThrow({ where: { id: session.id } })).cefrLevel, 'A1');
      await quiz.revoke(session.id);
      session = await quiz.create(id, id);
      assert.equal(session.kind, 'widget', session.message);
      const later = await db.sessionItem.findMany({ where: { sessionId: session.id }, include: { word: true } });
      assert.ok(later.every(row => row.word.cefrLevel === 'C1'));
      await quiz.revoke(session.id);
      result = await vocab.process(id, ++messageId, '/level ALL');
      assert.match(result.text, /Все уровни/);
      assert.equal((await db.telegramUser.findUniqueOrThrow({ where: { id: user } })).cefrLevel, null);
    });
  } finally {
    try {
      await db.userWordProgress.deleteMany({ where: { userId: user } });
      await db.widgetQueryReceipt.deleteMany({ where: { session: { userId: user } } });
      await db.reviewAttempt.deleteMany({ where: { item: { session: { userId: user } } } });
      await db.sessionItem.deleteMany({ where: { session: { userId: user } } });
      await db.learnRequest.deleteMany({ where: { userId: user } });
      await db.studySession.deleteMany({ where: { userId: user } });
      await db.vocabularyReceipt.deleteMany({ where: { userId: user } });
      await db.telegramUser.deleteMany({ where: { id: user } });
    } finally { await db.$disconnect(); }
  }
});
