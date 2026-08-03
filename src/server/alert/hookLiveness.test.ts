import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_LIVE_WINDOW_MS,
  getHookLiveness,
  isHookLive,
  recordHookEvent,
  type LivenessStoreLike,
} from "./hookLiveness.js";
import { FORWARDER_REVISION } from "../hooks/forwarder.js";

interface FakeStore extends LivenessStoreLike {
  writes: number;
}

function makeStore(): FakeStore {
  const store: FakeStore = {
    data: { lastEventAt: {}, receipts: {} },
    writes: 0,
    write: async () => {
      store.writes += 1;
    },
  };
  return store;
}

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const INSTALL_ID = "install-abc";

/**
 * A Codex event that arrived `agoMs` ago through the current wiring — the only
 * kind that counts as proof. Tests that want a *disqualified* event override
 * the installId or revision.
 */
function heard(
  store: FakeStore,
  agoMs = 0,
  receipt: { installId?: string; forwarderRevision?: string } = {},
): void {
  const receivedAt = new Date(NOW - agoMs).toISOString();
  store.data.lastEventAt.codex = receivedAt;
  store.data.receipts = {
    codex: {
      receivedAt,
      installId: INSTALL_ID,
      forwarderRevision: FORWARDER_REVISION,
      ...receipt,
    },
  };
}

test("a tool that has never sent a hook event is not live and reports no timestamp", () => {
  const liveness = getHookLiveness("codex", { store: makeStore(), now: NOW });
  assert.equal(liveness.live, false);
  assert.equal(liveness.lastEventAt, undefined);
  assert.equal(liveness.tool, "codex");
  assert.equal(liveness.windowMs, HOOK_LIVE_WINDOW_MS);
});

test("the default liveness window spans a long weekend without flapping", () => {
  const store = makeStore();
  heard(store, 3 * 24 * 60 * 60_000);
  assert.equal(isHookLive("codex", { store, now: NOW, installId: INSTALL_ID }), true);
});

test("an event just inside the window is live and just outside it is not", () => {
  const store = makeStore();
  const windowMs = 60_000;

  heard(store, windowMs - 1);
  assert.equal(isHookLive("codex", { store, now: NOW, windowMs, installId: INSTALL_ID }), true);

  heard(store, windowMs);
  assert.equal(isHookLive("codex", { store, now: NOW, windowMs, installId: INSTALL_ID }), false);
});

