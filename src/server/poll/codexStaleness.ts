import fs from "node:fs";
import type { AttentionItem } from "@shared/types.js";
import { scanCodexProjects, type ScannedSessions } from "../scan/codex.js";
import { attentionDb } from "../store/db.js";
import { bus } from "../events/bus.js";
import { notify, type NotifyOptions } from "../alert/notifier.js";
import { isHookLive } from "../alert/hookLiveness.js";
import type { AttentionStoreLike } from "../alert/attention.js";

const POLL_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000; // quiet mid-session longer than this looks stuck
const DECAY_AFTER_MS = 60 * 60_000; // beyond this, demote to a low-signal leftover instead of vanishing
// A flag only fully clears after this long — a blocked session you don't
// notice within the hour used to silently disappear, which dropped exactly
// the case worth catching. Env-overridable (ms).
const ABANDONED_AFTER_MS = Number(process.env.CODEX_ABANDONED_MS ?? 24 * 60 * 60_000);

interface Tracked {
  size: number;
  lastGrowthAt: number;
}

/**
 * Fallback for when Codex hooks are not delivering. This is a heuristic
 * staleness check, not a true push signal — a rollout file that stops growing
 * might mean Codex is waiting on the user, or might just mean the session
 * ended normally.
 *
 * Codex *does* have a hook system, but its hooks only fire after a one-off
 * interactive trust approval, keyed to each exact hook definition, so on a
 * machine where that has never been granted no Codex hook ever fires. Hence:
 * keep the heuristic, but stand down the moment real hook events start
 * arriving (see the hooks-live gate in `runStalenessPass`), because hooks are
 * authoritative and running both would only add false positives on top of the
 * truth.
 *
 * "Arriving" is doing real work in that sentence: the gate asks
 * `isHookLive("codex")`, which requires a recent event carrying the current
 * install id and a supported forwarder revision. A single old event, or one
 * from an install that has since been repaired, no longer stands the heuristic
 * down — which is the failure mode that made this fallback look broken.
 */
export interface StalenessContext {
  /**
   * Growth tracking, keyed by transcript path rather than session id: a resumed
   * session can produce several rollout files that share one id, and tracking
   * growth per file keeps them from clobbering each other's size baseline.
   * Lives on the context so each caller (and each test) gets its own.
   */
  tracked: Map<string, Tracked>;
  scan: () => ScannedSessions;
  store: AttentionStoreLike;
  hooksLive: () => boolean;
  notify: (opts: NotifyOptions) => Promise<void>;
  emit: (items: AttentionItem[]) => void;
  now: () => number;
}

export function createStalenessContext(overrides: Partial<StalenessContext> = {}): StalenessContext {
  return {
    tracked: new Map(),
    scan: () => scanCodexProjects(),
    store: attentionDb,
    hooksLive: () => isHookLive("codex"),
    notify,
    emit: (items) => void bus.emit("attention:update", items),
    now: () => Date.now(),
    ...overrides,
  };
}

