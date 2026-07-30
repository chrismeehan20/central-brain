import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize } from "./paths.js";
import { scanCodexProjects } from "./codex.js";

const tmpDirs: string[] = [];

/**
 * A fresh mkdtemp root per test. `metaCache` in codex.ts is module-level and
 * keyed by absolute path + birthtimeMs, so distinct temp roots mean no two
 * tests can ever share a cache key and pollute one another.
 *
 * Every `scanCodexProjects` call below passes this root as the third argument
 * (`codexHome`) as well, so no test can ever reach the developer's real
 * ~/.codex or its live state DB. State DBs used here are built from scratch by
 * `writeStateDb`.
 */
function makeSessionsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-codex-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * The common shape: `root` doubles as the sessions tree and the Codex home, and
 * there is no session_index.jsonl, so `summary` can only come from the DB.
 */
function scanFixture(root: string) {
  return scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);
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

/**
 * The subset of Codex's real `threads` schema this scan touches, in the real
 * declaration order. Fixture DBs are built from scratch here — the developer's
 * own state DB is never opened, copied, or read by these tests.
 */
const THREAD_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["id", "TEXT PRIMARY KEY"],
  ["rollout_path", "TEXT NOT NULL"],
  ["cwd", "TEXT NOT NULL"],
  ["title", "TEXT"],
  ["approval_mode", "TEXT"],
  ["tokens_used", "INTEGER"],
  ["archived", "INTEGER NOT NULL DEFAULT 0"],
  ["git_branch", "TEXT"],
  ["git_origin_url", "TEXT"],
  ["model", "TEXT"],
  ["source", "TEXT"],
  ["updated_at", "INTEGER"],
  ["updated_at_ms", "INTEGER"],
];

type ThreadRow = Record<string, string | number | null>;

interface StateDbOptions {
  /** Simulate schema drift by dropping columns from the fixture table. */
  omitColumns?: string[];
  /** Simulate a renamed/absent `threads` table. */
  tableName?: string;
}

