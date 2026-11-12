import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleReview, isDue } from "../.next/telegram-tests/lib/srs/scheduler.js";

const now = new Date("2026-11-12T23:55:00.000Z");
test("first correct and every consecutive interval/state are deterministic", () => {
  let previous = null;
  for (const [i, days] of [1, 3, 7, 14, 30, 30, 30].entries()) {
    const result = scheduleReview(previous, "correct", now);
    assert.equal(result.repetitions, i + 1);
    assert.equal(result.intervalMinutes, days * 1440);
    assert.equal(result.dueAt.toISOString(), new Date(now.getTime() + days * 86400000).toISOString());
    assert.equal(result.state, i >= 4 ? "MASTERED" : i >= 1 ? "REVIEW" : "LEARNING");
    assert.equal(result.lapses, 0);
    previous = result;
  }
});
test("wrong and revealed answers reset repetition/interval and count a lapse", () => {
  for (const outcome of ["incorrect", "revealed"]) {
    for (const previous of [null, { repetitions: 6, lapses: 2 }]) {
      const result = scheduleReview(previous, outcome, now);
      assert.equal(result.repetitions, 0);
      assert.equal(result.lapses, (previous?.lapses ?? 0) + 1);
      assert.equal(result.state, "LEARNING");
      assert.equal(result.intervalMinutes, 10);
      assert.equal(result.dueAt.toISOString(), "2026-11-13T00:05:00.000Z");
      const recovery = scheduleReview(result, "correct", now);
      assert.equal(recovery.intervalMinutes, 1440);
      assert.equal(recovery.repetitions, 1);
      assert.equal(recovery.lapses, result.lapses);
    }
  }
});
test("UTC duration calculation crosses month/year/leap-day and DST without local-time drift", () => {
  for (const [start, due] of [
    ["2026-12-31T23:30:00Z", "2027-01-01T23:30:00.000Z"],
    ["2028-02-28T12:00:00Z", "2028-02-29T12:00:00.000Z"],
    ["2026-03-29T01:30:00+02:00", "2026-03-29T23:30:00.000Z"],
  ]) assert.equal(scheduleReview(null, "correct", new Date(start)).dueAt.toISOString(), due);
});
test("due boundary includes equality, excludes future dates, and does not mutate inputs", () => {
  const result = scheduleReview(null, "correct", now);
  assert.equal(isDue(result.dueAt, new Date(result.dueAt.getTime() - 1)), false);
  assert.equal(isDue(result.dueAt, result.dueAt), true);
  assert.equal(isDue(result.dueAt, new Date(result.dueAt.getTime() + 1)), true);
  result.lastReviewedAt.setUTCFullYear(2000);
  assert.equal(now.toISOString(), "2026-11-12T23:55:00.000Z");
  assert.throws(() => scheduleReview(null, "correct", new Date("invalid")));
  assert.throws(() => scheduleReview({ repetitions: -1, lapses: 0 }, "correct", now));
});
