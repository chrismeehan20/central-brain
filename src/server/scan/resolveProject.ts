import fs from "node:fs";
import path from "node:path";
import type { Override, Project, SessionRef } from "@shared/types.js";
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

const MAX_ALIAS_HOPS = 10;

/**
 * Follows `movedTo` relocations to the path a project actually lives at now.
 *
 * Chains are followed (a folder moved twice) but bounded, and a cycle — which
 * a user can create by relocating A to B and later B back to A — resolves to
 * the last path visited instead of hanging the scan.
 */
export function resolveAlias(projectPath: string, overrides: Record<string, Override>): string {
  let current = projectPath;
  const seen = new Set([current]);
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const next = overrides[current]?.movedTo;
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

interface Group {
  sessions: SessionRef[];
  mergedFrom: Set<string>; // old paths folded in, for the UI to explain the merge
}

/**
 * Group sessions by project path, merging keys that differ only by case —
 * macOS is case-insensitive, so those are the same project. Prefers a casing
 * that actually exists on disk. Relocated paths (`movedTo`) are folded into
 * their new home first, so a moved project keeps one continuous history.
 */
function groupSessions(
  scans: Array<Record<string, SessionRef[]>>,
  overrides: Record<string, Override>
): Map<string, Group> {
  const grouped = new Map<string, Group>();
  const chosenByLower = new Map<string, string>();

  const groupFor = (key: string): Group => {
    const existing = grouped.get(key);
    if (existing) return existing;
    const created: Group = { sessions: [], mergedFrom: new Set() };
    grouped.set(key, created);
    return created;
  };

  for (const scan of scans) {
    for (const [scanned, refs] of Object.entries(scan)) {
      const raw = resolveAlias(scanned, overrides);
      const lower = raw.toLowerCase();
      let key = chosenByLower.get(lower);
      if (!key) {
        chosenByLower.set(lower, raw);
        key = raw;
      } else if (key !== raw && !fs.existsSync(key) && fs.existsSync(raw)) {
        // Re-key to the casing that actually exists on disk.
        const prev = grouped.get(key) ?? { sessions: [], mergedFrom: new Set<string>() };
        grouped.delete(key);
        chosenByLower.set(lower, raw);
        grouped.set(raw, prev);
        key = raw;
      }
      const group = groupFor(key);
      group.sessions.push(...refs);
      if (scanned !== key) group.mergedFrom.add(scanned);
    }
  }
  return grouped;
}

export function resolveProjects(): Project[] {
  const overrides = overridesDb.data;
  const grouped = groupSessions([scanClaudeProjects(), scanCodexProjects()], overrides);
  const projects: Project[] = [];

  for (const [key, group] of grouped) {
    const { sessions, mergedFrom } = group;
    if (!sessions.length) continue;

    sessions.sort((a, b) => (a.lastActivity > b.lastActivity ? -1 : 1));

    const override = overrides[key];
    const markdown = scanMarkdown(key);

    projects.push({
      path: key,
      displayName: override?.displayName ?? defaultDisplayName(key),
      discovered: !override,
      hidden: override?.hidden ?? false,
      pinned: override?.pinned ?? false,
      missing: !fs.existsSync(key),
      ...(mergedFrom.size > 0 ? { mergedFrom: [...mergedFrom] } : {}),
      lastActivity: sessions[0]?.lastActivity,
      sessions,
      markdown,
    });
  }

  projects.sort(compareProjects);

  return projects;
}

export function compareProjects(a: Project, b: Project): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
}
