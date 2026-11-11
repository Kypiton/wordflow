import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaQuizRepository } from "../.next/telegram-tests/lib/db/quiz-repository.js";
import { createDatabaseClient, getDatabase } from "../.next/telegram-tests/lib/db/prisma.js";
import { parseQuizAction, quizFeedback } from "../.next/telegram-tests/lib/telegram/quiz-domain.js";

test("missing/invalid database configuration fails without attempting a connection", () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => getDatabase(), /Database is not configured/);
    assert.throws(() => createDatabaseClient("https://invalid.example"), /Database is not configured/);
  } finally {
    if (original !== undefined) process.env.DATABASE_URL = original;
  }
});
test("repository rejects invalid identities/actions before acquiring a database", async () => {
  const repo = new PrismaQuizRepository(() => { throw Error("must not access database"); });
  const base = { id: "q", from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" },
    message_id: 1, chat_instance: "test", type: { type: "data" }, data: `q:${"a".repeat(24)}:a2` };
  for (const value of [null, {}, { ...base, from: { id: 43, is_bot: false } },
    { ...base, chat: { id: 42, type: "group" } }, { ...base, data: "invalid" },
    { ...base, inline_message_id: "inline" }, { ...base, data: `q:${"a".repeat(24)}:a4` }]) {
    assert.equal((await repo.process(value)).feedback.status, "error");
  }
  await assert.rejects(repo.create(42, 43), /Invalid quiz owner/);
  await assert.rejects(repo.bind("a".repeat(24), 0), /Invalid message/);
});
test("pure feedback preserves committed outcomes and reveals only on request", () => {
  const answer = { position: 2, text: "Неохотный" };
  assert.deepEqual(quizFeedback({ selectedPosition: 0, correct: false }, false, answer), {
    status: "answered", selected: 0, correct: false,
  });
  assert.deepEqual(quizFeedback({ selectedPosition: null, correct: false }, true, answer), {
    status: "revealed", selected: null, correct: false, correctIndex: 2, answer: "Неохотный",
  });
  assert.equal(parseQuizAction(`q:${"a".repeat(24)}:r`).selected, null);
  assert.equal(parseQuizAction(`q:${"a".repeat(24)}:a0`).selected, 0);
  assert.equal(parseQuizAction(`q:${"a".repeat(24)}:a2:extra`), null);
});
