import { aiUsageDb } from "../store/db.js";

// Cost guardrails shared by every path that spends Anthropic tokens
// (project summaries + project detail). All env-overridable.
const DAILY_CAP = Number(process.env.AI_DAILY_CALL_CAP ?? 200);
export const DEBOUNCE_MS = Number(process.env.AI_REFRESH_DEBOUNCE_MS ?? 60_000);
export const AI_MODEL = process.env.AI_MODEL ?? "claude-haiku-4-5-20251001";

export function today(): string {
  // Local calendar date (YYYY-MM-DD) so the daily cap resets at the user's
  // midnight, not UTC's.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function callsToday(): number {
  return aiUsageDb.data.date === today() ? aiUsageDb.data.calls : 0;
}

export function dailyCap(): number {
  return DAILY_CAP;
}

export function callsRemaining(): number {
  return Math.max(0, DAILY_CAP - callsToday());
}

/** True while there's daily budget left to make a real API call. */
export function canSpend(): boolean {
  return callsRemaining() > 0;
}

/** Record one real API call against today's budget (persisted, survives restarts). */
export async function recordCall(): Promise<void> {
  const t = today();
  if (aiUsageDb.data.date !== t) {
    aiUsageDb.data.date = t;
    aiUsageDb.data.calls = 0;
  }
  aiUsageDb.data.calls += 1;
  await aiUsageDb.write();
}

/**
 * Debounce guard for forced/manual refreshes: if a project was successfully
 * generated within DEBOUNCE_MS, a repeat click is a no-op (returns cached)
 * instead of a fresh paid call. Stops rapid clicks / scripted spam.
 */
export function isDebounced(generatedAtIso?: string): boolean {
  if (!generatedAtIso) return false;
  return Date.now() - new Date(generatedAtIso).getTime() < DEBOUNCE_MS;
}

export const capMessage = () =>
  `Daily AI limit reached (${DAILY_CAP} calls). Resets tomorrow, or raise AI_DAILY_CALL_CAP.`;
