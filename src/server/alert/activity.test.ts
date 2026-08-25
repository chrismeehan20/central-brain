import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityEvent, HookEventPayload } from "@shared/types.js";
import { describeHookEvent, recordActivity, type ActivityStoreLike } from "./activity.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");

function memStore(events: ActivityEvent[] = []): ActivityStoreLike & { writes: number } {
  const store = {
    data: { events },
    writes: 0,
    async write() {
      store.writes += 1;
    },
  };
  return store;
}

function payload(overrides: Partial<HookEventPayload> = {}): HookEventPayload {
  return { session_id: "s1", hook_event_name: "Stop", cwd: "/repo", ...overrides };
}

test("describeHookEvent covers every installed event name", () => {
  // These are exactly the events install-hooks wires up (claudeHooks.ts /
  // CODEX_HOOK_EVENTS); an event the installer sends that the feed cannot
  // describe would silently vanish from the stream.
  for (const name of [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionEnd",
  ]) {
    assert.notEqual(describeHookEvent(payload({ hook_event_name: name })), null, name);
  }
});

test("describeHookEvent names the tool on a permission ask, never the input", () => {
  const msg = describeHookEvent(
    payload({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: "rm -rf /" }),
  );
  assert.ok(msg!.includes("Bash"));
  assert.ok(!msg!.includes("rm -rf"));
});

test("recordActivity appends, canonicalizes cwd, and emits the single event", async () => {
  const store = memStore();
  const emitted: ActivityEvent[] = [];
  await recordActivity(payload(), "claude", {
    store,
    now: NOW,
    id: () => "e1",
    emit: (e) => emitted.push(e),
  });
  assert.equal(store.data.events.length, 1);
  assert.equal(store.data.events[0].message, "Finished its turn");
  assert.equal(store.data.events[0].tool, "claude");
  assert.deepEqual(emitted, store.data.events);
});

test("recordActivity ignores unknown event names without writing", async () => {
  const store = memStore();
  await recordActivity(payload({ hook_event_name: "PreToolUse" }), "claude", { store, now: NOW });
  assert.equal(store.writes, 0);
  assert.equal(store.data.events.length, 0);
});

test("recordActivity caps the stream, dropping the oldest", async () => {
  const store = memStore();
  for (let i = 0; i < 505; i++) {
    await recordActivity(payload({ session_id: `s${i}` }), "codex", {
      store,
      now: NOW + i,
      id: () => `e${i}`,
      emit: () => {},
    });
  }
  assert.equal(store.data.events.length, 500);
  assert.equal(store.data.events[0].sessionId, "s5");
  assert.equal(store.data.events.at(-1)!.sessionId, "s504");
});
