import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AttentionPr, AttentionType, Project } from "@shared/types.js";
import { REPO_SLUG_RE } from "@shared/types.js";
import { aggregateCheckRollup, type CiClass } from "./ghClient.js";
import { normalizeRemoteUrl, originUrlFromConfig } from "../scan/repoIdentity.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 15_000;

/**
 * Work done by a Claude session running in the cloud — claude.ai/code, or the
 * desktop app's Code tab driving a remote container — leaves nothing on this
 * machine. No transcript lands in ~/.claude/projects, so the scanners never
 * see it; the container cannot reach a 127.0.0.1 hook endpoint, so the
 * attention pipeline never hears from it either.
 *
 * What it does leave is a branch and a pull request, under your own GitHub
 * identity. That is the signal this module reads: your open PRs are the
 * durable, machine-readable trace of remote agent work, and "a PR of yours is
 * conflicted / red / sitting there finished" is the same question the rest of
 * the app already answers for local sessions.
 *
 * Read-only, through the `gh` CLI the app already depends on, so it needs no
 * new token and no inbound network path.
 */

/** One PR as `gh pr list --json` returns it. Fields we don't ask for are absent, not null. */
export interface RemotePrJson {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** "MERGEABLE" | "CONFLICTING" | "UNKNOWN" */
  mergeable?: string;
  /** "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED", or "" in a repo that requires no review. */
  reviewDecision?: string;
  headRefName?: string;
  updatedAt?: string;
  statusCheckRollup?: unknown;
}

export const PR_JSON_FIELDS =
  "number,title,url,isDraft,mergeable,reviewDecision,headRefName,updatedAt,statusCheckRollup";

/**
 * Only speak up once the PR has been quiet this long.
 *
 * A cloud session pushing a fix every two minutes is not waiting on you, and
 * the harness those sessions run under actively drives its own PR to green —
 * so alerting on a red check the agent is already fixing would put us in a
 * shouting match with it. Quiet means the agent stopped.
 */
export const QUIET_MS = 15 * 60_000;

/**
 * Past this, a PR is backlog rather than news, and the panel says nothing.
 * Same reasoning as the Codex heuristic's ABANDONED window: an alert you have
 * scrolled past fifty times is not an alert. Env-overridable (ms).
 */
export const MAX_AGE_MS = Number(process.env.REMOTE_PR_MAX_AGE_MS ?? 7 * 24 * 60 * 60_000);

export interface PrVerdict {
  type: Extract<AttentionType, "pr-conflict" | "pr-ci-failed" | "pr-review">;
  message: string;
}

/**
 * What, if anything, this PR needs from the user right now.
 *
 * Ordered by what blocks hardest: a conflict makes the PR unmergeable no
 * matter how green it is, red CI makes it unmergeable-in-spirit, and
 * everything else is some flavour of "it's on you now". Returns null for a PR
 * that is genuinely mid-flight (still inside the quiet window, or with checks
 * still running) — silence is the correct output for work in progress.
 */
export function classifyPr(pr: RemotePrJson, now: number): PrVerdict | null {
  const updatedAt = pr.updatedAt ? Date.parse(pr.updatedAt) : NaN;
  // No usable timestamp means we cannot tell in-flight from finished, and
  // guessing wrong here is exactly the noise this window exists to prevent.
  if (Number.isNaN(updatedAt)) return null;
  const quietFor = now - updatedAt;
  if (quietFor < QUIET_MS || quietFor > MAX_AGE_MS) return null;

  if (pr.mergeable === "CONFLICTING") {
    return { type: "pr-conflict", message: "Merge conflict with the base branch" };
  }

  const ci: CiClass | undefined = aggregateCheckRollup(pr.statusCheckRollup);
  if (ci === "failure") {
    return {
      type: "pr-ci-failed",
      message: pr.headRefName ? `CI failing on ${pr.headRefName}` : "CI failing",
    };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { type: "pr-review", message: "Changes requested — needs another pass" };
  }
  // Checks still running: the verdict is not in yet, so neither is ours.
  if (ci === "pending") return null;

  if (pr.isDraft) {
    return {
      type: "pr-review",
      message: ci === "success" ? "Draft finished — CI green" : "Draft finished",
    };
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return { type: "pr-review", message: "Waiting for review" };
  }
  return { type: "pr-review", message: "Ready to merge" };
}

