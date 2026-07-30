import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RelocationCandidate, RelocationConfidence } from "@shared/types.js";

/**
 * Finds where a missing project probably moved to.
 *
 * A project goes "missing" whenever its folder is renamed or moved — the
 * session transcripts still record the old absolute path, so the card survives
 * pointing at nothing. Reorganising a code folder once can strand dozens of
 * projects at a stroke, which is far too many to re-point by hand.
 *
 * The search is deliberately name-based rather than content-based: the old
 * folder is gone, so there is nothing left to compare against it. All we have
 * is its path, and the observation that a move usually preserves the folder
 * name and often some of the parent structure.
 *
 * Everything here is a guess, so every candidate carries a score and a
 * human-readable reason and nothing is ever applied automatically.
 */

const MAX_DEPTH = 4;
const MAX_DIRS = 50_000; // bounds a walk that would otherwise chase a huge home dir

/** Never worth descending into, and expensive when they are deep. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  "Library",
  "Applications",
]);

/**
 * Folder names too common to identify anything on their own — `backend` matches
 * a dozen repos. Scored down so they surface as "review this" rather than a
 * confident answer.
 */
const GENERIC_NAMES = new Set([
  "web", "www", "app", "apps", "api", "src", "backend", "frontend", "server",
  "client", "docs", "doc", "site", "website", "main", "project", "projects",
  "code", "lib", "libs", "packages", "package", "test", "tests", "ui", "mobile",
  "ios", "android", "scripts", "tools", "other", "misc", "temp", "tmp", "new",
]);

/** A copy kept for posterity is rarely where the live project went. */
const ARCHIVE_SEGMENT = /(^|[\s\-_.])(archive[sd]?|backup[s]?|old|copy|deprecated|trash)([\s\-_.]|$)/i;

/** Roots probed in addition to wherever live projects already are. */
const COMMON_ROOT_NAMES = ["code", "Documents", "projects", "src", "dev", "repos", "Developer", "work"];

export interface SearchRootInputs {
  /** Paths of projects that DO exist on disk — the best evidence for where code lives. */
  livePaths?: string[];
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/**
 * Where to look. Live projects are the strongest signal — a moved project
 * almost always lands next to its siblings — so their top-level home
 * directories come first, with the usual suspects as a backstop.
 *
 * Roots are truncated to one level below home so that a live project at
 * `~/code/foo/bar` makes us search all of `~/code`, not just `~/code/foo`.
 */
export function deriveSearchRoots({
  livePaths = [],
  env = process.env,
  homedir = os.homedir(),
}: SearchRootInputs = {}): string[] {
  const explicit = env.CENTRAL_BRAIN_SEARCH_ROOTS?.trim();
  if (explicit) {
    return dedupeRoots(explicit.split(":").map((r) => r.trim()).filter(Boolean));
  }

  const roots: string[] = [];
  for (const live of livePaths) {
    const relative = path.relative(homedir, live);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const [top] = relative.split(path.sep);
    // Skip dotted roots (`~/.codex`, `~/.claude`): those hold agent worktrees,
    // which are throwaway checkouts of a repo that also exists for real
    // somewhere else — exactly the wrong answer to "where did this move to".
    if (top && !top.startsWith(".")) roots.push(path.join(homedir, top));
  }
  for (const name of COMMON_ROOT_NAMES) roots.push(path.join(homedir, name));

  return dedupeRoots(roots);
}

/** Drops duplicates, non-directories, and roots already covered by an ancestor root. */
function dedupeRoots(roots: string[]): string[] {
  const unique = [...new Set(roots.map((r) => path.resolve(r)))].filter(isDirectory);
  return unique.filter(
    (root) => !unique.some((other) => other !== root && root.startsWith(other + path.sep))
  );
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** basename (lowercased) -> every directory with that name under the roots. */
function indexDirectories(roots: string[], maxDepth: number, maxDirs: number): Map<string, string[]> {
  const index = new Map<string, string[]>();
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited >= maxDirs) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, a dead symlink) — not fatal, just unsearchable
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (visited >= maxDirs) return;
      visited++;
      const full = path.join(dir, entry.name);
      const key = entry.name.toLowerCase();
      index.set(key, [...(index.get(key) ?? []), full]);
      walk(full, depth + 1);
    }
  };

  for (const root of roots) walk(root, 1);
  return index;
}

