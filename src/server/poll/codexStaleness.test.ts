import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttentionItem, SessionRef } from "@shared/types.js";
import type { NotifyOptions } from "../alert/notifier.js";
import type { AttentionStoreLike } from "../alert/attention.js";
import type { ScannedSessions } from "../scan/codex.js";
import { recordHookEvent, isHookLive, type LivenessStoreLike } from "../alert/hookLiveness.js";
import { createStalenessContext, runStalenessPass } from "./codexStaleness.js";

/**
 * The staleness pass is driven through an injected context: a fake scan over a
 * temp rollout file, in-memory attention and liveness stores, and a stubbed
 * notifier. Nothing here reads ~/.codex or writes data/*.json.
 */
const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const PROJECT = "/Users/someone/code/widget";

/** A rollout file whose mtime is `ageMs` in the past, plus the SessionRef for it. */
function makeRollout(sessionId: string, quietForMs: number, now: number): SessionRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-staleness-test-"));
  tmpDirs.push(dir);
  const file = path.join(dir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(file, "{}\n");
  const mtimeSeconds = (now - quietForMs) / 1000;
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  return {
    tool: "codex",
    sessionId,
    lastActivity: new Date(now - quietForMs).toISOString(),
    transcriptPath: file,
  };
}

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

function makeLivenessStore(): LivenessStoreLike {
  return { data: { lastEventAt: {} }, write: async () => {} };
}

function heuristicFlag(sessionId: string, iso: string): AttentionItem {
  return {
    id: `${sessionId}:codex-maybe`,
    sessionId,
    projectPath: PROJECT,
    tool: "codex",
    type: "codex-maybe-waiting",
    priority: "low",
    createdAt: iso,
    updatedAt: iso,
  };
}

interface Harness {
  store: FakeStore;
  liveness: LivenessStoreLike;
  notifications: NotifyOptions[];
  scanCalls: number;
  run: () => Promise<boolean>;
}

function makeHarness(opts: {
  now: number;
  refs?: SessionRef[];
  items?: AttentionItem[];
}): Harness {
  const store = makeStore(opts.items ?? []);
  const liveness = makeLivenessStore();
  const notifications: NotifyOptions[] = [];
  const harness = {
    store,
    liveness,
    notifications,
    scanCalls: 0,
    run: async () => false,
  } as Harness;

  const ctx = createStalenessContext({
    store,
    now: () => opts.now,
    hooksLive: () => isHookLive("codex", { store: liveness, now: opts.now }),
    scan: (): ScannedSessions => {
      harness.scanCalls += 1;
      return opts.refs && opts.refs.length > 0 ? { [PROJECT]: opts.refs } : {};
    },
    notify: async (n) => {
      notifications.push(n);
    },
    emit: () => {},
  });
  harness.run = () => runStalenessPass(ctx);
  return harness;
}

test("with no Codex hook event ever recorded, a quiet rollout file is flagged by the heuristic", async () => {
  const now = Date.now();
  const h = makeHarness({ now, refs: [makeRollout("codex-1", 10 * 60_000, now)] });

  const changed = await h.run();

  assert.equal(changed, true);
  assert.equal(h.scanCalls, 1);
  assert.deepEqual(
    h.store.data.items.map((i) => [i.id, i.type, i.priority, i.tool]),
    [["codex-1:codex-maybe", "codex-maybe-waiting", "low", "codex"]]
  );
  assert.deepEqual(h.notifications, [{ title: "Codex may be stuck", body: PROJECT, sound: false }]);
});

test("a rollout file quiet for less than the staleness threshold is not flagged", async () => {
  const now = Date.now();
  const h = makeHarness({ now, refs: [makeRollout("codex-1", 2 * 60_000, now)] });

  assert.equal(await h.run(), false);
  assert.deepEqual(h.store.data.items, []);
});

test("a recent Codex hook event stands the heuristic down and clears existing flags", async () => {
  const now = Date.now();
  const h = makeHarness({
    now,
    refs: [makeRollout("codex-1", 10 * 60_000, now)],
    items: [heuristicFlag("codex-1", new Date(now - 10 * 60_000).toISOString())],
  });
  await recordHookEvent("codex", { store: h.liveness, now: now - 60 * 60_000 });

  const changed = await h.run();

  assert.equal(changed, true);
  assert.deepEqual(h.store.data.items, [], "hooks are authoritative — the guess must be retired");
  assert.equal(h.store.writes, 1);
  assert.equal(h.scanCalls, 0, "no need to scan rollout files at all when hooks are live");
  assert.deepEqual(h.notifications, []);
});

test("standing down leaves real hook-created items alone", async () => {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const permission: AttentionItem = {
    id: "codex-1:permission",
    sessionId: "codex-1",
    projectPath: PROJECT,
    tool: "codex",
    type: "permission",
    priority: "high",
    createdAt: iso,
    updatedAt: iso,
  };
  const h = makeHarness({ now, items: [permission, heuristicFlag("codex-2", iso)] });
  await recordHookEvent("codex", { store: h.liveness, now });

  await h.run();

  assert.deepEqual(h.store.data.items, [permission]);
});

test("standing down with nothing to clear writes nothing", async () => {
  const now = Date.now();
  const h = makeHarness({ now, refs: [makeRollout("codex-1", 10 * 60_000, now)] });
  await recordHookEvent("codex", { store: h.liveness, now });

  assert.equal(await h.run(), false);
  assert.equal(h.store.writes, 0);
  assert.deepEqual(h.store.data.items, []);
});

test("a Codex hook event older than the liveness window re-arms the heuristic", async () => {
  const now = Date.now();
  const h = makeHarness({ now, refs: [makeRollout("codex-1", 10 * 60_000, now)] });
  await recordHookEvent("codex", { store: h.liveness, now: now - 8 * 24 * 60 * 60_000 });

  assert.equal(await h.run(), true);
  assert.equal(h.scanCalls, 1);
  assert.deepEqual(
    h.store.data.items.map((i) => i.type),
    ["codex-maybe-waiting"]
  );
});
