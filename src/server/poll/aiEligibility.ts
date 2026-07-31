import type { Project } from "@shared/types.js";

/** AI generation goes only to projects touched within this window. */
export const AI_ACTIVITY_WINDOW_MS = 30 * 86_400_000;

/**
 * Worth spending AI on: visible on the dashboard and active in the last 30
 * days. Gates generation only — summaries and details already stored for
 * dormant projects stay cached and keep being served.
 */
export function isAiEligible(p: Project, now: number = Date.now()): boolean {
  const cutoff = new Date(now - AI_ACTIVITY_WINDOW_MS).toISOString();
  return !p.hidden && !p.missing && (p.lastActivity ?? "") > cutoff;
}
