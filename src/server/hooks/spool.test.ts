import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookEventPayload } from "@shared/types.js";
import {
  drainSpool,
  ensureSpoolDirs,
  pendingDir,
  quarantineDir,
  spoolCounts,
  SPOOL_MAX_AGE_MS,
} from "./spool.js";

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-spool-"));
  tmpDirs.push(dir);
  ensureSpoolDirs(dir);
  return dir;
}

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

/** Write one spooled event, with an explicit mtime so ordering and expiry are deterministic. */
function spool(dataDir: string, name: string, body: unknown, ageMs = 0): string {
  const file = path.join(pendingDir(dataDir), `${name}.json`);
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  const at = new Date(NOW - ageMs);
  fs.utimesSync(file, at, at);
  return file;
}

function event(sessionId: string, hookEventName = "PermissionRequest"): HookEventPayload {
  return { session_id: sessionId, hook_event_name: hookEventName, cwd: "/tmp/project" };
}

function collector() {
  const seen: HookEventPayload[] = [];
  return {
    seen,
    handle: async (payload: HookEventPayload) => {
      seen.push(payload);
    },
  };
}

test("a spooled event is replayed and its file removed", async () => {
  const dataDir = tempDataDir();
  spool(dataDir, "event-1", event("s1"));
  const { seen, handle } = collector();

  const result = await drainSpool({ dataDir, now: NOW, handle });

  assert.equal(result.delivered, 1);
  assert.deepEqual(seen.map((e) => e.session_id), ["s1"]);
  assert.deepEqual(fs.readdirSync(pendingDir(dataDir)), [], "a delivered event must not be replayed again");
});

test("events replay oldest first, by mtime rather than by filename", async () => {
  const dataDir = tempDataDir();
  // Names deliberately sort the opposite way to the timestamps: the forwarder's
  // filenames end in a random suffix, so name order means nothing.
  spool(dataDir, "event-zzz", event("oldest"), 3 * 60_000);
  spool(dataDir, "event-aaa", event("newest"), 1 * 60_000);
  spool(dataDir, "event-mmm", event("middle"), 2 * 60_000);
  const { seen, handle } = collector();

  await drainSpool({ dataDir, now: NOW, handle });

  assert.deepEqual(seen.map((e) => e.session_id), ["oldest", "middle", "newest"]);
});

test("draining an empty or absent spool is a no-op, not an error", async () => {
  const dataDir = tempDataDir();
  const empty = await drainSpool({ dataDir, now: NOW, handle: async () => {} });
  assert.deepEqual(empty, { delivered: 0, quarantined: 0, expired: 0, trimmed: 0 });

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-spool-none-"));
  tmpDirs.push(bare);
  assert.deepEqual(await drainSpool({ dataDir: bare, now: NOW, handle: async () => {} }), {
    delivered: 0,
    quarantined: 0,
    expired: 0,
    trimmed: 0,
  });
});

test("unparseable and wrong-shaped files are quarantined, not retried forever", async () => {
  const dataDir = tempDataDir();
  spool(dataDir, "event-broken", "{ not json");
  spool(dataDir, "event-array", []);
  spool(dataDir, "event-nofields", { hello: "world" });
  spool(dataDir, "event-partial", { session_id: "s1" });
  spool(dataDir, "event-good", event("s2"));
  const { seen, handle } = collector();

  const result = await drainSpool({ dataDir, now: NOW, handle });

  assert.equal(result.quarantined, 4);
  assert.equal(result.delivered, 1);
  assert.deepEqual(seen.map((e) => e.session_id), ["s2"]);
  assert.deepEqual(fs.readdirSync(pendingDir(dataDir)), []);
  // Kept rather than deleted: a file we could not read is evidence of a bug.
  assert.equal(fs.readdirSync(quarantineDir(dataDir)).length, 4);
});

test("events older than the retention window expire instead of replaying", async () => {
  const dataDir = tempDataDir();
  spool(dataDir, "event-ancient", event("old"), SPOOL_MAX_AGE_MS + 60_000);
  spool(dataDir, "event-fresh", event("new"), 60_000);
  const { seen, handle } = collector();

  const result = await drainSpool({ dataDir, now: NOW, handle });

  assert.equal(result.expired, 1);
  assert.deepEqual(seen.map((e) => e.session_id), ["new"]);
  assert.deepEqual(fs.readdirSync(pendingDir(dataDir)), []);
});

test("an over-long queue drops its oldest rather than replaying everything", async () => {
  const dataDir = tempDataDir();
  for (let i = 0; i < 6; i++) spool(dataDir, `event-${i}`, event(`s${i}`), (6 - i) * 60_000);
  const { seen, handle } = collector();

  const result = await drainSpool({ dataDir, now: NOW, handle, maxFiles: 2 });

  assert.equal(result.trimmed, 4);
  // The two newest survive — after a long outage they are the ones that still
  // describe the current state of a session.
  assert.deepEqual(seen.map((e) => e.session_id), ["s4", "s5"]);
});

test("a handler that throws leaves the event to be retried, not dropped", async () => {
  const dataDir = tempDataDir();
  spool(dataDir, "event-1", event("s1"));

  const failed = await drainSpool({
    dataDir,
    now: NOW,
    handle: async () => {
      throw new Error("store is locked");
    },
  });

  assert.equal(failed.delivered, 0);
  assert.equal(spoolCounts(dataDir).pending, 1, "losing the event is the failure we exist to prevent");

  const { seen, handle } = collector();
  const retried = await drainSpool({ dataDir, now: NOW, handle });
  assert.equal(retried.delivered, 1);
  assert.deepEqual(seen.map((e) => e.session_id), ["s1"]);
});

test("two concurrent drains never replay the same event twice", async () => {
  const dataDir = tempDataDir();
  for (let i = 0; i < 20; i++) spool(dataDir, `event-${i}`, event(`s${i}`), (20 - i) * 1000);

  const seen: string[] = [];
  const handle = async (payload: HookEventPayload) => {
    // Yield, so the two drains genuinely interleave rather than running to
    // completion one after the other.
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(payload.session_id);
  };

  const [a, b] = await Promise.all([
    drainSpool({ dataDir, now: NOW, handle }),
    drainSpool({ dataDir, now: NOW, handle }),
  ]);

  assert.equal(a.delivered + b.delivered, 20);
  assert.equal(new Set(seen).size, 20, "the claim rename must make each event exactly one drain's");
  assert.deepEqual(fs.readdirSync(pendingDir(dataDir)), []);
});

test("counts report the backlog, so a spool that never drains is visible", () => {
  const dataDir = tempDataDir();
  assert.deepEqual(spoolCounts(dataDir), { pending: 0, quarantined: 0 });

  spool(dataDir, "event-1", event("s1"));
  spool(dataDir, "event-2", event("s2"));
  fs.writeFileSync(path.join(quarantineDir(dataDir), "event-bad.json"), "{");

  assert.deepEqual(spoolCounts(dataDir), { pending: 2, quarantined: 1 });
});

test("spool directories are private — payloads can carry tool arguments", () => {
  const dataDir = tempDataDir();
  assert.equal(fs.statSync(pendingDir(dataDir)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(quarantineDir(dataDir)).mode & 0o777, 0o700);
});
