import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { SessionRef } from "@shared/types.js";
import { canonicalize, toUtcIso } from "./paths.js";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/**
 * Transcripts are append-only JSONL and the metadata we need (`cwd`,
 * `gitBranch`, `entrypoint`, first prompt) lives on the first `type: "user"`
 * entry, which is essentially always within the first handful of lines. So we
 * read forward in chunks and stop the instant we have it, rather than slurping
 * a file that can be tens of megabytes.
 *
 * 64 KiB is a single comfortable read syscall and already covers the first
 * user entry in ~84% of the transcripts on a real machine (median offset is
 * ~1 KB). The remaining cases are transcripts whose first prompt is a huge
 * paste - the line itself is 1-2 MB - so we keep reading chunks until the line
 * is complete. 4 MiB is the give-up cap: it comfortably clears the largest
 * real first-user-line observed (~2.0 MB) while bounding the worst case at
 * ~6% of the largest transcript (63 MB) instead of 100% of it. Past the cap we
 * return nothing rather than parsing a truncated line, and the caller falls
 * back to a sibling transcript's cwd.
 */
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

// Reused across calls: scanning is synchronous and single-threaded, so the
// buffer never has two readers at once.
const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface SessionsIndex {
  version: number;
  entries: SessionsIndexEntry[];
  originalPath?: string;
}

export type ScannedSessions = Record<string, SessionRef[]>;

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface FirstUserLineInfo {
  cwd?: string;
  entrypoint?: string;
  gitBranch?: string;
  firstText?: string;
}

/** Returns info only for the first `type: "user"` entry that carries a `cwd`. */
function parseUserLine(line: string): FirstUserLineInfo | null {
  if (!line.trim()) return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    // Malformed or truncated line - skip it, keep scanning.
    return null;
  }
  if (obj?.type !== "user" || !obj.cwd) return null;
  const text = Array.isArray(obj.message?.content)
    ? obj.message.content.find((c: any) => c.type === "text")?.text
    : undefined;
  return {
    cwd: obj.cwd,
    entrypoint: obj.entrypoint,
    gitBranch: obj.gitBranch,
    firstText: typeof text === "string" ? text : undefined,
  };
}

/**
 * Bounded forward scan of a JSONL transcript for the first `type: "user"`
 * entry with a `cwd`. Reads at most MAX_SCAN_BYTES and returns as soon as the
 * entry is found. A trailing partial line is only parsed once EOF is reached,
 * never when we stopped at the cap.
 */
function firstUserLineInfo(jsonlPath: string): FirstUserLineInfo {
  let fd: number | undefined;
  try {
    fd = fs.openSync(jsonlPath, "r");
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let scanned = 0;
    let reachedEof = false;

    while (scanned < MAX_SCAN_BYTES) {
      const want = Math.min(READ_CHUNK_BYTES, MAX_SCAN_BYTES - scanned);
      const bytesRead = fs.readSync(fd, readBuffer, 0, want, null);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      scanned += bytesRead;
      // StringDecoder keeps multi-byte characters straddling a chunk boundary intact.
      pending += decoder.write(readBuffer.subarray(0, bytesRead));

      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const info = parseUserLine(pending.slice(0, newline));
        if (info) return info;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }

    if (reachedEof) {
      // Last line of a file with no trailing newline is complete, so parse it.
      pending += decoder.end();
      const info = parseUserLine(pending);
      if (info) return info;
    }
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
  return {};
}

interface RawTranscript {
  sessionId: string;
  fullPath: string;
  mtime: Date;
  info: FirstUserLineInfo;
}

/**
 * Scans ~/.claude/projects for both the CLI and VS Code extension (they
 * share the same store). Prefers sessions-index.json since it survives
 * transcript auto-cleanup; falls back to reading raw .jsonl transcripts
 * for sessions not (yet) covered by an index.
 *
 * `projectsDir` is injectable so tests can point the scan at a fixture tree.
 */
export function scanClaudeProjects(projectsDir: string = CLAUDE_PROJECTS_DIR): ScannedSessions {
  const result: ScannedSessions = {};
  if (!fs.existsSync(projectsDir)) return result;

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return result;
  }

  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir.name);
    const index = readJsonSafe<SessionsIndex>(path.join(dirPath, "sessions-index.json"));
    const seenSessionIds = new Set<string>();
    // Project paths recorded by the index, used as a fallback for transcripts
    // in this directory that yield no cwd of their own.
    const indexProjectPaths: string[] = [];
    if (index?.originalPath) indexProjectPaths.push(index.originalPath);

    if (index?.entries?.length) {
      for (const entry of index.entries) {
        if (entry.isSidechain) continue;
        const rawPath = entry.projectPath ?? index.originalPath;
        if (!rawPath) continue;
        indexProjectPaths.push(rawPath);

        const key = canonicalize(rawPath);
        const ref: SessionRef = {
          tool: "claude",
          sessionId: entry.sessionId,
          lastActivity: toUtcIso(entry.modified, new Date(entry.fileMtime).toISOString()),
          firstPrompt: entry.firstPrompt && entry.firstPrompt !== "No prompt" ? entry.firstPrompt : undefined,
          summary: entry.summary,
          gitBranch: entry.gitBranch,
          transcriptPath: entry.fullPath,
        };
        (result[key] ??= []).push(ref);
        seenSessionIds.add(entry.sessionId);
      }
    }

    let jsonlFiles: string[] = [];
    try {
      jsonlFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    const transcripts: RawTranscript[] = [];
    for (const file of jsonlFiles) {
      const sessionId = file.replace(/\.jsonl$/, "");
      if (seenSessionIds.has(sessionId)) continue;

      const fullPath = path.join(dirPath, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      transcripts.push({ sessionId, fullPath, mtime: stat.mtime, info: firstUserLineInfo(fullPath) });
    }

    // Every transcript under one ~/.claude/projects/<dir> belongs to the same
    // project, so a sibling that did report a cwd (or the index's recorded
    // project path) stands in for one that didn't - otherwise the session
    // would be dropped entirely. The directory name is deliberately NOT
    // decoded: it is ambiguous whenever a path segment contains a hyphen.
    const fallbackPath = transcripts.find((t) => t.info.cwd)?.info.cwd ?? indexProjectPaths[0];

    for (const transcript of transcripts) {
      const rawPath = transcript.info.cwd ?? fallbackPath;
      if (!rawPath) continue;

      const key = canonicalize(rawPath);
      const ref: SessionRef = {
        tool: "claude",
        sessionId: transcript.sessionId,
        lastActivity: transcript.mtime.toISOString(),
        firstPrompt: transcript.info.firstText,
        gitBranch: transcript.info.gitBranch,
        entrypoint: transcript.info.entrypoint,
        transcriptPath: transcript.fullPath,
      };
      (result[key] ??= []).push(ref);
    }
  }

  return result;
}
