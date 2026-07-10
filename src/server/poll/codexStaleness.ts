import fs from "node:fs";
import { scanCodexProjects } from "../scan/codex.js";
import { attentionDb } from "../store/db.js";
import { bus } from "../events/bus.js";

const POLL_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000; // quiet mid-session longer than this looks stuck
const ABANDONED_AFTER_MS = 60 * 60_000; // beyond this, assume they just walked away

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

  for (const [projectPath, refs] of Object.entries(sessions)) {
    for (const ref of refs) {
      if (!ref.transcriptPath) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(ref.transcriptPath);
      } catch {
        continue;
      }

      const key = ref.transcriptPath;
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
      if (quietFor > STALE_AFTER_MS && quietFor < ABANDONED_AFTER_MS) {
        if (upsertAttention(ref.sessionId, projectPath)) changed = true;
      } else if (quietFor >= ABANDONED_AFTER_MS) {
        if (clearAttention(ref.sessionId)) changed = true;
      }
    }
  }

  if (changed) {
    await attentionDb.write();
    bus.emit("attention:update", attentionDb.data.items);
  }
}

export function startCodexStalenessPoll(): void {
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}
