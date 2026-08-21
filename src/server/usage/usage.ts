import type { Project, UsageWindow } from "@shared/types.js";
import { usageDb } from "../store/db.js";

/**
 * Claude's subscription limit runs in five-hour windows: the first prompt
 * opens a window, and the next window opens with the first prompt after that
 * one expires. Anthropic exposes no API for any of this, so Central Brain
 * estimates it from the activity it can see — hook events as they arrive,
 * plus session lastActivity stamps folded in on every scan (which back-fills
 * the hours when hooks weren't installed, at much coarser resolution).
 *
 * The estimate is deliberately boundaries-only. Whether the current window's
 * budget is nearly spent is unknowable from here; when it resets — the fact
 * that decides whether overnight work can start now or must queue — is not.
 */
export const USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;

/** Instants are truncated to the minute: enough resolution for a 5h window, and it dedupes a chatty session for free. */
const MINUTE_MS = 60_000;

/** Keep a week of history; enough to show the rhythm, bounded rewrite cost. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** The slice of a lowdb `Low` this module needs — lets tests pass a throwaway store. */
export interface UsageStoreLike {
  data: { instants: string[] };
  write(): Promise<void>;
}

export interface UsageDeps {
  store?: UsageStoreLike;
  now?: number;
}

function truncateToMinute(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/**
 * Fold one or more observed-activity timestamps into the store. Idempotent
 * per minute; prunes beyond the retention horizon; writes only when
 * something actually changed, because this runs on every hook event and
 * every scan.
 */
export async function recordUsageInstants(timestamps: number[], deps: UsageDeps = {}): Promise<void> {
  const store = deps.store ?? usageDb;
  const now = deps.now ?? Date.now();

  const existing = new Set(store.data.instants);
  let changed = false;
  for (const ts of timestamps) {
    // The future is not activity: a skewed clock in a transcript must not
    // open a window that hasn't happened.
    if (ts > now + MINUTE_MS || ts < now - RETAIN_MS) continue;
    const minute = truncateToMinute(ts);
    if (!existing.has(minute)) {
      existing.add(minute);
      changed = true;
    }
  }

  const pruned = [...existing].filter((iso) => Date.parse(iso) >= now - RETAIN_MS).sort();
  if (pruned.length !== store.data.instants.length) changed = true;
  if (!changed) return;

  store.data.instants = pruned;
  await store.write();
}

/** Scan-time back-fill: every Claude session's lastActivity is an observed instant. */
export async function recordFromProjects(projects: Project[], deps: UsageDeps = {}): Promise<void> {
  const timestamps: number[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.tool !== "claude") continue;
      const ts = Date.parse(session.lastActivity);
      if (Number.isFinite(ts)) timestamps.push(ts);
    }
  }
  await recordUsageInstants(timestamps, deps);
}

/**
 * Replay the observed instants through the window rule: an instant either
 * falls inside the currently-open window or opens a new one. Pure so the
 * boundary cases (activity exactly at expiry, gaps, no data) are testable.
 */
export function estimateWindow(instants: string[], now: number): UsageWindow {
  let windowStart: number | undefined;
  for (const iso of instants) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t > now) continue;
    if (windowStart === undefined || t >= windowStart + USAGE_WINDOW_MS) windowStart = t;
  }

  if (windowStart === undefined) {
    return { active: false, observations: instants.length, estimate: true };
  }

  const windowEnd = windowStart + USAGE_WINDOW_MS;
  const active = now < windowEnd;
  return {
    active,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    ...(active ? { remainingMs: windowEnd - now } : {}),
    observations: instants.length,
    estimate: true,
  };
}

export function getUsageWindow(now = Date.now()): UsageWindow {
  return estimateWindow(usageDb.data.instants, now);
}
