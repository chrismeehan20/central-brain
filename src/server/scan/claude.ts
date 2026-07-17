import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionRef } from "@shared/types.js";
import { canonicalize, toUtcIso } from "./paths.js";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

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

function firstUserLineInfo(jsonlPath: string): FirstUserLineInfo {
  try {
    const raw = fs.readFileSync(jsonlPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === "user" && obj.cwd) {
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
    }
  } catch {
    // unreadable file, skip
  }
  return {};
}

/**
 * Scans ~/.claude/projects for both the CLI and VS Code extension (they
 * share the same store). Prefers sessions-index.json since it survives
 * transcript auto-cleanup; falls back to reading raw .jsonl transcripts
 * for sessions not (yet) covered by an index.
 */
export function scanClaudeProjects(): ScannedSessions {
  const result: ScannedSessions = {};
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return result;

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return result;
  }

  for (const dir of dirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir.name);
    const index = readJsonSafe<SessionsIndex>(path.join(dirPath, "sessions-index.json"));
    const seenSessionIds = new Set<string>();

    if (index?.entries?.length) {
      for (const entry of index.entries) {
        if (entry.isSidechain) continue;
        const rawPath = entry.projectPath ?? index.originalPath;
        if (!rawPath) continue;

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

      const info = firstUserLineInfo(fullPath);
      if (!info.cwd) continue;

      const key = canonicalize(info.cwd);
      const ref: SessionRef = {
        tool: "claude",
        sessionId,
        lastActivity: stat.mtime.toISOString(),
        firstPrompt: info.firstText,
        gitBranch: info.gitBranch,
        entrypoint: info.entrypoint,
        transcriptPath: fullPath,
      };
      (result[key] ??= []).push(ref);
    }
  }

  return result;
}
