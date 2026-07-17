import fs from "node:fs";
import path from "node:path";
import type { Project, SessionRef } from "@shared/types.js";
import { scanClaudeProjects } from "./claude.js";
import { scanCodexProjects } from "./codex.js";
import { scanMarkdown } from "./markdown.js";
import { overridesDb } from "../store/db.js";

function defaultDisplayName(projectPath: string): string {
  return path
    .basename(projectPath)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Group sessions by project path, merging keys that differ only by case —
 * macOS is case-insensitive, so those are the same project. Prefers a casing
 * that actually exists on disk.
 */
function groupSessions(scans: Array<Record<string, SessionRef[]>>): Map<string, SessionRef[]> {
  const grouped = new Map<string, SessionRef[]>();
  const chosenByLower = new Map<string, string>();

  for (const scan of scans) {
    for (const [raw, refs] of Object.entries(scan)) {
      const lower = raw.toLowerCase();
      let key = chosenByLower.get(lower);
      if (!key) {
        chosenByLower.set(lower, raw);
        key = raw;
      } else if (key !== raw && !fs.existsSync(key) && fs.existsSync(raw)) {
        // Re-key to the casing that actually exists on disk.
        const prev = grouped.get(key) ?? [];
        grouped.delete(key);
        chosenByLower.set(lower, raw);
        grouped.set(raw, prev);
        key = raw;
      }
      grouped.set(key, [...(grouped.get(key) ?? []), ...refs]);
    }
  }
  return grouped;
}

export function resolveProjects(): Project[] {
  const grouped = groupSessions([scanClaudeProjects(), scanCodexProjects()]);
  const projects: Project[] = [];

  for (const [key, sessions] of grouped) {
    if (!sessions.length) continue;

    sessions.sort((a, b) => (a.lastActivity > b.lastActivity ? -1 : 1));

    const override = overridesDb.data[key];
    const markdown = scanMarkdown(key);

    projects.push({
      path: key,
      displayName: override?.displayName ?? defaultDisplayName(key),
      discovered: !override,
      hidden: override?.hidden ?? false,
      pinned: override?.pinned ?? false,
      missing: !fs.existsSync(key),
      lastActivity: sessions[0]?.lastActivity,
      sessions,
      markdown,
    });
  }

  projects.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
  });

  return projects;
}
