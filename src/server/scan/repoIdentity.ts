import fs from "node:fs";
import path from "node:path";

/**
 * Which repository a checkout belongs to, discovered from plain file reads —
 * no `git` subprocess, because this runs inside the synchronous scan path for
 * every project on every scan.
 *
 * Two checkouts are the same repository when either:
 *  - one is a linked worktree of the other (`.git` is a *file* containing
 *    `gitdir: <main>/.git/worktrees/<name>`), or
 *  - they share a normalized `remote.origin.url` in `.git/config`.
 */
export interface RepoIdentity {
  /**
   * Stable grouping key: `remote:<normalized-url>` when an origin exists,
   * else `main:<main-checkout-path>` (which is the path itself for an
   * ordinary repo, and the linked-to main checkout for a worktree — so a
   * remoteless main repo and its worktrees still share a key). Null when the
   * directory isn't a git checkout at all.
   */
  repoKey: string | null;
  /** True for the repo's main checkout (`.git` is a directory). */
  isMainWorktree: boolean;
  /** Checked-out branch, when HEAD is a readable symbolic ref. */
  branch?: string;
}

/**
 * Collapse the ways one remote gets written — SSH vs HTTPS, trailing `.git`,
 * trailing slash, credentials in the URL — into one comparable string.
 * Host and path are lowercased; GitHub is case-insensitive about both, and a
 * rename that only changes case shouldn't split a project in two.
 */
export function normalizeRemoteUrl(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  // git@github.com:user/repo(.git) → github.com/user/repo
  const ssh = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+)$/.exec(
    s.replace(/^[a-z+]+:\/\//i, "")
  );
  if (!ssh) return null;
  const host = ssh[1].toLowerCase();
  const repoPath = ssh[2]
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!repoPath) return null;
  return `${host}/${repoPath}`;
}

/** `url = ...` under `[remote "origin"]`, parsed without a git subprocess. */
export function originUrlFromConfig(configText: string): string | null {
  let inOrigin = false;
  for (const rawLine of configText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function readIfFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Branch name from a HEAD file's `ref: refs/heads/<branch>`; undefined when detached/unreadable. */
function branchFromHead(headPath: string): string | undefined {
  const head = readIfFile(headPath);
  const m = head && /^ref:\s*refs\/heads\/(.+)\s*$/m.exec(head);
  return m ? m[1].trim() : undefined;
}

function keyForMainCheckout(checkoutPath: string): string {
  const config = readIfFile(path.join(checkoutPath, ".git", "config"));
  const origin = config && originUrlFromConfig(config);
  const normalized = origin && normalizeRemoteUrl(origin);
  return normalized ? `remote:${normalized}` : `main:${checkoutPath}`;
}

/**
 * Identify the repository at `projectPath`. All failure modes — no `.git`,
 * an unreadable config, a worktree whose main repo was deleted out from
 * under it (a real case on this machine) — degrade to less grouping, never
 * to a throw.
 */
export function detectRepoIdentity(projectPath: string): RepoIdentity {
  const gitPath = path.join(projectPath, ".git");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return { repoKey: null, isMainWorktree: false };
  }

  if (stat.isDirectory()) {
    return {
      repoKey: keyForMainCheckout(projectPath),
      isMainWorktree: true,
      branch: branchFromHead(path.join(gitPath, "HEAD")),
    };
  }

  // `.git` is a file → linked worktree. Its gitdir looks like
  // <main>/.git/worktrees/<name>; the main checkout is three levels up.
  const gitFile = readIfFile(gitPath);
  const m = gitFile && /^gitdir:\s*(.+)\s*$/m.exec(gitFile);
  if (!m) return { repoKey: null, isMainWorktree: false };
  const gitdir = path.resolve(projectPath, m[1].trim());

  const worktreesDir = path.dirname(gitdir); // <main>/.git/worktrees
  const mainGitDir = path.dirname(worktreesDir); // <main>/.git
  if (path.basename(worktreesDir) !== "worktrees" || path.basename(mainGitDir) !== ".git") {
    // Unexpected layout (submodule gitdirs land here too) — don't guess.
    return { repoKey: null, isMainWorktree: false };
  }
  const mainCheckout = path.dirname(mainGitDir);

  return {
    // Key via the main checkout so worktrees group with it whether or not the
    // repo has a remote — and even when the main checkout has been deleted
    // (keyForMainCheckout then falls back to `main:<path>`, which still
    // groups sibling worktrees of the same vanished main with each other).
    repoKey: keyForMainCheckout(mainCheckout),
    isMainWorktree: false,
    branch: branchFromHead(path.join(gitdir, "HEAD")),
  };
}
