import { getOrGenerateSummary } from "../ai/summarize.js";
import { getOrGenerateDigest } from "../ai/digest.js";
import { canSpend } from "../ai/budget.js";
import { getCachedProjects } from "../scan/index.js";
import { isAiEligible } from "./aiEligibility.js";

const POLL_MS = Number(process.env.SUMMARY_POLL_MS ?? 30 * 60_000);

async function pollOnce(): Promise<void> {
  // The daily digest piggybacks on this cadence (hash-gated, ~1-2 calls/day).
  await getOrGenerateDigest().catch((err) => console.error("digest poll failed:", err));

  // Recently-active visible projects only — dormant folders cost nothing.
  // Freshest first so they win budget if the cap hits.
  const projects = getCachedProjects()
    .filter((p) => isAiEligible(p))
    .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  for (const project of projects) {
    if (!canSpend()) break; // out of daily budget — stop until tomorrow
    await getOrGenerateSummary(project);
  }
}

export function startSummaryPoller(): void {
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}
