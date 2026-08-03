import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AttentionItem } from "@shared/types.js";
import type { NotifyOptions } from "./notifier.js";
import {
  dismissAttentionItem,
  handleHookEvent,
  snoozeAttentionItem,
  type AttentionStoreLike,
  type HookHandlerDeps,
} from "./attention.js";
import { getHookLiveness, type LivenessStoreLike } from "./hookLiveness.js";
import { FORWARDER_REVISION } from "../hooks/forwarder.js";

/**
 * Every test here passes its own in-memory stores, so nothing touches
 * data/attention.json or data/hook-liveness.json, and `notify` is stubbed so no
 * desktop notification is ever fired.
 */
interface FakeStore extends AttentionStoreLike {
  writes: number;
}

function makeStore(items: AttentionItem[] = []): FakeStore {
  const store: FakeStore = {
    data: { items },
    writes: 0,
    write: async () => {
      store.writes += 1;
    },
  };
  return store;
}

interface FakeLiveness extends LivenessStoreLike {
  writes: number;
}

function makeLivenessStore(): FakeLiveness {
  const store: FakeLiveness = {
    data: { lastEventAt: {} },
    writes: 0,
    write: async () => {
      store.writes += 1;
    },
  };
  return store;
}

interface Harness {
  store: FakeStore;
  liveness: FakeLiveness;
  notifications: NotifyOptions[];
  emitted: AttentionItem[][];
  deps: HookHandlerDeps;
}

const INSTALL_ID = "attention-test-install";
const RECEIPT = { installId: INSTALL_ID, forwarderRevision: FORWARDER_REVISION };

function makeHarness(items: AttentionItem[] = [], now?: number): Harness {
  const store = makeStore(items);
  const liveness = makeLivenessStore();
  const notifications: NotifyOptions[] = [];
  const emitted: AttentionItem[][] = [];
  return {
    store,
    liveness,
    notifications,
    emitted,
    deps: {
      store,
      livenessStore: liveness,
      // The real Codex route reads these off the forwarder's headers; liveness
      // only counts an event that carries them.
      receipt: RECEIPT,
      notify: async (opts) => {
        notifications.push(opts);
      },
      emit: (items) => {
        emitted.push([...items]);
      },
      ...(now !== undefined ? { now } : {}),
    },
  };
}

const CWD = "/Users/someone/code/widget";

test("a Codex PermissionRequest creates a high-priority permission item tagged tool: codex", async () => {
  const h = makeHarness();

  await handleHookEvent(
    { session_id: "codex-1", cwd: CWD, hook_event_name: "PermissionRequest", tool_name: "shell" },
    "codex",
    h.deps
  );

  assert.equal(h.store.data.items.length, 1);
  const item = h.store.data.items[0];
  assert.equal(item.id, "codex-1:permission");
  assert.equal(item.tool, "codex");
  assert.equal(item.type, "permission");
  assert.equal(item.priority, "high");
  assert.equal(item.message, "Wants to run: shell");
  assert.equal(item.projectPath, path.resolve(CWD));
  assert.equal(h.store.writes, 1);
  assert.equal(h.emitted.length, 1);
  // Notified once, because the item was newly created.
  assert.deepEqual(h.notifications, [{ title: "Codex needs your OK", body: path.resolve(CWD), sound: true }]);
});

test("a repeated Codex PermissionRequest refreshes the item without notifying again", async () => {
  const h = makeHarness();
  const payload = { session_id: "codex-1", cwd: CWD, hook_event_name: "PermissionRequest", tool_name: "shell" };

  await handleHookEvent(payload, "codex", h.deps);
  await handleHookEvent(payload, "codex", h.deps);

  assert.equal(h.store.data.items.length, 1);
  assert.equal(h.notifications.length, 1, "only a NEWLY created item may notify");
});

