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
      ciStatus:
        Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length > 0
          ? pr.statusCheckRollup[0].conclusion ?? pr.statusCheckRollup[0].state
          : undefined,
    }));
  } catch {
    // gh missing, not a GitHub remote, or offline
  }

  try {
    const runJson = await run("gh", ["run", "list", "-L", "1", "--json", "status,conclusion"], projectPath);
    const runs: any[] = JSON.parse(runJson || "[]");
    if (runs[0]) {
      status.ciStatus = runs[0].conclusion ?? runs[0].status;
    }
  } catch {
    // no CI configured or gh unavailable
  }

  return status;
}
