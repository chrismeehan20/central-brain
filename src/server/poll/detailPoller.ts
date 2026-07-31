import { getOrGenerateDetail } from "../ai/detail.js";
import { canSpend } from "../ai/budget.js";
import { getCachedProjects } from "../scan/index.js";
import { isAiEligible } from "./aiEligibility.js";

const POLL_MS = Number(process.env.DETAIL_POLL_MS ?? 60 * 60_000); // hourly by default

async function pollOnce(): Promise<void> {
  // Only recently-active visible projects, and only the ones whose evidence changed
  // (getOrGenerateDetail is hash-gated, so unchanged projects cost nothing).
  // Freshest first so they win budget if the cap hits.
  const projects = getCachedProjects()
    .filter((p) => isAiEligible(p))
    .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  for (const project of projects) {
    if (!canSpend()) break; // out of daily budget — stop until tomorrow
    await getOrGenerateDetail(project);
  }
}

export function startDetailPoller(): void {
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}