test("an unparseable stored timestamp reads as not live rather than throwing", () => {
  const store = makeStore();
  store.data.lastEventAt.codex = "not-a-date";
  assert.equal(isHookLive("codex", { store, now: NOW, installId: INSTALL_ID }), false);
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

/**
 * Qualification — the reason a timestamp alone is no longer enough.
 *
 * The failure these close: hooks fire once, the install then breaks (an app
 * upgrade moves the script, a repair rewrites the definition, the user removes
 * them), and for the rest of the seven-day window the dashboard keeps saying
 * "Connected — events are arriving" on the strength of that one old event.
 */

test("an event from a previous install does not vouch for the current one", () => {
  const store = makeStore();
  heard(store, 60_000, { installId: "the-install-that-broke" });

  const liveness = getHookLiveness("codex", { store, now: NOW, installId: INSTALL_ID });

  assert.equal(liveness.live, false);
  assert.equal(liveness.disqualifiedBy, "stale-install");
  // Still reported, because "we last heard from Codex a minute ago, through
  // wiring that no longer exists" is exactly what the user needs told.
  assert.equal(liveness.lastEventAt, new Date(NOW - 60_000).toISOString());
});

test("an event from an unsupported forwarder revision does not count", () => {
  const store = makeStore();
  heard(store, 60_000, { forwarderRevision: "1" });

  const liveness = getHookLiveness("codex", { store, now: NOW, installId: INSTALL_ID });

  assert.equal(liveness.live, false);
  assert.equal(liveness.disqualifiedBy, "unsupported-forwarder");
});

test("a receipt-less event does not count for Codex, which always has a forwarder", () => {
  const store = makeStore();
  store.data.lastEventAt.codex = new Date(NOW - 60_000).toISOString();

  const liveness = getHookLiveness("codex", { store, now: NOW, installId: INSTALL_ID });

  assert.equal(liveness.live, false);
  // No receipt at all cannot have come from the install we are asking about —
  // that is a stale install, not merely an old script.
  assert.equal(liveness.disqualifiedBy, "stale-install");
});

test("with no install id on disk, only the forwarder revision can disqualify", () => {
  const store = makeStore();
  heard(store, 60_000, { installId: "whatever" });

  // The window between upgrading into receipts and the first boot writing an
  // id: we have nothing to compare against, so we must not call it stale.
  assert.equal(getHookLiveness("codex", { store, now: NOW, installId: undefined }).live, true);

  store.data.receipts!.codex!.forwarderRevision = "0";
  const old = getHookLiveness("codex", { store, now: NOW, installId: undefined });
  assert.equal(old.live, false);
  assert.equal(old.disqualifiedBy, "unsupported-forwarder");
});

test("Claude is never disqualified — its hook posts directly, with nothing to stamp", () => {
  const store = makeStore();
  store.data.lastEventAt.claude = new Date(NOW - 60_000).toISOString();

  const liveness = getHookLiveness("claude", { store, now: NOW, installId: INSTALL_ID });

  assert.equal(liveness.live, true);
  assert.equal(liveness.disqualifiedBy, undefined);
});

test("an old event is reported as out-of-window, not as disqualified", () => {
  const store = makeStore();
  heard(store, HOOK_LIVE_WINDOW_MS + 1, { installId: "some-old-install" });

  const liveness = getHookLiveness("codex", { store, now: NOW, installId: INSTALL_ID });

  assert.equal(liveness.live, false);
  // Only recent events get a disqualification reason; an old one is simply old,
  // and saying "stale install" about it would be guessing.
  assert.equal(liveness.disqualifiedBy, undefined);
});

test("recording keeps the receipt alongside the timestamp", async () => {
  const store = makeStore();

  await recordHookEvent("codex", {
    store,
    now: NOW,
    receipt: { installId: INSTALL_ID, forwarderRevision: FORWARDER_REVISION, eventName: "SessionStart" },
  });

  assert.deepEqual(store.data.receipts?.codex, {
    receivedAt: new Date(NOW).toISOString(),
    installId: INSTALL_ID,
    forwarderRevision: FORWARDER_REVISION,
    eventName: "SessionStart",
  });
  assert.equal(isHookLive("codex", { store, now: NOW, installId: INSTALL_ID }), true);
});

test("the first event through new wiring is never coalesced away", async () => {
  const store = makeStore();
  const receipt = { installId: "old-install", forwarderRevision: FORWARDER_REVISION };
  await recordHookEvent("codex", { store, now: NOW, receipt });
  assert.equal(store.writes, 1);

  // Inside the coalescing window, but it is the proof that a repair worked —
  // dropping it would leave the dashboard saying "waiting for verification"
  // for up to a minute after verification had actually happened.
  await recordHookEvent("codex", {
    store,
    now: NOW + 5_000,
    receipt: { installId: INSTALL_ID, forwarderRevision: FORWARDER_REVISION },
  });

  assert.equal(store.writes, 2);
  assert.equal(store.data.receipts?.codex?.installId, INSTALL_ID);
  assert.equal(isHookLive("codex", { store, now: NOW + 5_000, installId: INSTALL_ID }), true);
});

test("repeat events through unchanged wiring still coalesce", async () => {
  const store = makeStore();
  const receipt = { installId: INSTALL_ID, forwarderRevision: FORWARDER_REVISION };

  await recordHookEvent("codex", { store, now: NOW, receipt });
  await recordHookEvent("codex", { store, now: NOW + 30_000, receipt });

  assert.equal(store.writes, 1);
});
