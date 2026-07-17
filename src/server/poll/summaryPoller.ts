import { getOrGenerateSummary } from "../ai/summarize.js";
import { getOrGenerateDigest } from "../ai/digest.js";
import { canSpend } from "../ai/budget.js";
import { getCachedProjects } from "../scan/index.js";

const POLL_MS = Number(process.env.SUMMARY_POLL_MS ?? 30 * 60_000);
const DISCOVERED_WINDOW_MS = 30 * 86_400_000; // discovered projects only get AI if touched recently

async function pollOnce(): Promise<void> {
  // The daily digest piggybacks on this cadence (hash-gated, ~1-2 calls/day).
  await getOrGenerateDigest().catch((err) => console.error("digest poll failed:", err));

  // Triaged projects always qualify; discovered ones qualify while recently
  // active — they're exactly the cards being triaged, and a summary is most
  // useful at that moment. Freshest first so they win budget if the cap hits.
  const cutoff = new Date(Date.now() - DISCOVERED_WINDOW_MS).toISOString();
  const projects = getCachedProjects()
    .filter((p) => !p.hidden && !p.missing && (!p.discovered || (p.lastActivity ?? "") > cutoff))
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
