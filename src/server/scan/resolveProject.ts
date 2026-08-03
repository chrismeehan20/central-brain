import fs from "node:fs";
import path from "node:path";
import type { Override, Project, ProjectCheckout, SessionRef } from "@shared/types.js";
import { scanClaudeProjects } from "./claude.js";
import { scanCodexProjects } from "./codex.js";
import { scanMarkdown } from "./markdown.js";
import { detectRepoIdentity, type RepoIdentity } from "./repoIdentity.js";
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

/**
 * Fold projects that are checkouts of the same repository into one card.
 *
 * Only projects that exist on disk take part — a missing path can't be
 * probed for its `.git`, and it already has its own triage flow (relocation).
 * The primary checkout is the repo's main worktree when it's in the group,
 * else the most recently active member; it contributes the card's path,
 * name, overrides and docs, while sessions and lastActivity cover the set.
 *
 * `identityFor` is injectable so the grouping rules are testable without a
 * filesystem full of fixture repos.
 */
export function groupProjectsByRepo(
  projects: Project[],
  identityFor: (projectPath: string) => RepoIdentity = detectRepoIdentity
): Project[] {
  const identities = new Map<string, RepoIdentity>();
  const groups = new Map<string, Project[]>();

  for (const project of projects) {
    const identity = project.missing
      ? { repoKey: null, isMainWorktree: false }
      : identityFor(project.path);
    identities.set(project.path, identity);
    const key = identity.repoKey ?? `solo:${project.path}`;
    const members = groups.get(key);
    if (members) members.push(project);
    else groups.set(key, [project]);
  }

  const result: Project[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      result.push(members[0]);
      continue;
    }

    const byRecency = (a: Project, b: Project) =>
      (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
    const primary =
      members.find((m) => identities.get(m.path)?.isMainWorktree) ??
      [...members].sort(byRecency)[0];

    const sessions = members
      .flatMap((m) => m.sessions)
      .sort((a, b) => (a.lastActivity > b.lastActivity ? -1 : 1));

    const checkouts: ProjectCheckout[] = members
      .map((m) => ({
        path: m.path,
        primary: m === primary,
        branch: identities.get(m.path)?.branch,
        lastActivity: m.lastActivity,
        sessionCount: m.sessions.length,
      }))
      .sort((a, b) => {
        if (a.primary !== b.primary) return a.primary ? -1 : 1;
        return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
      });

    result.push({
      ...primary,
      sessions,
      lastActivity: sessions[0]?.lastActivity,
      checkouts,
    });
  }
  return result;
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

  const byRepo = groupProjectsByRepo(projects);
  byRepo.sort(compareProjects);

  return byRepo;
}

export function compareProjects(a: Project, b: Project): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
}
