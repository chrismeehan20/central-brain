import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "./paths.js";
import { scanCodexProjects } from "./codex.js";

const tmpDirs: string[] = [];

/**
 * A fresh mkdtemp root per test. `metaCache` in codex.ts is module-level and
 * keyed by absolute path + birthtimeMs, so distinct temp roots mean no two
 * tests can ever share a cache key and pollute one another.
 */
function makeSessionsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-codex-test-"));
  tmpDirs.push(dir);
  return dir;
}

function metaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-07-18T02:50:59.778Z",
    type: "session_meta",
    payload,
  });
}

/** Writes `lines` as a rollout file under `<root>/<datePath>/rollout-<id>.jsonl`. */
function writeRollout(root: string, datePath: string, id: string, lines: string[]): string {
  const dir = path.join(root, datePath);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-18T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a session_meta first line far larger than 8KiB resolves fully", () => {
  const root = makeSessionsRoot();
  // Real session_meta lines embed Codex's whole `base_instructions` text:
  // median ~15KB, max ~41KB on a real machine. Pad to ~30KB, which the old
  // fixed 8192-byte read truncated mid-string so JSON.parse threw and the
  // session was dropped entirely.
  const line = metaLine({
    session_id: "big-0001",
    id: "big-0001",
    cwd: "/Users/someone/code/big/./",
    originator: "Codex Desktop",
    cli_version: "0.144.2",
    source: "vscode",
    base_instructions: { text: "You are Codex. " + "instruction ".repeat(2500) },
  });
  assert.ok(line.length > 30000, `fixture first line should be >30KB, got ${line.length}`);

  const file = writeRollout(root, "2026/07/18", "big-0001", [
    line,
    JSON.stringify({ type: "response_item", payload: { role: "user" } }),
  ]);

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"));
  const key = canonicalize("/Users/someone/code/big");

  assert.deepEqual(Object.keys(scanned), [key], "the >8KiB session_meta must resolve to its cwd");
  assert.deepEqual(scanned[key], [
    {
      tool: "codex",
      sessionId: "big-0001",
      lastActivity: fs.statSync(file).mtime.toISOString(),
      summary: undefined,
      entrypoint: "vscode",
      transcriptPath: file,
    },
  ]);
});

test("a small session_meta first line still resolves, with its thread name", () => {
  const root = makeSessionsRoot();
  const line = metaLine({
    session_id: "small-0002",
    id: "small-0002",
    cwd: "/Users/someone/code/small",
    originator: "codex_cli_rs",
    source: "cli",
  });
  assert.ok(line.length < 8192, `fixture first line should be under the old 8KiB window, got ${line.length}`);

  const file = writeRollout(root, "2026/07/18", "small-0002", [line]);

  const indexFile = path.join(root, "session_index.jsonl");
  fs.writeFileSync(
    indexFile,
    [
      "",
      "{not json",
      JSON.stringify({ id: "small-0002", thread_name: "Fix the truncated read" }),
      JSON.stringify({ id: "unrelated", thread_name: "Some other thread" }),
    ].join("\n") + "\n",
  );

  const scanned = scanCodexProjects(root, indexFile);
  const key = canonicalize("/Users/someone/code/small");

  assert.deepEqual(Object.keys(scanned), [key]);
  assert.deepEqual(scanned[key], [
    {
      tool: "codex",
      sessionId: "small-0002",
      lastActivity: fs.statSync(file).mtime.toISOString(),
      summary: "Fix the truncated read",
      entrypoint: "cli",
      transcriptPath: file,
    },
  ]);
});

test("a first line that is not session_meta produces no entry and does not throw", () => {
  const root = makeSessionsRoot();
  // Valid JSON, has a cwd, but the wrong `type` - it must not be mistaken for meta.
  writeRollout(root, "2026/07/18", "notmeta-0003", [
    JSON.stringify({ type: "turn_context", payload: { cwd: "/Users/someone/code/notmeta" } }),
    metaLine({ id: "notmeta-0003", cwd: "/Users/someone/code/notmeta" }),
  ]);
  // session_meta with no payload at all.
  writeRollout(root, "2026/07/18", "nopayload-0004", [
    JSON.stringify({ type: "session_meta" }),
  ]);

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"));

  assert.deepEqual(scanned, {}, "only a session_meta *first* line may contribute a session");
});