export function toAttentionPr(repo: string, pr: RemotePrJson): AttentionPr {
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    ...(pr.headRefName ? { branch: pr.headRefName } : {}),
  };
}

/**
 * `owner/repo` for a checkout whose origin is on github.com, else null.
 *
 * Reads `.git/config` directly rather than shelling out to `git remote`: this
 * runs once per project per pass, and the scan path already parses this exact
 * file the same way (scan/repoIdentity.ts) for repo grouping.
 */
export function repoSlugForCheckout(
  checkoutPath: string,
  readFile: (p: string) => string | null = defaultReadFile,
): string | null {
  const config = readFile(path.join(checkoutPath, ".git", "config"));
  if (!config) return null;
  const origin = originUrlFromConfig(config);
  const normalized = origin && normalizeRemoteUrl(origin);
  if (!normalized) return null;
  const [host, ...rest] = normalized.split("/");
  if (host !== "github.com") return null;
  const slug = rest.join("/");
  // A nested path (an enterprise-style owner/team/repo) is not addressable by
  // `gh --repo`, and a slug that fails the shape check never reaches argv.
  return REPO_SLUG_RE.test(slug) ? slug : null;
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Ceiling on repos queried per pass. One `gh` call each against a 5000/hr
 * budget is not the constraint; 25 subprocesses on a laptop is.
 */
export const MAX_REPOS = 25;

/**
 * Every GitHub repo worth asking about, mapped to the local project it belongs
 * to (`"unknown"` for a watched repo with no checkout here).
 *
 * Discovered projects come first and in their existing order — the scan sorts
 * by pinned-then-recency, so the cap bites on the projects you care least
 * about — then the manually watched slugs, which are the only way to cover a
 * repo you have never cloned locally.
 */
export function resolveWatchedRepos(
  projects: Project[],
  extraRepos: string[],
  slugFor: (checkoutPath: string) => string | null = (p) => repoSlugForCheckout(p),
): Map<string, string> {
  const watched = new Map<string, string>();
  for (const project of projects) {
    if (project.hidden || project.missing) continue;
    const slug = slugFor(project.path);
    if (slug && !watched.has(slug)) watched.set(slug, project.path);
  }
  for (const raw of extraRepos) {
    const slug = raw.trim();
    if (!REPO_SLUG_RE.test(slug)) continue;
    // A locally-known repo keeps its project mapping; the manual entry is a
    // duplicate of it, not an override.
    if (!watched.has(slug)) watched.set(slug, "unknown");
  }
  return new Map([...watched].slice(0, MAX_REPOS));
}

export type ExecLike = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: ExecLike = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, { timeout: TIMEOUT_MS, cwd: os.homedir() });
  return stdout.trim();
};

/**
 * Your open PRs in one repo. Runs with `--repo`, so it needs no checkout and
 * works for a repo that exists only in the cloud.
 *
 * `@me` resolves to whoever `gh` is authenticated as — the same identity a
 * cloud session pushes under, which is what makes its PRs findable at all.
 * Throws on failure (no `gh`, no auth, offline, repo gone) so the caller can
 * tell "nothing to report" apart from "could not ask".
 */
export async function fetchAuthoredPrs(
  repo: string,
  exec: ExecLike = defaultExec,
): Promise<RemotePrJson[]> {
  if (!REPO_SLUG_RE.test(repo)) throw new Error(`refusing to query malformed repo slug: ${repo}`);
  const stdout = await exec("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--author",
    "@me",
    "--state",
    "open",
    "--limit",
    "20",
    "--json",
    PR_JSON_FIELDS,
  ]);
  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? (parsed as RemotePrJson[]) : [];
}
