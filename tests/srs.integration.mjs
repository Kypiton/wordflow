import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createDatabaseClient } from '../.next/database-tools/src/lib/db/prisma.js';
import { PrismaQuizRepository } from '../.next/database-tools/src/lib/db/quiz-repository.js';
import { seedInitialWord } from '../.next/database-tools/prisma/seed.js';

const url = process.env.TEST_DATABASE_URL;
let allowed = false;
try { const host = new URL(url).hostname; allowed = host.startsWith('ep-nameless-hall') && host.endsWith('.neon.tech'); } catch {}
test('SRS: transactional scheduling and personalized sessions', {
  skip: !(allowed && process.env.WORDFLOW_DB_TESTS === '1') && 'Dedicated test branch and explicit opt-in required.',
}, async t => {
  const db = createDatabaseClient(url), peer = createDatabaseClient(url);
  const repo = new PrismaQuizRepository(() => db), other = new PrismaQuizRepository(() => peer);
  const users = [];
  const user = () => { const id = Number.parseInt(randomBytes(6).toString('hex'), 16); users.push(BigInt(id)); return id; };
  let messageId = 500;
  const create = async (id, mode = 'LEARN') => {
    const result = await repo.create(id, id, mode);
    assert.equal(result.kind, 'widget', result.message);
    const message = ++messageId;
    await repo.bind(result.id, message, result.sendToken);
    return { ...result, userId: id, messageId: message };
  };
  const query = (session, action, overrides = {}) => ({
    id: randomBytes(12).toString('hex'), from: { id: session.userId, is_bot: false },
    chat: { id: session.userId, type: 'private' }, message_id: session.messageId,
    chat_instance: `srs-${session.userId}`, type: { type: 'data' }, data: `q:${session.id}:${action}`, ...overrides,
  });
  const items = session => db.sessionItem.findMany({ where: { sessionId: session.id }, orderBy: { position: 'asc' }, include: { word: { include: { options: true } } } });
  const progress = (id, wordId) => db.userWordProgress.findUnique({ where: { userId_wordId: { userId: BigInt(id), wordId } } });
  const answer = (session, item, correct = true) => query(session, `${item.position}:a${item.word.options.find(o => o.isCorrect === correct).position}`);
  try {
    await seedInitialWord(db);
    await t.test('first correct creates progress; duplicate/concurrent queries never schedule twice', async () => {
      const id = user(), session = await create(id), [item] = await items(session);
      const request = answer(session, item);
      await Promise.all([repo.process(request), other.process(request), other.process(answer(session, item))]);
      const saved = await progress(id, item.wordId);
      assert.equal(saved.repetitions, 1);
      assert.equal(saved.intervalMinutes, 1440);
      assert.equal(saved.dueAt.getTime() - saved.lastReviewedAt.getTime(), 86400000);
      assert.equal(await db.reviewAttempt.count({ where: { sessionItemId: item.id } }), 1);
      await other.process(request);
      assert.deepEqual(await progress(id, item.wordId), saved);
      const fresh = createDatabaseClient(url);
      try { assert.deepEqual(await fresh.userWordProgress.findUnique({ where: { userId_wordId: { userId: BigInt(id), wordId: item.wordId } } }), saved); }
      finally { await fresh.$disconnect(); }
    });
    await t.test('wrong and revealed words are due after 10 minutes, without success credit', async () => {
      const id = user(), session = await create(id), rows = await items(session);
      await repo.process(answer(session, rows[0], false));
      await other.process(query(session, '1:r'));
      for (const item of rows.slice(0, 2)) {
        const saved = await progress(id, item.wordId);
        assert.equal(saved.repetitions, 0); assert.equal(saved.lapses, 1);
        assert.equal(saved.intervalMinutes, 10); assert.equal(saved.state, 'LEARNING');
      }
    });
    await t.test('one active session: same-mode resumes and cross-mode does not create another', async () => {
      const id = user();
      const results = await Promise.all([repo.create(id, id, 'LEARN', 123), other.create(id, id, 'LEARN', 124)]);
      const first = results.find(r => r.kind === 'widget');
      assert.ok(first); assert.equal(results.filter(r => r.kind === 'message').length, 1);
      await repo.bind(first.id, ++messageId, first.sendToken);
      for (const mode of ['LEARN', 'REVIEW']) {
        const result = await other.create(id, id, mode);
        assert.equal(result.kind, 'message'); assert.match(result.message, /активное занятие изучения новых слов/);
      }
      assert.equal(await db.studySession.count({ where: { userId: BigInt(id), status: 'ACTIVE' } }), 1);
      const retry = await other.create(id, id, 'LEARN', 123);
      assert.equal(retry.kind, 'message');
    });
    await t.test('review selects only due words; progress updates across completed sessions', async () => {
      const id = user(), learn = await create(id), rows = await items(learn);
      for (const item of rows) await repo.process(answer(learn, item));
      const complete = await other.process(query(learn, '9:n'));
      assert.equal(complete.feedback.accuracy, 100);
      assert.equal((await db.studySession.findUnique({ where: { id: learn.id } })).status, 'COMPLETED');
      const empty = await repo.create(id, id, 'REVIEW');
      assert.equal(empty.kind, 'message'); assert.match(empty.message, /нет запланированных повторений/);
      // Only this random test user's rows are made due; no production clock change.
      await db.userWordProgress.updateMany({ where: { userId: BigInt(id), wordId: { in: rows.slice(0, 2).map(i => i.wordId) } }, data: { dueAt: new Date(0), lastReviewedAt: new Date(0) } });
      const review = await create(id, 'REVIEW');
      assert.equal(review.total, 2); assert.equal(review.mode, 'REVIEW');
      for (const mode of ['REVIEW', 'LEARN']) {
        const resumed = await other.create(id, id, mode);
        assert.equal(resumed.kind, 'message'); assert.match(resumed.message, /активное занятие повторения/);
      }
      const reviewItems = await items(review);
      assert.deepEqual(new Set(reviewItems.map(i => i.wordId)), new Set(rows.slice(0, 2).map(i => i.wordId)));
      await repo.process(answer(review, reviewItems[0]));
      assert.equal((await progress(id, reviewItems[0].wordId)).intervalMinutes, 4320);
      await repo.process(answer(review, reviewItems[1], false));
      assert.equal((await progress(id, reviewItems[1].wordId)).repetitions, 0);
      const summary = await other.process(query(review, '1:n'));
      assert.equal(summary.feedback.total, 2); assert.equal(summary.feedback.accuracy, 50);
      const nextLearn = await repo.create(id, id);
      if (nextLearn.kind === 'message') assert.match(nextLearn.message, /Новых слов пока нет/);
      else assert.equal(nextLearn.total, 10); // expanded shared catalog remains available
    });
    await t.test('short new-word sessions and vocabulary exhaustion are friendly', async () => {
      const id = user(); const seen = new Set();
      const session = await create(id), rows = await items(session);
      for (const item of rows.slice(0, 7)) {
        assert.ok(!seen.has(item.wordId)); seen.add(item.wordId);
        await repo.process(query(session, `${item.position}:r`));
      }
      await repo.revoke(session.id);
      assert.equal(seen.size, 7);
      const short = await create(id);
      assert.ok(short.total >= 3 && short.total <= 10);
      if (short.total < 10) assert.match(short.notice, new RegExp(String(short.total)));
      for (const item of await items(short)) {
        assert.ok(!seen.has(item.wordId)); seen.add(item.wordId);
        await repo.process(query(short, `${item.position}:r`));
      }
      const last = String(short.total - 1);
      assert.equal((await repo.process(query(short, `${last}:n`))).feedback.total, short.total);
      assert.equal(seen.size, 7 + short.total);
      const next = await repo.create(id, id);
      if (next.kind === 'message') assert.match(next.message, /Новых слов пока нет/);
      else assert.ok(next.total > 0 && next.total <= 10);
    });
    await t.test('authorization, expiry, stale answers and rollback leave SRS untouched', async () => {
      const id = user(), session = await create(id), [item] = await items(session);
      const forged = await other.process(query(session, '0:a0', { from: { id: id + 1, is_bot: false } }));
      assert.equal(forged.feedback.status, 'error');
      const outOfOrder = await other.process(query(session, '4:a0'));
      assert.equal(outOfOrder.feedback.status, 'error');
      assert.equal(await progress(id, item.wordId), null);
      const rejecting = db.$extends({ query: { widgetQueryReceipt: { async create() { throw new Error('injected receipt failure'); } } } });
      await assert.rejects(new PrismaQuizRepository(() => rejecting).process(answer(session, item)));
      assert.equal(await progress(id, item.wordId), null);
      assert.equal(await db.reviewAttempt.count({ where: { sessionItemId: item.id } }), 0);
      await db.studySession.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await other.process(answer(session, item))).feedback.status, 'expired');
      assert.equal(await progress(id, item.wordId), null);
    });
  } finally {
    try {
      for (const userId of users) await db.$transaction(async tx => {
        await tx.userWordProgress.deleteMany({ where: { userId } });
        await tx.widgetQueryReceipt.deleteMany({ where: { session: { userId } } });
        await tx.reviewAttempt.deleteMany({ where: { item: { session: { userId } } } });
        await tx.sessionItem.deleteMany({ where: { session: { userId } } });
        await tx.learnRequest.deleteMany({ where: { userId } });
        await tx.studySession.deleteMany({ where: { userId } });
        await tx.telegramUser.deleteMany({ where: { id: userId } });
      });
    } finally { await Promise.all([db.$disconnect(), peer.$disconnect()]); }
  }
});
