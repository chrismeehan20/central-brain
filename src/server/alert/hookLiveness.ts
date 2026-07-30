import type { HookLiveness, SourceTool } from "@shared/types.js";
import { hookLivenessDb, type HookLivenessData } from "../store/db.js";

/**
 * How recent a hook event has to be for us to treat that tool's hooks as a
 * live push signal.
 *
 * Seven days, deliberately generous. Codex fires a hook on `SessionStart` and
 * `UserPromptSubmit`, so *any* real use of Codex — a single prompt — refreshes
 * this. The window therefore only has to span stretches of using Codex not at
 * all: overnight, a weekend, a week of teaching with no coding. A 24h window
 * (the shape of CODEX_ABANDONED_MS) would flip back to "not live" every Monday
 * morning, and the heuristic fallback would switch itself on and off weekly —
 * exactly the flapping we don't want, since the fallback's whole cost is false
 * positives.
 *
 * It is not infinite on purpose: hook trust is keyed to a hash of the hook
 * config (~/.codex/hooks.state), so a Codex upgrade or a config edit can
 * silently revoke it. After a fortnight of silence we genuinely don't know
 * whether hooks still work, and falling back to the heuristic is the safe
 * answer — a spurious low-priority flag beats a missed blocked session.
 *
 * Env-overridable as CODEX_HOOK_LIVE_MS (ms), in the style of
 * CODEX_ABANDONED_MS. A non-numeric or non-positive value falls back to the
 * default rather than producing a NaN window.
 */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const configuredWindowMs = Number(process.env.CODEX_HOOK_LIVE_MS);
export const HOOK_LIVE_WINDOW_MS =
  Number.isFinite(configuredWindowMs) && configuredWindowMs > 0 ? configuredWindowMs : DEFAULT_WINDOW_MS;

/**
 * A hook event every ~60s per idle Claude session would mean a JSON write
 * every ~60s for a value only ever compared against a multi-day window, so
 * coalesce writes. Worst-case staleness is one minute against seven days.
 */
const MIN_WRITE_INTERVAL_MS = 60_000;

/** The slice of a lowdb `Low` we need — lets tests pass a throwaway store. */
export interface LivenessStoreLike {
  data: HookLivenessData;
  write(): Promise<void>;
}

export interface LivenessOptions {
  store?: LivenessStoreLike;
  now?: number;
  windowMs?: number;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Record that a hook event arrived from `tool`. Called for every hook event,
 * including ones we otherwise ignore — the point is proving the pipeline
 * works, not what the event said.
 */
export async function recordHookEvent(
  tool: SourceTool,
  opts: { store?: LivenessStoreLike; now?: number } = {},
): Promise<void> {
  const store = opts.store ?? hookLivenessDb;
  const now = opts.now ?? Date.now();
  const previous = parseTimestamp(store.data.lastEventAt[tool]);
  // Also re-write if the stored stamp is in the future (clock moved back),
  // otherwise a bad timestamp could stick around for the whole window.
  if (previous !== null && now - previous >= 0 && now - previous < MIN_WRITE_INTERVAL_MS) return;
  store.data.lastEventAt[tool] = new Date(now).toISOString();
  await store.write();
}

export function getHookLiveness(tool: SourceTool, opts: LivenessOptions = {}): HookLiveness {
  const store = opts.store ?? hookLivenessDb;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? HOOK_LIVE_WINDOW_MS;
  const lastEventAt = store.data.lastEventAt[tool];
  const last = parseTimestamp(lastEventAt);
  return {
    tool,
    live: last !== null && now - last < windowMs,
    ...(lastEventAt ? { lastEventAt } : {}),
    windowMs,
  };
}

/** True when this tool's hooks are an authoritative push signal right now. */
export function isHookLive(tool: SourceTool, opts: LivenessOptions = {}): boolean {
  return getHookLiveness(tool, opts).live;
}
