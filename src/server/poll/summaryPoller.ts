import { getOrGenerateSummary } from "../ai/summarize.js";
import { getCachedProjects } from "../scan/index.js";

const POLL_MS = 30 * 60_000;

async function pollOnce(): Promise<void> {
  // Only projects the user has already triaged (kept/renamed/pinned) — the
  // 40-odd freshly-discovered folders don't need an API call until reviewed.
  const projects = getCachedProjects().filter((p) => !p.hidden && !p.discovered);
  for (const project of projects) {
    await getOrGenerateSummary(project);
  }
}

export function startSummaryPoller(): void {
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}