test("a Codex Stop clears that session's items and leaves other sessions alone", async () => {
  const h = makeHarness();

  await handleHookEvent(
    { session_id: "codex-1", cwd: CWD, hook_event_name: "PermissionRequest" },
    "codex",
    h.deps
  );
  await handleHookEvent(
    { session_id: "codex-2", cwd: "/Users/someone/code/other", hook_event_name: "PermissionRequest" },
    "codex",
    h.deps
  );
  assert.equal(h.store.data.items.length, 2);

  await handleHookEvent({ session_id: "codex-1", cwd: CWD, hook_event_name: "Stop" }, "codex", h.deps);

  assert.deepEqual(
    h.store.data.items.map((i) => i.sessionId),
    ["codex-2"]
  );
  // Stop is silent: it must not add a notification of its own.
  assert.equal(h.notifications.length, 2);
});

test("a Codex Stop also retires a codex-maybe-waiting flag left by the heuristic", async () => {
  const now = new Date("2026-07-29T12:00:00.000Z").toISOString();
  const h = makeHarness([
    {
      id: "codex-1:codex-maybe",
      sessionId: "codex-1",
      projectPath: path.resolve(CWD),
      tool: "codex",
      type: "codex-maybe-waiting",
      priority: "low",
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await handleHookEvent({ session_id: "codex-1", cwd: CWD, hook_event_name: "Stop" }, "codex", h.deps);

  assert.deepEqual(h.store.data.items, []);
});

test("Claude events are unchanged: PermissionRequest is high priority, tool: claude, same notification", async () => {
  const h = makeHarness();

  await handleHookEvent(
    { session_id: "claude-1", cwd: CWD, hook_event_name: "PermissionRequest", tool_name: "Bash" },
    "claude",
    h.deps
  );

  const item = h.store.data.items[0];
  assert.equal(item.tool, "claude");
  assert.equal(item.type, "permission");
  assert.equal(item.priority, "high");
  assert.equal(item.message, "Wants to run: Bash");
  assert.deepEqual(h.notifications, [{ title: "Needs your OK", body: path.resolve(CWD), sound: true }]);
});

test("Claude Notification still creates a medium-priority waiting item with its own message", async () => {
  const h = makeHarness();

  await handleHookEvent(
    { session_id: "claude-1", cwd: CWD, hook_event_name: "Notification", message: "Claude is waiting" },
    "claude",
    h.deps
  );

  const item = h.store.data.items[0];
  assert.equal(item.id, "claude-1:waiting");
  assert.equal(item.tool, "claude");
  assert.equal(item.type, "waiting");
  assert.equal(item.priority, "medium");
  assert.equal(item.message, "Claude is waiting");
  assert.deepEqual(h.notifications, [{ title: "Waiting on you", body: path.resolve(CWD), sound: false }]);
});

test("Claude UserPromptSubmit still clears the session", async () => {
  const h = makeHarness();

  await handleHookEvent(
    { session_id: "claude-1", cwd: CWD, hook_event_name: "PermissionRequest" },
    "claude",
    h.deps
  );
  await handleHookEvent(
    { session_id: "claude-1", cwd: CWD, hook_event_name: "UserPromptSubmit" },
    "claude",
    h.deps
  );

  assert.deepEqual(h.store.data.items, []);
});

test("an uninteresting event persists nothing and broadcasts nothing", async () => {
  const h = makeHarness();

  await handleHookEvent(
    { session_id: "codex-1", cwd: CWD, hook_event_name: "PreToolUse", tool_name: "shell" },
    "codex",
    h.deps
  );

  assert.deepEqual(h.store.data.items, []);
  assert.equal(h.store.writes, 0);
  assert.equal(h.emitted.length, 0);
});

test("any Codex hook event — even an ignored one — records Codex hook liveness", async () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  const h = makeHarness([], now);

  await handleHookEvent({ session_id: "codex-1", cwd: CWD, hook_event_name: "PreToolUse" }, "codex", h.deps);

  assert.equal(h.liveness.data.lastEventAt.codex, "2026-07-29T12:00:00.000Z");
  assert.equal(
    getHookLiveness("codex", { store: h.liveness, now, windowMs: 1000, installId: INSTALL_ID }).live,
    true
  );
  // Claude's slot is untouched — liveness is per tool.
  assert.equal(h.liveness.data.lastEventAt.claude, undefined);
});

test("a Claude hook event does not make Codex hooks look live", async () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  const h = makeHarness([], now);

  await handleHookEvent({ session_id: "claude-1", cwd: CWD, hook_event_name: "Stop" }, "claude", h.deps);

  assert.equal(h.liveness.data.lastEventAt.claude, "2026-07-29T12:00:00.000Z");
  assert.equal(getHookLiveness("codex", { store: h.liveness, now }).live, false);
});

/* ---- user-driven snooze / dismiss ---- */

const NOON = Date.parse("2026-07-29T12:00:00.000Z");

function maybeWaitingItem(): AttentionItem {
  const iso = new Date(NOON).toISOString();
  return {
    id: "codex-1:codex-maybe",
    sessionId: "codex-1",
    projectPath: path.resolve(CWD),
    tool: "codex",
    type: "codex-maybe-waiting",
    priority: "low",
    createdAt: iso,
    updatedAt: iso,
  };
}

test("snoozing an item stamps snoozedUntil an hour out, keeps the item, and broadcasts", async () => {
  const h = makeHarness([], NOON);
  await handleHookEvent(
    { session_id: "claude-1", cwd: CWD, hook_event_name: "PermissionRequest" },
    "claude",
    h.deps
  );
  const emittedBefore = h.emitted.length;

  assert.equal(await snoozeAttentionItem("claude-1:permission", 60, h.deps), true);

  assert.equal(h.store.data.items.length, 1, "a snooze hides the row, it does not delete it");
  const item = h.store.data.items[0];
  assert.equal(item.snoozedUntil, "2026-07-29T13:00:00.000Z");
  assert.equal(item.updatedAt, "2026-07-29T12:00:00.000Z");
  assert.equal(h.emitted.length, emittedBefore + 1);
});

test("dismissing a permission item removes it outright", async () => {
  const h = makeHarness([], NOON);
  await handleHookEvent(
    { session_id: "claude-1", cwd: CWD, hook_event_name: "PermissionRequest" },
    "claude",
    h.deps
  );

  assert.equal(await dismissAttentionItem("claude-1:permission", h.deps), true);

  assert.deepEqual(h.store.data.items, []);
  assert.deepEqual(h.emitted.at(-1), []);
});

test("dismissing a heuristic codex-maybe-waiting item snoozes it 24h instead of removing it", async () => {
  // Removal would not stick: the staleness poller re-creates any missing id
  // while the rollout file stays quiet inside its 5min–1h window.
  const h = makeHarness([maybeWaitingItem()], NOON);

  assert.equal(await dismissAttentionItem("codex-1:codex-maybe", h.deps), true);

  assert.equal(h.store.data.items.length, 1);
  assert.equal(h.store.data.items[0].snoozedUntil, "2026-07-30T12:00:00.000Z");
  assert.equal(h.store.writes, 1);
  assert.equal(h.emitted.length, 1);
});

test("snoozing or dismissing an id that no longer exists is a no-op, not a write", async () => {
  const h = makeHarness([], NOON);

  assert.equal(await snoozeAttentionItem("ghost:permission", 60, h.deps), false);
  assert.equal(await dismissAttentionItem("ghost:permission", h.deps), false);

  assert.equal(h.store.writes, 0);
  assert.equal(h.emitted.length, 0);
});

test("a re-fired hook event un-hides a snoozed item", async () => {
  // The upsert merges onto the existing item, so `snoozedUntil` has to be
  // cleared explicitly: a fresh PermissionRequest is new information and must
  // not stay buried under a snooze the user set for the previous one.
  const h = makeHarness([], NOON);
  const event = { session_id: "claude-1", cwd: CWD, hook_event_name: "PermissionRequest" };

  await handleHookEvent(event, "claude", h.deps);
  await snoozeAttentionItem("claude-1:permission", 60, h.deps);
  assert.ok(h.store.data.items[0].snoozedUntil);

  await handleHookEvent(event, "claude", h.deps);

  assert.equal(h.store.data.items.length, 1);
  assert.equal(h.store.data.items[0].snoozedUntil, undefined);
});
