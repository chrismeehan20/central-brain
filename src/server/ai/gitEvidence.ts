import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Git as evidence of what a project has ALREADY built.
 *
 * Both AI paths need this and for the same reason: docs describe plans and
 * session summaries describe what a session was *about*, so neither can tell
 * "still to do" from "done last week". Commits can. Extracted here so the card
 * summary and the project detail share one implementation rather than drifting.
 */
const execFileAsync = promisify(execFile);

export async function git(projectPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      timeout: 3000,
    });
    return stdout.trim();
  } catch {
    return ""; // not a git repo, or git unavailable
  }
}

/** Recent commit messages (subject + body) — the strongest signal for what's
 *  ALREADY built. Body is included so completions described there (not just in
 *  the one-line subject) are detectable. */
export function readGitLog(projectPath: string): Promise<string> {
  return git(projectPath, ["log", "--pretty=format:%s%n%b%n-----", "-n", "15"]);
}

/**
 * Subjects only, for the one-line card summary.
 *
 * That summary is generated for every visible project on a background poll, so
 * its context has to stay small; commit subjects alone are enough to establish
 * that a feature landed, without paying for full bodies 30 times a cycle.
 */
export function readCommitSubjects(projectPath: string, count = 12): Promise<string> {
  return git(projectPath, ["log", `--pretty=format:- %s`, "-n", String(count)]);
}
