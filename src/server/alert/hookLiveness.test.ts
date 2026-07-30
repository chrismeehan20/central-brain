import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_LIVE_WINDOW_MS,
  getHookLiveness,
  isHookLive,
  recordHookEvent,
  type LivenessStoreLike,
} from "./hookLiveness.js";

interface FakeStore extends LivenessStoreLike {
  writes: number;
}

function makeStore(): FakeStore {
  const store: FakeStore = {
    data: { lastEventAt: {} },
    writes: 0,
    write: async () => {
      store.writes += 1;
    },
  };
  return store;
}

const NOW = Date.parse("2026-07-29T12:00:00.000Z");

test("a tool that has never sent a hook event is not live and reports no timestamp", () => {
  const liveness = getHookLiveness("codex", { store: makeStore(), now: NOW });
  assert.equal(liveness.live, false);
  assert.equal(liveness.lastEventAt, undefined);
  assert.equal(liveness.tool, "codex");
  assert.equal(liveness.windowMs, HOOK_LIVE_WINDOW_MS);
});

test("the default liveness window spans a long weekend without flapping", () => {
  const store = makeStore();
  store.data.lastEventAt.codex = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
  assert.equal(isHookLive("codex", { store, now: NOW }), true);
});

test("an event just inside the window is live and just outside it is not", () => {
  const store = makeStore();
  const windowMs = 60_000;

  store.data.lastEventAt.codex = new Date(NOW - (windowMs - 1)).toISOString();
  assert.equal(isHookLive("codex", { store, now: NOW, windowMs }), true);

  store.data.lastEventAt.codex = new Date(NOW - windowMs).toISOString();
  assert.equal(isHookLive("codex", { store, now: NOW, windowMs }), false);
});

test("an unparseable stored timestamp reads as not live rather than throwing", () => {
  const store = makeStore();
  store.data.lastEventAt.codex = "not-a-date";
  assert.equal(isHookLive("codex", { store, now: NOW }), false);
});

test("recording coalesces writes within a minute but always advances past it", async () => {
  const store = makeStore();

  await recordHookEvent("codex", { store, now: NOW });
  assert.equal(store.writes, 1);
  assert.equal(store.data.lastEventAt.codex, new Date(NOW).toISOString());

  // Claude fires a hook every ~60s per idle session; don't rewrite the file for
  // a value only ever compared against a multi-day window.
  await recordHookEvent("codex", { store, now: NOW + 30_000 });
  assert.equal(store.writes, 1);
  assert.equal(store.data.lastEventAt.codex, new Date(NOW).toISOString());

  await recordHookEvent("codex", { store, now: NOW + 60_000 });
  assert.equal(store.writes, 2);
  assert.equal(store.data.lastEventAt.codex, new Date(NOW + 60_000).toISOString());
});

test("a stored timestamp in the future is corrected instead of sticking", async () => {
  const store = makeStore();
  store.data.lastEventAt.codex = new Date(NOW + 10 * 60_000).toISOString();

  await recordHookEvent("codex", { store, now: NOW });

  assert.equal(store.data.lastEventAt.codex, new Date(NOW).toISOString());
  assert.equal(store.writes, 1);
});
