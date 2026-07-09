import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionRef } from "@shared/types.js";
import { canonicalize } from "./paths.js";

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const SESSION_INDEX_FILE = path.join(os.homedir(), ".codex", "session_index.jsonl");

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

function readSessionMeta(filePath: string): RolloutMeta | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.toString("utf8", 0, bytesRead);
    const firstLine = text.split("\n")[0];
    const obj = JSON.parse(firstLine);
    if (obj.type === "session_meta" && obj.payload) {
      return {
        id: obj.payload.id,
        cwd: obj.payload.cwd,
        originator: obj.payload.originator,
        source: obj.payload.source,
      };
    }
  } catch {
    // first line may be incomplete on a just-created file; skip for now
  }
  return null;
}

function readThreadNames(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(SESSION_INDEX_FILE, "utf8");
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
 */
export function scanCodexProjects(): ScannedSessions {
  const result: ScannedSessions = {};
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return result;

  const threadNames = readThreadNames();
  const files = walkRolloutFiles(CODEX_SESSIONS_DIR);

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