/** How many trailing path segments the two paths share, ignoring the basename itself. */
function sharedParentSegments(oldPath: string, candidate: string): number {
  const a = oldPath.split(path.sep).slice(0, -1).reverse();
  const b = candidate.split(path.sep).slice(0, -1).reverse();
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared].toLowerCase() === b[shared].toLowerCase()) {
    shared++;
  }
  return shared;
}

const BASE_SCORE = 0.5;
const PARENT_SEGMENT_BONUS = 0.15;
const MAX_PARENT_BONUS = 0.45;
/**
 * Being the *only* folder of that name anywhere under the search roots is
 * strong on its own — enough, with the base score, to clear HIGH_SCORE when
 * nothing argues against it.
 */
const UNIQUE_BONUS = 0.2;
const GIT_BONUS = 0.1;
const GENERIC_PENALTY = 0.25;
const ARCHIVE_PENALTY = 0.25;

const HIGH_SCORE = 0.7;
const MEDIUM_SCORE = 0.4;
/** A high-confidence guess also has to be clearly ahead of the runner-up. */
const HIGH_MARGIN = 0.15;

function scoreCandidate(oldPath: string, candidate: string, isOnlyMatch: boolean): RelocationCandidate {
  const reasons: string[] = ["same folder name"];
  let score = BASE_SCORE;

  const shared = sharedParentSegments(oldPath, candidate);
  if (shared > 0) {
    score += Math.min(shared * PARENT_SEGMENT_BONUS, MAX_PARENT_BONUS);
    reasons.push(`${shared} matching parent folder${shared === 1 ? "" : "s"}`);
  }

  if (isOnlyMatch) {
    score += UNIQUE_BONUS;
    reasons.push("only match found");
  }

  if (fs.existsSync(path.join(candidate, ".git"))) {
    score += GIT_BONUS;
    reasons.push("git repo");
  }

  if (GENERIC_NAMES.has(path.basename(candidate).toLowerCase())) {
    score -= GENERIC_PENALTY;
    reasons.push("common folder name");
  }

  // Only penalise archive-ish segments the old path did not itself have.
  const newSegments = candidate.split(path.sep).filter((s) => !oldPath.split(path.sep).includes(s));
  if (newSegments.some((s) => ARCHIVE_SEGMENT.test(s))) {
    score -= ARCHIVE_PENALTY;
    reasons.push("looks archived");
  }

  return {
    path: candidate,
    score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
    confidence: "low", // finalised in rank(), which can see the runner-up
    reason: reasons.join(", "),
  };
}

function rank(candidates: RelocationCandidate[]): RelocationCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return sorted.map((candidate, i) => {
    const margin = i === 0 ? candidate.score - (sorted[1]?.score ?? 0) : 0;
    let confidence: RelocationConfidence = "low";
    if (i === 0 && candidate.score >= HIGH_SCORE && margin >= HIGH_MARGIN) confidence = "high";
    else if (candidate.score >= MEDIUM_SCORE) confidence = "medium";
    return { ...candidate, confidence };
  });
}

export interface RelocationInputs {
  /** Paths of the missing projects to find homes for. */
  missingPaths: string[];
  /** Where to search. Defaults to deriveSearchRoots(). */
  roots?: string[];
  maxDepth?: number;
  maxDirs?: number;
}

/**
 * Maps each missing path to its ranked candidates (best first, empty when
 * nothing matched). One directory walk serves every missing project.
 */
export function findRelocations({
  missingPaths,
  roots = deriveSearchRoots(),
  maxDepth = MAX_DEPTH,
  maxDirs = MAX_DIRS,
}: RelocationInputs): Record<string, RelocationCandidate[]> {
  const result: Record<string, RelocationCandidate[]> = {};
  if (missingPaths.length === 0) return result;

  const index = indexDirectories(roots, maxDepth, maxDirs);

  for (const missing of missingPaths) {
    const matches = (index.get(path.basename(missing).toLowerCase()) ?? []).filter(
      (candidate) => candidate !== missing
    );
    result[missing] = rank(
      matches.map((candidate) => scoreCandidate(missing, candidate, matches.length === 1))
    );
  }

  return result;
}
