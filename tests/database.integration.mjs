import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createDatabaseClient } from "../.next/database-tools/src/lib/db/prisma.js";
import { PrismaQuizRepository } from "../.next/database-tools/src/lib/db/quiz-repository.js";
import { seedInitialWord } from "../.next/database-tools/prisma/seed.js";

// Opt-in only. Does not create/reset/migrate a database. Never falls back to DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url) && process.env.WORDFLOW_DB_TESTS === "1";

test("PostgreSQL persistence, isolation, authorization and idempotency", {
  skip: enabled ? false : "Provision a dedicated DB, apply migrations, then set TEST_DATABASE_URL and WORDFLOW_DB_TESTS=1.",
}, async t => {
  const db = createDatabaseClient(url);
  const peer = createDatabaseClient(url);
  const repo = new PrismaQuizRepository(() => db);
  const other = new PrismaQuizRepository(() => peer);
  // Unique test-owned user. Cleanup deletes only records linked to this id.
  const userId = Number(BigInt(`0x${randomBytes(6).toString("hex")}`)) + 1000;
  let messageId = 100;
  const query = (session, action = "a2", changes = {}) => ({
    id: randomBytes(16).toString("hex"), from: { id: userId, is_bot: false },
    chat: { id: userId, type: "private" }, message_id: session.messageId,
    chat_instance: `test-${userId}`, type: { type: "data" }, data: `q:${session.id}:${action}`, ...changes,
  });
  const create = async () => {
    const session = await repo.create(userId, userId);
    const id = ++messageId;
    await repo.bind(session.id, id);
    return { ...session, messageId: id };
  };
  const attempts = session => db.reviewAttempt.findMany({ where: { item: { sessionId: session.id } } });
  try {
    await t.test("seed is idempotent and normalized", async () => {
      await seedInitialWord(db);
      const before = await db.word.findUnique({ where: { slug_version: { slug: "reluctant", version: 1 } }, include: { options: true } });
      await seedInitialWord(peer);
      const after = await db.word.findUnique({ where: { slug_version: { slug: "reluctant", version: 1 } }, include: { options: true } });
      assert.equal(after.id, before.id);
      assert.equal(after.options.length, 4);
      assert.equal(after.options.filter(o => o.isCorrect).length, 1);
    });
    await t.test("another client and a fresh client see the same session and attempt", async () => {
      const session = await create();
      assert.equal((await other.process(query(session))).feedback.correct, true);
      const fresh = createDatabaseClient(url);
      try {
        const restored = new PrismaQuizRepository(() => fresh);
        const result = await restored.process(query(session, "a0"));
        assert.equal(result.feedback.selected, 2);
        assert.equal(result.feedback.correct, true);
        assert.equal((await attempts(session)).length, 1);
      } finally { await fresh.$disconnect(); }
    });
    await t.test("concurrent duplicate query ids and changed choices insert one review", async () => {
      const session = await create();
      const first = query(session);
      await Promise.all([repo.process(first), other.process(first), other.process(query(session, "a0"))]);
      const rows = await attempts(session);
      assert.equal(rows.length, 1);
      const result = await repo.process(query(session));
      assert.equal(result.feedback.selected, rows[0].selectedPosition);
      assert.equal(result.feedback.correct, rows[0].correct);
      assert.equal(await db.widgetQueryReceipt.count({ where: { id: first.id } }), 1);
      await repo.delivered(first.id);
      assert.equal((await other.process(first)).delivered, true);
      const conflict = await other.process({ ...first, data: `q:${session.id}:r` });
      assert.equal(conflict.feedback.status, "error");
    });
    await t.test("forged owner, chat, message, instance and malformed action are rejected", async () => {
      const session = await create();
      for (const changes of [
        { from: { id: userId + 1, is_bot: false }, chat: { id: userId + 1, type: "private" } },
        { message_id: session.messageId + 1 }, { data: `q:${session.id}:a4` },
      ]) assert.equal((await repo.process(query(session, "a2", changes))).feedback.status, "error");
      assert.equal((await attempts(session)).length, 0);
      await repo.process(query(session));
      assert.equal((await other.process(query(session, "r", { chat_instance: "forged" }))).feedback.status, "error");
      assert.equal((await attempts(session)).length, 1);
    });
    await t.test("unknown, expired, revoked and unbound sessions fail closed", async () => {
      const session = await create();
      await db.studySession.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await other.process(query(session))).feedback.status, "expired");
      assert.equal((await attempts(session)).length, 0);
      const revoked = await create(); await repo.revoke(revoked.id);
      assert.equal((await other.process(query(revoked))).feedback.status, "expired");
      const unbound = await repo.create(userId, userId);
      assert.equal((await other.process(query({ ...unbound, messageId: 999 }))).feedback.status, "error");
      assert.equal((await other.process(query({ id: randomBytes(12).toString("hex"), messageId: 999 }))).feedback.status, "expired");
    });
    await t.test("reveal before answering never awards credit; reveal after answer preserves it", async () => {
      const first = await create();
      await repo.process(query(first, "r"));
      const revealed = await other.process(query(first));
      assert.equal(revealed.feedback.selected, null);
      assert.equal(revealed.feedback.correct, false);
      assert.equal(revealed.feedback.answer, "Неохотный");
      assert.equal((await attempts(first)).length, 1);
      const second = await create();
      await other.process(query(second));
      assert.equal((await repo.process(query(second, "r"))).feedback.correct, true);
      const race = await create();
      await Promise.all([repo.process(query(race, "r")), other.process(query(race))]);
      const [attempt] = await attempts(race);
      const outcome = await other.process(query(race));
      assert.equal((await attempts(race)).length, 1);
      assert.equal(outcome.feedback.status, "revealed");
      assert.equal(outcome.feedback.correct, attempt.selectedPosition === 2);
    });
    await t.test("receipt collision rolls back any attempt, and UNIQUE blocks a second review", async () => {
      const first = await create(); const second = await create();
      const original = query(first); await repo.process(original);
      // A reused query id from a different session is refused before any mutation.
      assert.equal((await repo.process(query(second, "a2", { id: original.id }))).feedback.status, "error");
      assert.equal((await attempts(second)).length, 0);
      const item = await db.sessionItem.findUnique({ where: { sessionId_position: { sessionId: first.id, position: 0 } } });
      await assert.rejects(db.reviewAttempt.create({ data: { sessionItemId: item.id, selectedPosition: 0, correct: false } }), e => e.code === "P2002");
    });
    await t.test("a transaction failure rolls back both attempt and receipt", async () => {
      const session = await create();
      const rejecting = db.$extends({ query: { widgetQueryReceipt: { async create() { throw new Error("simulated write failure"); } } } });
      const failing = new PrismaQuizRepository(() => rejecting);
      await assert.rejects(failing.process(query(session)), /simulated write failure/);
      assert.equal((await attempts(session)).length, 0);
      assert.equal(await db.widgetQueryReceipt.count({ where: { sessionId: session.id } }), 0);
      assert.equal((await repo.process(query(session))).feedback.correct, true);
    });
  } finally {
    // Only test-created rows for the random user; shared idempotent seed is retained.
    try {
      await db.$transaction(async tx => {
        await tx.widgetQueryReceipt.deleteMany({ where: { session: { userId: BigInt(userId) } } });
        await tx.reviewAttempt.deleteMany({ where: { item: { session: { userId: BigInt(userId) } } } });
        await tx.sessionItem.deleteMany({ where: { session: { userId: BigInt(userId) } } });
        await tx.studySession.deleteMany({ where: { userId: BigInt(userId) } });
        await tx.telegramUser.deleteMany({ where: { id: BigInt(userId) } });
      });
    } finally { await Promise.all([db.$disconnect(), peer.$disconnect()]); }
  }
});
