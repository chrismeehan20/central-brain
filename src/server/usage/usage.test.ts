import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USAGE_WINDOW_MS,
  estimateWindow,
  recordUsageInstants,
  type UsageStoreLike,
} from "./usage.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const H = 60 * 60 * 1000;

function memStore(instants: string[] = []): UsageStoreLike & { writes: number } {
  const store = {
    data: { instants },
    writes: 0,
    async write() {
      store.writes += 1;
    },
  };
  return store;
}

test("estimateWindow with no data reports no window", () => {
  const w = estimateWindow([], NOW);
  assert.equal(w.active, false);
  assert.equal(w.windowStart, undefined);
});

test("estimateWindow: first activity opens the window; later activity inside it does not move it", () => {
  const w = estimateWindow(
    [new Date(NOW - 2 * H).toISOString(), new Date(NOW - 1 * H).toISOString()],
    NOW,
  );
  assert.equal(w.active, true);
  assert.equal(w.windowStart, new Date(NOW - 2 * H).toISOString());
  assert.equal(w.remainingMs, USAGE_WINDOW_MS - 2 * H);
});

test("estimateWindow: activity after expiry opens a new window", () => {
  const w = estimateWindow(
    [new Date(NOW - 7 * H).toISOString(), new Date(NOW - 1 * H).toISOString()],
    NOW,
  );
  assert.equal(w.windowStart, new Date(NOW - 1 * H).toISOString());
});

test("estimateWindow: activity exactly at expiry starts the next window", () => {
  const start = NOW - USAGE_WINDOW_MS - H;
  const w = estimateWindow(
    [new Date(start).toISOString(), new Date(start + USAGE_WINDOW_MS).toISOString()],
    NOW,
  );
  assert.equal(w.windowStart, new Date(start + USAGE_WINDOW_MS).toISOString());
  assert.equal(w.active, true);
});

test("estimateWindow: an expired window with no activity since reports inactive but keeps the boundary", () => {
  const w = estimateWindow([new Date(NOW - 6 * H).toISOString()], NOW);
  assert.equal(w.active, false);
  assert.equal(w.windowEnd, new Date(NOW - 6 * H + USAGE_WINDOW_MS).toISOString());
  assert.equal(w.remainingMs, undefined);
});

test("recordUsageInstants dedupes to the minute and skips silent no-ops", async () => {
  const store = memStore();
  await recordUsageInstants([NOW - 30_000, NOW - 20_000], { store, now: NOW });
  assert.equal(store.data.instants.length, 1);
  assert.equal(store.writes, 1);
  await recordUsageInstants([NOW - 10_000], { store, now: NOW });
  assert.equal(store.writes, 1); // same minute again: no write
});

test("recordUsageInstants rejects the future and prunes past retention", async () => {
  const store = memStore([new Date(NOW - 8 * 24 * H).toISOString()]);
  await recordUsageInstants([NOW + 10 * 60_000], { store, now: NOW });
  // Future instant skipped; the stale one pruned.
  assert.deepEqual(store.data.instants, []);
});