/** Creates `<codexHome>/<filename>` as a real SQLite DB holding `rows`. */
function writeStateDb(
  codexHome: string,
  filename: string,
  rows: ThreadRow[],
  options: StateDbOptions = {},
): string {
  const omit = new Set(options.omitColumns ?? []);
  const columns = THREAD_COLUMNS.filter(([name]) => !omit.has(name));
  const table = options.tableName ?? "threads";

  fs.mkdirSync(codexHome, { recursive: true });
  const file = path.join(codexHome, filename);
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE ${table} (${columns.map(([n, t]) => `${n} ${t}`).join(", ")})`);
    const names = columns.map(([name]) => name);
    const insert = db.prepare(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      insert.run(...names.map((name) => (name === "archived" ? (row[name] ?? 0) : (row[name] ?? null))));
    }
  } finally {
    db.close();
  }
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

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);
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

  const scanned = scanCodexProjects(root, indexFile, root);
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

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);

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

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);

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

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);
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

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);
  const key = canonicalize("/Users/someone/code/mtime");

  assert.equal(scanned[key]?.length, 1);
  assert.equal(scanned[key]![0]!.lastActivity, "2025-11-03T04:05:06.000Z");
});

test("the state DB enriches a rollout-file session with fields the rollout lacks", () => {
  const root = makeSessionsRoot();
  const named = writeRollout(root, "2026/07/18", "enrich-0009", [
    metaLine({ id: "enrich-0009", cwd: "/Users/someone/code/enrich", source: "cli" }),
  ]);
  const unnamed = writeRollout(root, "2026/07/18", "enrich-0010", [
    metaLine({ id: "enrich-0010", cwd: "/Users/someone/code/enrich", source: "vscode" }),
  ]);

  const indexFile = path.join(root, "session_index.jsonl");
  fs.writeFileSync(
    indexFile,
    JSON.stringify({ id: "enrich-0009", thread_name: "Name from session_index" }) + "\n",
  );

  writeStateDb(root, "state_5.sqlite", [
    {
      id: "enrich-0009",
      rollout_path: named,
      cwd: "/Users/someone/code/enrich",
      title: "Title from the DB",
      approval_mode: "on-request",
      tokens_used: 123456,
      git_branch: "feature/enrichment",
      git_origin_url: "git@github.com:someone/enrich.git",
      model: "gpt-5-codex",
      source: "cli",
      updated_at_ms: 1_780_000_000_000,
    },
    {
      id: "enrich-0010",
      rollout_path: unnamed,
      cwd: "/Users/someone/code/enrich",
      title: "Title from the DB",
      approval_mode: "never",
      tokens_used: 7,
      model: "gpt-5.1-codex-max",
      updated_at_ms: 1_780_000_000_000,
    },
  ]);

  const scanned = scanCodexProjects(root, indexFile, root);
  const key = canonicalize("/Users/someone/code/enrich");
  const byId = new Map(scanned[key]!.map((s) => [s.sessionId, s]));

  assert.equal(scanned[key]?.length, 2, "enrichment must not add or drop sessions");
  assert.deepEqual(byId.get("enrich-0009"), {
    tool: "codex",
    sessionId: "enrich-0009",
    lastActivity: fs.statSync(named).mtime.toISOString(),
    // session_index.jsonl stays the summary source; the DB title must not win.
    summary: "Name from session_index",
    entrypoint: "cli",
    transcriptPath: named,
    gitBranch: "feature/enrichment",
    tokensUsed: 123456,
    model: "gpt-5-codex",
    approvalMode: "on-request",
    gitOriginUrl: "git@github.com:someone/enrich.git",
  });
  // No session_index entry, so - and only so - the DB title is the fallback.
  assert.equal(byId.get("enrich-0010")?.summary, "Title from the DB");
  assert.equal(byId.get("enrich-0010")?.model, "gpt-5.1-codex-max");
  assert.equal(byId.get("enrich-0010")?.approvalMode, "never");
  assert.equal(byId.get("enrich-0010")?.tokensUsed, 7);
  // Columns that were NULL must stay absent rather than becoming null/"".
  assert.equal(byId.get("enrich-0010")?.gitBranch, undefined);
  assert.equal(byId.get("enrich-0010")?.gitOriginUrl, undefined);
});

test("the highest state DB schema version wins by integer, not string, comparison", () => {
  const root = makeSessionsRoot();
  const file = writeRollout(root, "2026/07/18", "version-0011", [
    metaLine({ id: "version-0011", cwd: "/Users/someone/code/version", source: "cli" }),
  ]);

  const row = (model: string, tokens: number): ThreadRow => ({
    id: "version-0011",
    rollout_path: file,
    cwd: "/Users/someone/code/version",
    model,
    tokens_used: tokens,
    updated_at_ms: 1_780_000_000_000,
  });

  // A lexicographic max over these names is "state_5.sqlite"; the integer max
  // is state_10. Each DB carries different data so the wrong pick is visible.
  writeStateDb(root, "state_2.sqlite", [row("from-state-2", 2)]);
  writeStateDb(root, "state_5.sqlite", [row("from-state-5", 5)]);
  writeStateDb(root, "state_10.sqlite", [row("from-state-10", 10)]);
  // Decoys: a non-integer version suffix, and a WAL sidecar whose name would
  // parse as version 11 if the `.sqlite` ending were matched loosely.
  writeStateDb(root, "state_next.sqlite", [row("from-non-integer-suffix", 99)]);
  writeStateDb(root, "state_11.sqlite-wal", [row("from-wal-sidecar", 111)]);

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);
  const session = scanned[canonicalize("/Users/someone/code/version")]![0]!;

  assert.equal(session.model, "from-state-10", "state_10 is the highest schema version");
  assert.equal(session.tokensUsed, 10);
  assert.notEqual(session.model, "from-state-5", "a string sort would have picked state_5");
  assert.notEqual(session.model, "from-non-integer-suffix");
  assert.notEqual(session.model, "from-wal-sidecar");
});

test("a DB thread whose rollout file is gone still produces a session", () => {
  const root = makeSessionsRoot();
  const kept = writeRollout(root, "2026/07/18", "kept-0012", [
    metaLine({ id: "kept-0012", cwd: "/Users/someone/code/kept", source: "cli" }),
  ]);
  // Codex's auto-cleanup deleted this rollout file; only the DB row survives.
  const deletedRollout = path.join(root, "2026/03/21", "rollout-2026-03-21T00-36-36-gone-0013.jsonl");
  assert.equal(fs.existsSync(deletedRollout), false, "fixture must reference a file that is gone");

  writeStateDb(root, "state_5.sqlite", [
    { id: "kept-0012", rollout_path: kept, cwd: "/Users/someone/code/kept", updated_at_ms: 1 },
    {
      id: "gone-0013",
      rollout_path: deletedRollout,
      cwd: "/Users/someone/code/recovered",
      title: "Recovered from the DB",
      approval_mode: "never",
      tokens_used: 4242,
      git_branch: "main",
      git_origin_url: "https://github.com/someone/recovered.git",
      model: "gpt-5-codex",
      source: "vscode",
      updated_at_ms: Date.parse("2025-09-09T01:02:03.000Z"),
    },
  ]);

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);
  const recoveredKey = canonicalize("/Users/someone/code/recovered");

  assert.deepEqual(
    Object.keys(scanned).sort(),
    [canonicalize("/Users/someone/code/kept"), recoveredKey].sort(),
    "the file-less thread must be grouped under its own cwd",
  );
  assert.deepEqual(scanned[recoveredKey], [
    {
      tool: "codex",
      sessionId: "gone-0013",
      lastActivity: "2025-09-09T01:02:03.000Z",
      summary: "Recovered from the DB",
      entrypoint: "vscode",
      transcriptPath: undefined,
      gitBranch: "main",
      tokensUsed: 4242,
      model: "gpt-5-codex",
      approvalMode: "never",
      gitOriginUrl: "https://github.com/someone/recovered.git",
    },
  ]);
  assert.equal(
    scanned[recoveredKey]![0]!.transcriptPath,
    undefined,
    "transcriptPath must never point at a file that does not exist",
  );
});

test("a file-less thread falls back to updated_at seconds when updated_at_ms is null", () => {
  const root = makeSessionsRoot();
  writeStateDb(root, "state_5.sqlite", [
    {
      id: "seconds-0014",
      rollout_path: path.join(root, "2026/01/01", "rollout-gone.jsonl"),
      cwd: "/Users/someone/code/seconds",
      updated_at: Math.floor(Date.parse("2025-08-08T08:08:08.000Z") / 1000),
      updated_at_ms: null,
    },
    // No usable timestamp at all: nothing to sort or display, so it is skipped.
    {
      id: "notime-0015",
      rollout_path: path.join(root, "2026/01/01", "rollout-also-gone.jsonl"),
      cwd: "/Users/someone/code/notime",
    },
  ]);

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);

  assert.deepEqual(Object.keys(scanned), [canonicalize("/Users/someone/code/seconds")]);
  assert.equal(
    scanned[canonicalize("/Users/someone/code/seconds")]![0]!.lastActivity,
    "2025-08-08T08:08:08.000Z",
  );
});

test("archived threads neither enrich nor appear", () => {
  const root = makeSessionsRoot();
  const file = writeRollout(root, "2026/07/18", "archived-0016", [
    metaLine({ id: "archived-0016", cwd: "/Users/someone/code/archived", source: "cli" }),
  ]);

  writeStateDb(root, "state_5.sqlite", [
    {
      id: "archived-0016",
      rollout_path: file,
      cwd: "/Users/someone/code/archived",
      archived: 1,
      model: "must-not-appear",
      tokens_used: 999,
      git_branch: "must-not-appear",
      updated_at_ms: 1_780_000_000_000,
    },
    {
      id: "archived-0017",
      rollout_path: path.join(root, "2026/01/01", "rollout-archived-and-gone.jsonl"),
      cwd: "/Users/someone/code/archived-and-gone",
      archived: 1,
      updated_at_ms: 1_780_000_000_000,
    },
  ]);

  const scanned = scanCodexProjects(root, path.join(root, "no-such-index.jsonl"), root);
  const key = canonicalize("/Users/someone/code/archived");

  assert.deepEqual(Object.keys(scanned), [key], "an archived file-less thread must not be emitted");
  assert.deepEqual(scanned[key], [
    {
      tool: "codex",
      sessionId: "archived-0016",
      lastActivity: fs.statSync(file).mtime.toISOString(),
      summary: undefined,
      entrypoint: "cli",
      transcriptPath: file,
    },
  ]);
});

test("schema drift skips enrichment silently and leaves the file scan intact", () => {
  const expected = (file: string) => [
    {
      tool: "codex",
      sessionId: "drift-0018",
      lastActivity: fs.statSync(file).mtime.toISOString(),
      summary: undefined,
      entrypoint: "cli",
      transcriptPath: file,
    },
  ];
  const rollout = (root: string) =>
    writeRollout(root, "2026/07/18", "drift-0018", [
      metaLine({ id: "drift-0018", cwd: "/Users/someone/code/drift", source: "cli" }),
    ]);
  const key = canonicalize("/Users/someone/code/drift");

  // A required column has gone away.
  const noCwd = makeSessionsRoot();
  const noCwdFile = rollout(noCwd);
  writeStateDb(
    noCwd,
    "state_5.sqlite",
    [{ id: "drift-0018", rollout_path: noCwdFile, model: "must-not-appear", tokens_used: 5 }],
    { omitColumns: ["cwd"] },
  );
  const noCwdScan = scanCodexProjects(noCwd, path.join(noCwd, "no-such-index.jsonl"), noCwd);
  assert.deepEqual(noCwdScan[key], expected(noCwdFile), "a missing required column must not throw");

  // The whole table has been renamed away.
  const noTable = makeSessionsRoot();
  const noTableFile = rollout(noTable);
  writeStateDb(
    noTable,
    "state_5.sqlite",
    [
      {
        id: "drift-0018",
        rollout_path: noTableFile,
        cwd: "/Users/someone/code/drift",
        model: "must-not-appear",
      },
    ],
    { tableName: "conversations" },
  );
  const noTableScan = scanCodexProjects(noTable, path.join(noTable, "no-such-index.jsonl"), noTable);
  assert.deepEqual(noTableScan[key], expected(noTableFile), "no threads table must not throw");

  // A file that is not a database at all.
  const corrupt = makeSessionsRoot();
  const corruptFile = rollout(corrupt);
  fs.writeFileSync(path.join(corrupt, "state_5.sqlite"), "this is definitely not a sqlite file");
  const corruptScan = scanCodexProjects(corrupt, path.join(corrupt, "no-such-index.jsonl"), corrupt);
  assert.deepEqual(corruptScan[key], expected(corruptFile), "a corrupt DB must not throw");
});

test("an optional column that is missing degrades only that field", () => {
  const root = makeSessionsRoot();
  const file = writeRollout(root, "2026/07/18", "optional-0019", [
    metaLine({ id: "optional-0019", cwd: "/Users/someone/code/optional", source: "cli" }),
  ]);

  writeStateDb(
    root,
    "state_5.sqlite",
    [
      {
        id: "optional-0019",
        rollout_path: file,
        cwd: "/Users/someone/code/optional",
        tokens_used: 321,
        approval_mode: "on-request",
        updated_at_ms: 1_780_000_000_000,
      },
    ],
    { omitColumns: ["model"] },
  );

  const session = scanFixture(root)[canonicalize("/Users/someone/code/optional")]![0]!;
  assert.equal(session.model, undefined, "the absent column yields no value");
  assert.equal(session.tokensUsed, 321, "the columns that do exist still enrich");
  assert.equal(session.approvalMode, "on-request");
});

test("no state DB at all leaves the rollout scan exactly as it was", () => {
  const root = makeSessionsRoot();
  const file = writeRollout(root, "2026/07/18", "nodb-0020", [
    metaLine({ id: "nodb-0020", cwd: "/Users/someone/code/nodb", source: "cli" }),
  ]);
  // Sidecars only - no state_<n>.sqlite for them to be mistaken for.
  fs.writeFileSync(path.join(root, "state_5.sqlite-wal"), "");
  fs.writeFileSync(path.join(root, "state_5.sqlite-shm"), "");
  const key = canonicalize("/Users/someone/code/nodb");

  assert.deepEqual(scanFixture(root)[key], [
    {
      tool: "codex",
      sessionId: "nodb-0020",
      lastActivity: fs.statSync(file).mtime.toISOString(),
      summary: undefined,
      entrypoint: "cli",
      transcriptPath: file,
    },
  ]);
});

test("a session in both the file scan and the DB appears exactly once", () => {
  const root = makeSessionsRoot();
  const file = writeRollout(root, "2026/07/18", "both-0021", [
    metaLine({ id: "both-0021", cwd: "/Users/someone/code/both", source: "cli" }),
  ]);

  writeStateDb(root, "state_5.sqlite", [
    {
      id: "both-0021",
      rollout_path: file,
      cwd: "/Users/someone/code/both",
      model: "gpt-5-codex",
      updated_at_ms: Date.parse("2030-01-01T00:00:00.000Z"),
    },
  ]);

  const result = scanFixture(root);
  const all = Object.values(result).flat();

  assert.equal(all.length, 1, "the same session must never be emitted twice");
  assert.deepEqual(Object.keys(result), [canonicalize("/Users/someone/code/both")]);
  assert.equal(all[0]!.model, "gpt-5-codex", "it is the enriched file-scan session that survives");
  assert.equal(
    all[0]!.lastActivity,
    fs.statSync(file).mtime.toISOString(),
    "the rollout file's mtime stays authoritative for a session that still has its file",
  );
});

test("a DB thread whose rollout file exists but was skipped by the file scan is not resurrected", () => {
  const root = makeSessionsRoot();
  // Present on disk, but its first line is corrupt so the file scan drops it.
  const dir = path.join(root, "2026/07/18");
  fs.mkdirSync(dir, { recursive: true });
  const corrupt = path.join(dir, "rollout-2026-07-18T10-00-00-corrupt-0022.jsonl");
  fs.writeFileSync(corrupt, '{"type":"session_meta","payload":{"id":"corrupt-0022","cwd":"/Users/so');

  writeStateDb(root, "state_5.sqlite", [
    {
      id: "corrupt-0022",
      rollout_path: corrupt,
      cwd: "/Users/someone/code/corrupt",
      updated_at_ms: 1_780_000_000_000,
    },
  ]);

  assert.deepEqual(
    scanFixture(root),
    {},
    "only threads whose rollout file is gone may be recovered from the DB",
  );
});
