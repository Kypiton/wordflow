import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { createDatabaseClient } from '../.next/database-tools/src/lib/db/prisma.js';
import { PrismaQuizRepository } from '../.next/database-tools/src/lib/db/quiz-repository.js';
import { seedInitialWord } from '../.next/database-tools/prisma/seed.js';

const url = process.env.TEST_DATABASE_URL;

// Only permit the dedicated Neon test branch.
const isTestDatabase = (() => {
  try {
    const host = new URL(url).hostname;
    return host.startsWith('ep-nameless-hall');
  } catch {
    return false;
  }
})();

const enabled = process.env.WORDFLOW_DB_TESTS === '1' && isTestDatabase;

const randomUserId = () => Number.parseInt(randomBytes(6).toString('hex'), 16) + 1000;

test(
  'WordFlow: persistent 10-word learning sessions',
  {
    skip: enabled
      ? false
      : 'Set TEST_DATABASE_URL to the dedicated Neon test branch and WORDFLOW_DB_TESTS=1.',
  },
  async t => {
    const db = createDatabaseClient(url);
    const peer = createDatabaseClient(url);

    const repo = new PrismaQuizRepository(() => db);
    const other = new PrismaQuizRepository(() => peer);

    const users = new Set();

    let messageCounter = 9000;

    const createUser = () => {
      const userId = randomUserId();
      users.add(BigInt(userId));
      return userId;
    };

    const create = async userId => {
      const session = await repo.create(userId, userId);
      const messageId = ++messageCounter;

      await repo.bind(session.id, messageId);

      return {
        ...session,
        userId,
        messageId,
      };
    };

    const query = (session, action, overrides = {}) => ({
      id: randomBytes(16).toString('hex'),
      from: {
        id: session.userId,
        is_bot: false,
      },
      chat: {
        id: session.userId,
        type: 'private',
      },
      message_id: session.messageId,
      chat_instance: `test-${session.userId}`,
      type: { type: 'data' },
      data: `q:${session.id}:${action}`,
      ...overrides,
    });

    const sessionItems = session =>
      db.sessionItem.findMany({
        where: { sessionId: session.id },
        include: {
          word: {
            include: { options: true },
          },
          attempt: true,
        },
        orderBy: { position: 'asc' },
      });

    const attempts = session =>
      db.reviewAttempt.findMany({
        where: {
          item: { sessionId: session.id },
        },
      });

    try {
      await t.test('Vocabulary seed is idempotent', async () => {
        await seedInitialWord(db);

        const before = await db.word.count();

        await seedInitialWord(peer);

        const after = await db.word.count();

        assert.equal(after, before);
        assert.ok(after >= 10);
      });

      const userId = createUser();
      const session = await create(userId);

      await t.test('Creates 10 distinct persistent questions', async () => {
        const items = await sessionItems(session);

        assert.equal(items.length, 10);

        assert.deepEqual(
          items.map(item => item.position),
          Array.from({ length: 10 }, (_, i) => i),
        );

        assert.equal(new Set(items.map(item => item.wordId)).size, 10);

        for (const item of items) {
          assert.equal(item.word.options.length, 4);

          assert.equal(item.word.options.filter(option => option.isCorrect).length, 1);
        }
      });

      await t.test('Another database connection can read the session', async () => {
        const rows = await peer.sessionItem.count({
          where: { sessionId: session.id },
        });

        assert.equal(rows, 10);

        const response = await other.process(query(session, 's'));

        assert.equal(response.feedback.status, 'question');
        assert.equal(response.feedback.position, 0);
        assert.equal(response.feedback.total, 10);
      });

      await t.test('Rejects forged identity and invalid order', async () => {
        const forged = await repo.process(
          query(session, '0:a0', {
            from: {
              id: userId + 1,
              is_bot: false,
            },
          }),
        );

        assert.equal(forged.feedback.status, 'error');

        const skipped = await repo.process(query(session, '5:a0'));

        assert.equal(skipped.feedback.status, 'error');

        assert.equal((await attempts(session)).length, 0);
      });

      await t.test('Records all 10 answers and advances one question at a time', async () => {
        for (let position = 0; position < 10; position++) {
          const action = position === 2 ? `${position}:r` : `${position}:a0`;

          const request = query(session, action);

          const result = await repo.process(request);

          assert.ok(['answered', 'revealed'].includes(result.feedback.status));

          // The same Telegram query must not create
          // a second attempt.
          const duplicate = await other.process(request);

          assert.deepEqual(duplicate.feedback, result.feedback);

          assert.equal((await attempts(session)).length, position + 1);

          // Answering the previous question cannot
          // advance or change its stored result.
          if (position < 9) {
            const next = await other.process(query(session, `${position}:n`));

            assert.equal(next.feedback.status, 'question');

            assert.equal(next.feedback.position, position + 1);

            const repeatNext = await repo.process(query(session, `${position}:n`));

            assert.equal(repeatNext.feedback.position, position + 1);
          }
        }
      });

      await t.test('Returns completion summary', async () => {
        const result = await repo.process(query(session, '9:n'));

        assert.equal(result.feedback.status, 'completed');
        assert.equal(result.feedback.total, 10);

        const rows = await attempts(session);

        assert.equal(rows.length, 10);

        const correctCount = rows.filter(row => row.correct).length;

        assert.equal(result.feedback.correctCount, correctCount);

        assert.equal(result.feedback.incorrectCount, 10 - correctCount);

        assert.equal(result.feedback.accuracy, correctCount * 10);

        // Reopening the widget must preserve results.
        const restored = await other.process(query(session, 's'));

        assert.equal(restored.feedback.status, 'completed');
      });

      await t.test('Expired sessions cannot record answers', async () => {
        const expiredUserId = createUser();
        const expired = await create(expiredUserId);

        await db.studySession.update({
          where: { id: expired.id },
          data: { expiresAt: new Date(0) },
        });

        const result = await other.process(query(expired, '0:a0'));

        assert.equal(result.feedback.status, 'expired');

        assert.equal((await attempts(expired)).length, 0);
      });

      await t.test('Revoked sessions cannot record answers', async () => {
        const revokedUserId = createUser();
        const revoked = await create(revokedUserId);

        await repo.revoke(revoked.id);

        const result = await other.process(query(revoked, '0:a0'));

        assert.equal(result.feedback.status, 'expired');

        assert.equal((await attempts(revoked)).length, 0);
      });
    } finally {
      try {
        // Cleanup only test-owned random user IDs.
        // Never delete shared vocabulary.
        for (const userId of users) {
          await db.$transaction(async tx => {
            const whereSession = {
              session: { userId },
            };

            await tx.userWordProgress.deleteMany({ where: { userId } });

            await tx.widgetQueryReceipt.deleteMany({
              where: whereSession,
            });

            await tx.reviewAttempt.deleteMany({
              where: {
                item: whereSession,
              },
            });

            await tx.sessionItem.deleteMany({
              where: whereSession,
            });

            await tx.learnRequest.deleteMany({
              where: { userId },
            });

            await tx.studySession.deleteMany({
              where: { userId },
            });

            await tx.telegramUser.deleteMany({
              where: { id: userId },
            });
          });
        }
      } finally {
        await Promise.all([db.$disconnect(), peer.$disconnect()]);
      }
    }
  },
);
