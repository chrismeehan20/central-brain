import fs from "node:fs";
import { scanCodexProjects } from "../scan/codex.js";
import { attentionDb } from "../store/db.js";
import { bus } from "../events/bus.js";
import { notify } from "../alert/notifier.js";

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

// Codex has no hook system, so this is a heuristic staleness check, not a
// true push signal — a rollout file that stops growing might mean Codex is
// waiting on the user, or might just mean the session ended normally.
//
// Keyed by transcript path, not session id: a resumed session can produce
// several rollout files that share one id, and tracking growth per file
// keeps them from clobbering each other's size baseline.
const tracked = new Map<string, Tracked>();

/** Returns true if a new item was created. */
function upsertAttention(sessionId: string, projectPath: string): boolean {
  const id = `${sessionId}:codex-maybe`;
  const items = attentionDb.data.items;
  if (items.some((i) => i.id === id)) return false;
  const now = new Date().toISOString();
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
function decayAttention(sessionId: string): boolean {
  const item = attentionDb.data.items.find(
    (i) => i.sessionId === sessionId && i.type === "codex-maybe-waiting"
  );
  if (!item || item.priority === "none") return false;
  item.priority = "none";
  item.message = "Quiet for over an hour — the session probably ended, but check if you were expecting output.";
  item.updatedAt = new Date().toISOString();
  return true;
}

/** Returns true if any item was removed. */
function clearAttention(sessionId: string): boolean {
  const before = attentionDb.data.items.length;
  attentionDb.data.items = attentionDb.data.items.filter(
    (i) => !(i.sessionId === sessionId && i.type === "codex-maybe-waiting")
  );
  return attentionDb.data.items.length !== before;
}

async function pollOnce(): Promise<void> {
  const sessions = scanCodexProjects();
  const now = Date.now();
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
        tracked.delete(ref.transcriptPath);
        if (clearAttention(ref.sessionId)) changed = true;
        continue;
      }

      const key = ref.transcriptPath;
      seen.add(key);
      const prev = tracked.get(key);

      if (!prev || prev.size !== stat.size) {
        // On first sight, anchor to the file's real mtime — not `now` — so a
        // session that finished hours or days ago isn't mistaken for one that
        // just went quiet at server start. Genuine growth since the last poll
        // means the session is active, so refresh to now and clear any flag.
        const lastGrowthAt = prev ? now : stat.mtimeMs;
        tracked.set(key, { size: stat.size, lastGrowthAt });
        if (prev) {
          if (clearAttention(ref.sessionId)) changed = true;
          continue;
        }
        // fall through: evaluate staleness against the real mtime baseline
      }

      const quietFor = now - tracked.get(key)!.lastGrowthAt;
      if (quietFor > STALE_AFTER_MS && quietFor < DECAY_AFTER_MS) {
        if (upsertAttention(ref.sessionId, projectPath)) {
          changed = true;
          // Panel-only flags were easy to miss — surface stuck Codex sessions
          // the same way Claude waiting events are surfaced.
          notify({
            title: "Codex may be stuck",
            body: projectPath,
            sound: false,
          }).catch(() => {});
        }
      } else if (quietFor >= DECAY_AFTER_MS && quietFor < ABANDONED_AFTER_MS) {
        if (decayAttention(ref.sessionId)) changed = true;
      } else if (quietFor >= ABANDONED_AFTER_MS) {
        if (clearAttention(ref.sessionId)) changed = true;
      }
    }
  }

  // Evict tracker entries whose files no longer appear in the scan, so an
  // always-on service doesn't slowly accumulate dead paths.
  for (const key of tracked.keys()) {
    if (!seen.has(key)) tracked.delete(key);
  }

  // Drop flags whose session vanished from the scan entirely (rollout file
  // deleted) — otherwise they'd linger with nothing left to clear them.
  const liveSessionIds = new Set(
    Object.values(sessions).flatMap((refs) => refs.map((r) => r.sessionId))
  );
  const beforeOrphans = attentionDb.data.items.length;
  attentionDb.data.items = attentionDb.data.items.filter(
    (i) => i.type !== "codex-maybe-waiting" || liveSessionIds.has(i.sessionId)
  );
  if (attentionDb.data.items.length !== beforeOrphans) changed = true;

  if (changed) {
    await attentionDb.write();
    bus.emit("attention:update", attentionDb.data.items);
  }
}

export function startCodexStalenessPoll(): void {
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}
