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
const tracked = new Map<string, Tracked>();

function upsertAttention(sessionId: string, projectPath: string) {
  const id = `${sessionId}:codex-maybe`;
  const items = attentionDb.data.items;
  if (items.some((i) => i.id === id)) return;
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
}

function clearAttention(sessionId: string) {
  attentionDb.data.items = attentionDb.data.items.filter(
    (i) => !(i.sessionId === sessionId && i.type === "codex-maybe-waiting")
  );
}

async function pollOnce(): Promise<void> {
  const sessions = scanCodexProjects();
  const now = Date.now();
  let changed = false;

  for (const [projectPath, refs] of Object.entries(sessions)) {
    for (const ref of refs) {
      if (!ref.transcriptPath) continue;

      let size: number;
      try {
        size = fs.statSync(ref.transcriptPath).size;
      } catch {
        continue;
      }

      const prev = tracked.get(ref.sessionId);
      if (!prev || prev.size !== size) {
        tracked.set(ref.sessionId, { size, lastGrowthAt: now });
        if (prev) {
          clearAttention(ref.sessionId);
          changed = true;
        }
        continue;
      }

      const quietFor = now - prev.lastGrowthAt;
      if (quietFor > STALE_AFTER_MS && quietFor < ABANDONED_AFTER_MS) {
        upsertAttention(ref.sessionId, projectPath);
        changed = true;
      } else if (quietFor >= ABANDONED_AFTER_MS) {
        clearAttention(ref.sessionId);
        changed = true;
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