/** Returns true if a new item was created. */
function upsertAttention(ctx: StalenessContext, sessionId: string, projectPath: string): boolean {
  const id = `${sessionId}:codex-maybe`;
  const items = ctx.store.data.items;
  if (items.some((i) => i.id === id)) return false;
  const now = new Date(ctx.now()).toISOString();
  items.push({
    id,
    sessionId,
    projectPath,
    tool: "codex",
    type: "codex-maybe-waiting",
    priority: "low",
    message: "No hook signal for Codex — flagged by staleness heuristic only, may be a false positive.",
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

/** Demote a long-quiet flag instead of deleting it. Returns true if anything changed. */
function decayAttention(ctx: StalenessContext, sessionId: string): boolean {
  const item = ctx.store.data.items.find(
    (i) => i.sessionId === sessionId && i.type === "codex-maybe-waiting"
  );
  if (!item || item.priority === "none") return false;
  item.priority = "none";
  item.message = "Quiet for over an hour — the session probably ended, but check if you were expecting output.";
  item.updatedAt = new Date(ctx.now()).toISOString();
  return true;
}

/** Returns true if any item was removed. */
function clearAttention(ctx: StalenessContext, sessionId: string): boolean {
  const before = ctx.store.data.items.length;
  ctx.store.data.items = ctx.store.data.items.filter(
    (i) => !(i.sessionId === sessionId && i.type === "codex-maybe-waiting")
  );
  return ctx.store.data.items.length !== before;
}

/** Drop every heuristic flag, whatever session it belongs to. */
function clearAllHeuristicFlags(ctx: StalenessContext): boolean {
  const before = ctx.store.data.items.length;
  ctx.store.data.items = ctx.store.data.items.filter((i) => i.type !== "codex-maybe-waiting");
  return ctx.store.data.items.length !== before;
}

/** Returns true if the attention list changed. Exported for tests. */
export async function runStalenessPass(ctx: StalenessContext): Promise<boolean> {
  // Hooks are authoritative: a real PermissionRequest/Stop stream tells us
  // exactly what the heuristic is guessing at, so guessing alongside it would
  // only manufacture false positives. Retire any flag the heuristic left
  // behind before hooks came online.
  if (ctx.hooksLive()) {
    const changed = clearAllHeuristicFlags(ctx);
    // Forget the growth baselines too, so if hooks later go silent past the
    // liveness window the heuristic restarts from each file's real mtime
    // instead of reading the whole quiet period as "grew since last poll".
    ctx.tracked.clear();
    if (changed) {
      await ctx.store.write();
      ctx.emit(ctx.store.data.items);
    }
    return changed;
  }

  const sessions = ctx.scan();
  const now = ctx.now();
  let changed = false;
  const seen = new Set<string>();

  for (const [projectPath, refs] of Object.entries(sessions)) {
    for (const ref of refs) {
      if (!ref.transcriptPath) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(ref.transcriptPath);
      } catch {
        // Rollout file vanished — stop tracking it and drop any stale flag.
        ctx.tracked.delete(ref.transcriptPath);
        if (clearAttention(ctx, ref.sessionId)) changed = true;
        continue;
      }

      const key = ref.transcriptPath;
      seen.add(key);
      const prev = ctx.tracked.get(key);

      if (!prev || prev.size !== stat.size) {
        // On first sight, anchor to the file's real mtime — not `now` — so a
        // session that finished hours or days ago isn't mistaken for one that
        // just went quiet at server start. Genuine growth since the last poll
        // means the session is active, so refresh to now and clear any flag.
        const lastGrowthAt = prev ? now : stat.mtimeMs;
        ctx.tracked.set(key, { size: stat.size, lastGrowthAt });
        if (prev) {
          if (clearAttention(ctx, ref.sessionId)) changed = true;
          continue;
        }
        // fall through: evaluate staleness against the real mtime baseline
      }

      const quietFor = now - ctx.tracked.get(key)!.lastGrowthAt;
      if (quietFor > STALE_AFTER_MS && quietFor < DECAY_AFTER_MS) {
        if (upsertAttention(ctx, ref.sessionId, projectPath)) {
          changed = true;
          // Panel-only flags were easy to miss — surface stuck Codex sessions
          // the same way Claude waiting events are surfaced.
          ctx.notify({
            title: "Codex may be stuck",
            body: projectPath,
            sound: false,
          }).catch(() => {});
        }
      } else if (quietFor >= DECAY_AFTER_MS && quietFor < ABANDONED_AFTER_MS) {
        if (decayAttention(ctx, ref.sessionId)) changed = true;
      } else if (quietFor >= ABANDONED_AFTER_MS) {
        if (clearAttention(ctx, ref.sessionId)) changed = true;
      }
    }
  }

  // Evict tracker entries whose files no longer appear in the scan, so an
  // always-on service doesn't slowly accumulate dead paths.
  for (const key of ctx.tracked.keys()) {
    if (!seen.has(key)) ctx.tracked.delete(key);
  }

  // Drop flags whose session vanished from the scan entirely (rollout file
  // deleted) — otherwise they'd linger with nothing left to clear them.
  const liveSessionIds = new Set(
    Object.values(sessions).flatMap((refs) => refs.map((r) => r.sessionId))
  );
  const beforeOrphans = ctx.store.data.items.length;
  ctx.store.data.items = ctx.store.data.items.filter(
    (i) => i.type !== "codex-maybe-waiting" || liveSessionIds.has(i.sessionId)
  );
  if (ctx.store.data.items.length !== beforeOrphans) changed = true;

  if (changed) {
    await ctx.store.write();
    ctx.emit(ctx.store.data.items);
  }
  return changed;
}

export function startCodexStalenessPoll(): void {
  const ctx = createStalenessContext();
  runStalenessPass(ctx);
  setInterval(() => runStalenessPass(ctx), POLL_MS);
}