test("a truncated or corrupt first line produces no entry and does not throw", () => {
  const root = makeSessionsRoot();
  const dir = path.join(root, "2026/07/18");
  fs.mkdirSync(dir, { recursive: true });

  // Cut off mid-string, exactly like the old 8KiB read produced.
  fs.writeFileSync(
    path.join(dir, "rollout-2026-07-18T10-00-00-truncated.jsonl"),
    '{"timestamp":"2026-07-18T02:50:59.778Z","type":"session_meta","payload":{"id":"trunc","cwd":"/Users/someone/code/trun',
  );
  // Not JSON at all.
  fs.writeFileSync(path.join(dir, "rollout-2026-07-18T10-00-00-garbage.jsonl"), "not json at all\n");
  // Completely empty file.
  fs.writeFileSync(path.join(dir, "rollout-2026-07-18T10-00-00-empty.jsonl"), "");

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"));

  assert.deepEqual(scanned, {}, "a corrupt first line must never yield a session");
  assert.equal(canonicalize("/Users/someone/code/trun") in scanned, false);
});

test("nested date directories are walked and non-rollout files are ignored", () => {
  const root = makeSessionsRoot();
  const jan = writeRollout(root, "2026/01/02", "jan-0005", [
    metaLine({ id: "jan-0005", cwd: "/Users/someone/code/nested", source: "cli" }),
  ]);
  const jul = writeRollout(root, "2026/07/18", "jul-0006", [
    metaLine({ id: "jul-0006", cwd: "/Users/someone/code/nested", source: "vscode" }),
  ]);
  // A third, three levels deeper than the usual YYYY/MM/DD layout.
  const deep = writeRollout(root, "2026/07/18/extra/deeper", "deep-0007", [
    metaLine({ id: "deep-0007", cwd: "/Users/someone/code/deep" }),
  ]);

  // Decoys that must be skipped: right extension, wrong prefix; right prefix,
  // wrong extension; and a valid-looking meta in each so a false positive shows up.
  const decoyDir = path.join(root, "2026/07/18");
  fs.writeFileSync(
    path.join(decoyDir, "compacted-2026-07-18-decoy.jsonl"),
    metaLine({ id: "decoy-prefix", cwd: "/Users/someone/code/DECOY-PREFIX" }) + "\n",
  );
  fs.writeFileSync(
    path.join(decoyDir, "rollout-2026-07-18-decoy.json"),
    metaLine({ id: "decoy-ext", cwd: "/Users/someone/code/DECOY-EXT" }) + "\n",
  );
  fs.writeFileSync(
    path.join(decoyDir, "rollout-2026-07-18-decoy.jsonl.bak"),
    metaLine({ id: "decoy-bak", cwd: "/Users/someone/code/DECOY-BAK" }) + "\n",
  );

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"));
  const nestedKey = canonicalize("/Users/someone/code/nested");
  const deepKey = canonicalize("/Users/someone/code/deep");

  assert.deepEqual(
    Object.keys(scanned).sort(),
    [deepKey, nestedKey].sort(),
    "only rollout-*.jsonl files may contribute; the three decoys must be ignored",
  );
  assert.deepEqual(
    scanned[nestedKey]!.map((s) => s.transcriptPath).sort(),
    [jan, jul].sort(),
    "rollouts under different date directories must group under one cwd",
  );
  assert.deepEqual(scanned[deepKey]!.map((s) => s.transcriptPath), [deep]);
});

test("lastActivity is the rollout file's mtime as an ISO string", () => {
  const root = makeSessionsRoot();
  const file = writeRollout(root, "2026/07/18", "mtime-0008", [
    metaLine({ id: "mtime-0008", cwd: "/Users/someone/code/mtime" }),
  ]);

  // A specific, non-"now" mtime, so the assertion can't pass by accident.
  const mtime = new Date("2025-11-03T04:05:06.000Z");
  fs.utimesSync(file, mtime, mtime);

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"));
  const key = canonicalize("/Users/someone/code/mtime");

  assert.equal(scanned[key]?.length, 1);
  assert.equal(scanned[key]![0]!.lastActivity, "2025-11-03T04:05:06.000Z");
});
