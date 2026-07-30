import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Reads Codex's own SQLite state database (`~/.codex/state_<schemaVersion>.sqlite`,
 * table `threads`) to enrich the rollout-file scan with metadata that simply is
 * not present in the rollout files: token usage, model, approval mode, git
 * origin, and a git branch for sessions whose rollout `session_meta` had none.
 *
 * Two hard rules, because this is someone else's *live* database:
 *
 * 1. It is opened `readOnly` and never written, migrated, or PRAGMA-mutated.
 * 2. Any failure at all — file absent, `SQLITE_BUSY`, WAL lock, corruption,
 *    permissions, schema drift, or `node:sqlite` not existing on this runtime —
 *    yields *no enrichment* and no thrown error. The rollout-file scan is the
 *    source of truth and must keep working exactly as it does without a DB.
 */

/** `CODEX_HOME` wins if set, else `~/.codex` — matching how Codex itself resolves. */
export function codexHomeDir(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv ? fromEnv : path.join(os.homedir(), ".codex");
}

/**
 * The state DB filename carries Codex's schema version: `state_5.sqlite` today,
 * `state_6`/`state_10`/... tomorrow. Pick the highest version by *integer*
 * comparison — a lexicographic sort would put `state_10` before `state_2` and
 * happily pick a stale `state_5`. Files whose suffix is not a plain integer are
 * ignored, and the exact `.sqlite` ending excludes `-wal`/`-shm` sidecars.
 */
const STATE_DB_PATTERN = /^state_(\d+)\.sqlite$/;

export function findStateDbPath(codexHome: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(codexHome, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let best: { version: number; file: string } | undefined;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = STATE_DB_PATTERN.exec(entry.name);
    if (!match) continue;
    const version = Number.parseInt(match[1]!, 10);
    if (!Number.isSafeInteger(version)) continue;
    if (!best || version > best.version) best = { version, file: entry.name };
  }

  return best ? path.join(codexHome, best.file) : undefined;
}

export interface CodexThread {
  id: string;
  cwd: string;
  rolloutPath?: string;
  title?: string;
  tokensUsed?: number;
  model?: string;
  approvalMode?: string;
  gitBranch?: string;
  gitOriginUrl?: string;
  /** Only the plain `vscode`/`exec`/`cli` markers; subagent rows store a JSON blob here. */
  entrypoint?: string;
  lastActivity?: string; // ISO, from updated_at_ms (falling back to updated_at seconds)
}

/**
 * Columns without which enrichment is pointless or unsafe: the join key, the
 * grouping path, the archived flag we must honour, and the file pointer that
 * tells us whether the rollout scan already owns the session. If any is gone,
 * the schema has drifted far enough that we skip enrichment entirely rather
 * than guess.
 */
const REQUIRED_COLUMNS = ["id", "rollout_path", "cwd", "archived"] as const;

/**
 * Nice-to-have columns, each selected only if `PRAGMA table_info` confirms it.
 * A future Codex release renaming one of these degrades that single field
 * instead of killing all enrichment.
 */
const OPTIONAL_COLUMNS = [
  "title",
  "tokens_used",
  "model",
  "approval_mode",
  "git_branch",
  "git_origin_url",
  "source",
  "updated_at_ms",
  "updated_at",
] as const;

type SqliteModule = typeof import("node:sqlite");

let sqliteModule: SqliteModule | null | undefined;

/**
 * `node:sqlite` only exists from Node 22.5, and package.json still allows Node
 * 20, so it is required lazily inside a try instead of statically imported: on
 * an older runtime enrichment is simply unavailable rather than the whole
 * server failing to load. (The one-time ExperimentalWarning is expected.)
 */
function loadSqlite(): SqliteModule | null {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function cleanCount(value: unknown): number | undefined {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : NaN;
  // 0 means "nothing recorded" for tokens_used (NOT NULL DEFAULT 0), so it is
  // treated as absent rather than surfaced as a real "0 tokens" reading.
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function toIso(updatedAtMs: unknown, updatedAtSeconds: unknown): string | undefined {
  const ms = typeof updatedAtMs === "bigint" ? Number(updatedAtMs) : updatedAtMs;
  const seconds = typeof updatedAtSeconds === "bigint" ? Number(updatedAtSeconds) : updatedAtSeconds;
  const epochMs =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0
      ? ms
      : typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : undefined;
  if (epochMs === undefined) return undefined;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Reads every non-archived thread, keyed by `threads.id` — which is exactly the
 * `sessionId` the rollout scan produces, so it is the join key. Returns an
 * empty map for every failure mode; callers need no error handling.
 */
export function readCodexThreads(codexHome: string = codexHomeDir()): Map<string, CodexThread> {
  const threads = new Map<string, CodexThread>();

  const dbPath = findStateDbPath(codexHome);
  if (!dbPath) return threads;

  const sqlite = loadSqlite();
  if (!sqlite) return threads;

  let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });

    // Schema-drift guard. `PRAGMA table_info` on a missing table returns no
    // rows rather than throwing, so this covers "no threads table" too.
    const present = new Set<string>();
    for (const column of db.prepare("PRAGMA table_info(threads)").all()) {
      const name = cleanString((column as Record<string, unknown>).name);
      if (name) present.add(name);
    }
    if (!REQUIRED_COLUMNS.every((column) => present.has(column))) return threads;

    // Only ever our own literals reach the SQL string, and only after
    // table_info confirmed each one exists — no `SELECT *`, no DB-supplied
    // identifiers interpolated.
    const selected = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS.filter((c) => present.has(c))];
    const rows = db.prepare(`SELECT ${selected.join(", ")} FROM threads`).all();

    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      if (row.archived) continue; // truthy = archived; also skips a stray "1"

      const id = cleanString(row.id);
      const cwd = cleanString(row.cwd);
      if (!id || !cwd) continue;

      const entrypoint = cleanString(row.source);
      threads.set(id, {
        id,
        cwd,
        rolloutPath: cleanString(row.rollout_path),
        title: cleanString(row.title),
        tokensUsed: cleanCount(row.tokens_used),
        model: cleanString(row.model),
        approvalMode: cleanString(row.approval_mode),
        gitBranch: cleanString(row.git_branch),
        gitOriginUrl: cleanString(row.git_origin_url),
        // Subagent rows store a JSON object in `source`; keep only the plain markers.
        entrypoint: entrypoint?.startsWith("{") ? undefined : entrypoint,
        lastActivity: toIso(row.updated_at_ms, row.updated_at),
      });
    }
  } catch {
    // Missing file, SQLITE_BUSY, WAL lock, corruption, permissions: no
    // enrichment, and the rollout scan carries on untouched.
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      // already closed / never opened
    }
  }

  return threads;
}
