import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { SessionRef } from "@shared/types.js";
import { canonicalize } from "./paths.js";

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const SESSION_INDEX_FILE = path.join(os.homedir(), ".codex", "session_index.jsonl");

/**
 * The `session_meta` first line of a rollout file is not small: it embeds
 * Codex's full `base_instructions` text, so across the 327 rollout files on a
 * real machine it measured min 3.2 KB / median 15.3 KB / p90 21.5 KB /
 * max 41.4 KB. A fixed 8 KiB read truncated 323 of those 327 lines mid-string,
 * `JSON.parse` threw, and every one of those sessions was silently dropped.
 *
 * So read forward in chunks until the first newline instead of using a fixed
 * window. 64 KiB is one comfortable read syscall and already contains the
 * whole first line for every rollout file observed, so the common case is a
 * single read. 1 MiB is the give-up cap: ~24x the largest real first line, so
 * `base_instructions` can grow a lot before it bites, while still bounding a
 * corrupt or newline-free file to 1 MiB instead of slurping a rollout file
 * that can be tens of megabytes.
 */
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 1024 * 1024;

// Reused across calls: scanning is synchronous and single-threaded, so the
// buffer never has two readers at once.
const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

interface RolloutMeta {
  id: string;
  cwd?: string;
  originator?: string;
  source?: string;
}

// session_meta (the first line) never changes once written, even as a
// rollout file grows via later appends/resumptions, so it's safe to cache
// keyed by birthtime.
const metaCache = new Map<string, { birthtimeMs: number; meta: RolloutMeta | null }>();

function walkRolloutFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkRolloutFiles(full));
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

function parseSessionMeta(line: string): RolloutMeta | null {
  if (!line.trim()) return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    // Truncated or malformed first line (e.g. a rollout file caught mid-write).
    return null;
  }
  if (obj?.type !== "session_meta" || !obj.payload) return null;
  return {
    id: obj.payload.id,
    cwd: obj.payload.cwd,
    originator: obj.payload.originator,
    source: obj.payload.source,
  };
}

/**
 * Reads the whole first line of a rollout file, however long it is, and parses
 * it as `session_meta`. Bounded by MAX_SCAN_BYTES so a file with no newline at
 * all can't be slurped entirely. Stays synchronous because
 * `scanCodexProjects()` is called synchronously from `resolveProjects()`.
 */
function readSessionMeta(filePath: string): RolloutMeta | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let scanned = 0;

    while (scanned < MAX_SCAN_BYTES) {
      const want = Math.min(READ_CHUNK_BYTES, MAX_SCAN_BYTES - scanned);
      const bytesRead = fs.readSync(fd, readBuffer, 0, want, null);
      if (bytesRead === 0) {
        // EOF with no newline: what we have is a complete final line, so parse it.
        return parseSessionMeta(pending + decoder.end());
      }
      scanned += bytesRead;
      // StringDecoder keeps multi-byte characters straddling a chunk boundary
      // intact - `cwd` and prompt text can contain non-ASCII.
      pending += decoder.write(readBuffer.subarray(0, bytesRead));

      const newline = pending.indexOf("\n");
      if (newline !== -1) return parseSessionMeta(pending.slice(0, newline));
    }
    // Hit the cap without a newline: never parse a knowingly truncated line.
  } catch {
    // unreadable file, skip
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already gone
      }
    }
  }
  return null;
}

function readThreadNames(sessionIndexFile: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(sessionIndexFile, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.id && obj.thread_name) map.set(obj.id, obj.thread_name);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no index file yet
  }
  return map;
}

export type ScannedSessions = Record<string, SessionRef[]>;

/**
 * Scans ~/.codex/sessions for both the CLI and VS Code extension (shared
 * store, confirmed via `source`/`originator` fields). Codex has no
 * sessions-index-style cwd shortcut, so every rollout file's first line
 * (session_meta) is read once and cached by birthtime.
 *
 * `sessionsDir` and `sessionIndexFile` are injectable so tests can point the
 * scan at a fixture tree.
 */
export function scanCodexProjects(
  sessionsDir: string = CODEX_SESSIONS_DIR,
  sessionIndexFile: string = SESSION_INDEX_FILE,
): ScannedSessions {
  const result: ScannedSessions = {};
  if (!fs.existsSync(sessionsDir)) return result;

  const threadNames = readThreadNames(sessionIndexFile);
  const files = walkRolloutFiles(sessionsDir);

  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    const cached = metaCache.get(file);
    let meta: RolloutMeta | null;
    if (cached && cached.birthtimeMs === stat.birthtimeMs) {
      meta = cached.meta;
    } else {
      meta = readSessionMeta(file);
      metaCache.set(file, { birthtimeMs: stat.birthtimeMs, meta });
    }

    if (!meta?.cwd) continue;

    const key = canonicalize(meta.cwd);
    const ref: SessionRef = {
      tool: "codex",
      sessionId: meta.id,
      lastActivity: stat.mtime.toISOString(),
      summary: threadNames.get(meta.id),
      entrypoint: meta.source,
      transcriptPath: file,
    };
    (result[key] ??= []).push(ref);
  }

  return result;
}
