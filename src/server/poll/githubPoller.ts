import { fetchGithubStatus } from "../github/ghClient.js";
import { getCachedProjects } from "../scan/index.js";
import { githubDb } from "../store/db.js";
import type { GithubStatus } from "@shared/types.js";

const POLL_MS = 8 * 60_000; // slow cadence to respect gh/GitHub rate limits

async function pollOnce(): Promise<void> {
  const projects = getCachedProjects();
  for (const project of projects) {
    if (project.hidden || project.missing) continue; // git/gh on a dead path is pure waste
    try {
      const status = await fetchGithubStatus(project.path);
      if (status) {
        githubDb.data[project.path] = status;
      }
    } catch {
      // leave previously cached status in place on a transient failure
    }
  }
  await githubDb.write();
}

export function startGithubPoller(): void {
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

export function getGithubStatus(projectPath: string): GithubStatus | undefined {
  return githubDb.data[projectPath];
}
