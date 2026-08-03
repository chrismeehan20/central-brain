import { test } from "node:test";
import assert from "node:assert/strict";
import { DIGEST_MAX_AGE_MS, isDigestFresh } from "./digest.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

/** A stored digest generated `ms` before NOW. */
function agedBy(ms: number) {
  return { generatedAt: new Date(NOW.getTime() - ms).toISOString() };
}

const HOUR = 60 * 60_000;

test("a digest generated just now is fresh", () => {
  assert.equal(isDigestFresh(agedBy(0), NOW), true);
  assert.equal(isDigestFresh(agedBy(5 * 60_000), NOW), true);
});

test("47h59m old is still fresh", () => {
  assert.equal(isDigestFresh(agedBy(47 * HOUR + 59 * 60_000), NOW), true);
});

test("48h01m old is stale", () => {
  assert.equal(isDigestFresh(agedBy(48 * HOUR + 60_000), NOW), false);
});

test("the cutoff is 48 hours, inclusive", () => {
  assert.equal(DIGEST_MAX_AGE_MS, 48 * HOUR);
  assert.equal(isDigestFresh(agedBy(DIGEST_MAX_AGE_MS), NOW), true);
  assert.equal(isDigestFresh(agedBy(DIGEST_MAX_AGE_MS + 1), NOW), false);
});

test("a digest with no generatedAt is never fresh", () => {
  // This is the shape the cap/error fallback persists — it was never generated.
  assert.equal(isDigestFresh({ generatedAt: "" }, NOW), false);
});

test("an unparseable generatedAt is never fresh", () => {
  assert.equal(isDigestFresh({ generatedAt: "not a timestamp" }, NOW), false);
});

test("an absent digest is never fresh", () => {
  assert.equal(isDigestFresh(null, NOW), false);
  assert.equal(isDigestFresh(undefined, NOW), false);
});

test("now defaults to the current time", () => {
  assert.equal(isDigestFresh({ generatedAt: new Date().toISOString() }), true);
  assert.equal(isDigestFresh({ generatedAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString() }), false);
});
