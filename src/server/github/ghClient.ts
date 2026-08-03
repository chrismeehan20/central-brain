import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { GithubStatus } from "@shared/types.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 8000;

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: TIMEOUT_MS });
  return stdout.trim();
}

export type CiClass = "success" | "failure" | "pending";

/**
 * GitHub speaks three overlapping vocabularies for "how did it go" — CheckRun
 * `conclusion`, StatusContext `state`, and workflow-run `status` — and they all
 * arrive mixed together in the same arrays. Bucket every value we might see
 * once, so the rest of this file only reasons about failure/pending/success.
 */
const FAILURE_VALUES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const PENDING_VALUES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "EXPECTED",
  "WAITING",
  "REQUESTED",
]);
const SUCCESS_VALUES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * One enum value → its class. Unknown values (and "COMPLETED", which says
 * nothing about the outcome on its own) return undefined rather than a guess:
 * inventing a verdict is how a dashboard starts lying.
 */
function classifyValue(value: unknown): CiClass | undefined {
  const raw = reportedValue(value);
  if (raw === undefined) return undefined;
  if (FAILURE_VALUES.has(raw)) return "failure";
  if (PENDING_VALUES.has(raw)) return "pending";
  if (SUCCESS_VALUES.has(raw)) return "success";
  return undefined;
}

/** Upper-cased enum value, or undefined for null / "" / non-strings. */
function reportedValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.toUpperCase();
}

/** One rollup entry: a CheckRun (`status`/`conclusion`) or a StatusContext (`state`). */
function classifyRollupEntry(entry: unknown): CiClass | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  const raw = reportedValue(e.conclusion) ?? reportedValue(e.state) ?? reportedValue(e.status);
  // A CheckRun that hasn't finished reports `conclusion: null` — a check still
  // in flight, not a check with no opinion.
  if (raw === undefined) return "conclusion" in e || "status" in e ? "pending" : undefined;
  return classifyValue(raw);
}

/**
 * Worst-first verdict over a PR's WHOLE `statusCheckRollup`. Reading only the
 * first entry (as this used to) lets a passing lint job hide a failing test
 * suite, which is precisely the case you need the dashboard to shout about.
 *
 * Any failure-class check → "failure". Otherwise any check still running →
 * "pending". Otherwise, if at least one check actually passed → "success". No
 * checks at all → undefined.
 */
export function aggregateCheckRollup(rollup: unknown): CiClass | undefined {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  let pending = false;
  let success = false;
  for (const entry of rollup) {
    const cls = classifyRollupEntry(entry);
    if (cls === "failure") return "failure";
    if (cls === "pending") pending = true;
    if (cls === "success") success = true;
  }
  if (pending) return "pending";
  if (success) return "success";
  return undefined;
}

/**
 * A single workflow run from `gh run list --json status,conclusion`, normalized
 * to lowercase. A finished run's `conclusion` wins; a run still in flight has
 * no conclusion yet and reports its `status` instead.
 */
export function normalizeRunStatus(
  runRecord: { status?: string; conclusion?: string | null } | undefined
): CiClass | undefined {
  if (!runRecord) return undefined;
  return classifyValue(runRecord.conclusion) ?? classifyValue(runRecord.status);
}

export interface BranchRun {
  workflowName?: string;
  status?: string;
  conclusion?: string | null;
}

/**
 * Branch verdict over `gh run list` output (newest first): the LATEST run of
 * EACH workflow counts, worst-first across workflows. Reading only the single
 * newest run — as this used to — let one workflow's fresh green hide another
 * workflow's standing red on the same branch.
 */
export function aggregateBranchRuns(runs: BranchRun[]): CiClass | undefined {
  if (!Array.isArray(runs) || runs.length === 0) return undefined;
  const latest = new Map<string, BranchRun>();
  for (const [i, r] of runs.entries()) {
    // A row with no workflow name can't be matched to older runs of "its"
    // workflow, so it counts individually rather than being dropped.
    const key = r.workflowName ?? `#${i}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  let pending = false;
  let success = false;
  for (const r of latest.values()) {
    const cls = normalizeRunStatus(r);
    if (cls === "failure") return "failure";
    if (cls === "pending") pending = true;
    if (cls === "success") success = true;
  }
  if (pending) return "pending";
  if (success) return "success";
  return undefined;
}

/**
 * Reuses the user's existing `gh` CLI auth (no new token needed). Degrades
 * silently when gh is missing, the remote isn't GitHub, or we're offline —
 * a project without any GitHub status just shows nothing in that panel.
 */
export async function fetchGithubStatus(projectPath: string): Promise<GithubStatus | undefined> {
  if (!fs.existsSync(path.join(projectPath, ".git"))) return undefined;

  const status: GithubStatus = { fetchedAt: new Date().toISOString() };

  try {
    const log = await run("git", ["log", "-1", "--format=%H%n%s%n%cI"], projectPath);
    const [sha, message, date] = log.split("\n");
    status.lastCommitSha = sha;
    status.lastCommitMessage = message;
    status.lastCommitDate = date;
  } catch {
    status.unavailableReason = "no commits yet";
    return status;
  }

  try {
    status.branch = await run("git", ["branch", "--show-current"], projectPath);
  } catch {
    // detached HEAD or similar
  }

  try {
    const porcelain = await run("git", ["status", "--porcelain"], projectPath);
    status.dirty = porcelain.length > 0;
  } catch {
    // ignore
  }

  try {
    const counts = await run("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], projectPath);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    status.ahead = ahead;
    status.behind = behind;
  } catch {
    // no upstream configured
  }

  try {
    const prJson = await run(
      "gh",
      ["pr", "list", "--json", "number,title,state,isDraft,statusCheckRollup", "--limit", "20"],
      projectPath
    );
    const prs: any[] = JSON.parse(prJson || "[]");
    status.openPrs = prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft,
      ciStatus: aggregateCheckRollup(pr.statusCheckRollup),
    }));
  } catch {
    // gh missing, not a GitHub remote, or offline
  }

  // Scoped to the branch you actually have checked out. Repo-wide (`gh run
  // list -L 1`) meant a Dependabot or someone else's feature-branch run could
  // report itself as this project's CI state. On a detached HEAD there is no
  // branch to ask about, so we'd rather say nothing than say something wrong.
  if (status.branch) {
    try {
      // 20 covers the branch's recent history across every workflow; the
      // aggregation keeps only the newest run per workflow anyway.
      const runJson = await run(
        "gh",
        [
          "run",
          "list",
          "-L",
          "20",
          "--branch",
          status.branch,
          "--json",
          "workflowName,status,conclusion",
        ],
        projectPath
      );
      const runs: BranchRun[] = JSON.parse(runJson || "[]");
      const ci = aggregateBranchRuns(runs);
      if (ci) status.ciStatus = ci;
    } catch {
      // no CI configured or gh unavailable
    }
  }

  return status;
}
