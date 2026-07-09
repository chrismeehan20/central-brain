import type { AttentionItem, AttentionPriority, AttentionType, HookEventPayload } from "@shared/types.js";
import { attentionDb } from "../store/db.js";
import { bus } from "../events/bus.js";
import { notify } from "./notifier.js";
import { canonicalize } from "../scan/paths.js";

const PRIORITY_BY_TYPE: Record<AttentionType, AttentionPriority> = {
  permission: "high",
  waiting: "medium",
  "codex-maybe-waiting": "low",
  done: "none",
};

// Fires ~every 60s while idle, plus on real permission/blocked states —
// clearing events mean "user is back", silent events mean "turn finished,
// nothing to review" (per the "only truly-blocked pings" rule from prior art).
const CLEARING_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "SessionEnd"]);
const SILENT_EVENTS = new Set(["Stop", "SubagentStop"]);

function clearSession(sessionId: string) {
  attentionDb.data.items = attentionDb.data.items.filter((i) => i.sessionId !== sessionId);
}

/** Returns true if this created a new item (vs. refreshing an existing one). */
function upsert(item: Omit<AttentionItem, "createdAt" | "updatedAt">): boolean {
  const now = new Date().toISOString();
  const items = attentionDb.data.items;
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...item, updatedAt: now };
    return false;
  }
  items.push({ ...item, createdAt: now, updatedAt: now });
  return true;
}

export async function handleClaudeHookEvent(payload: HookEventPayload): Promise<void> {
  const sessionId = payload.session_id;
  const projectPath = payload.cwd ? canonicalize(payload.cwd) : "unknown";
  const eventName = payload.hook_event_name;

  if (CLEARING_EVENTS.has(eventName)) {
    clearSession(sessionId);
  } else if (eventName === "PermissionRequest") {
    const isNew = upsert({
      id: `${sessionId}:permission`,
      sessionId,
      projectPath,
      tool: "claude",
      type: "permission",
      priority: PRIORITY_BY_TYPE.permission,
      message: typeof payload.tool_name === "string" ? `Wants to run: ${payload.tool_name}` : "Needs a permission decision",
    });
    if (isNew) {
      await notify({ title: "Needs your OK", body: projectPath, sound: true });
    }
  } else if (eventName === "Notification") {
    const isNew = upsert({
      id: `${sessionId}:waiting`,
      sessionId,
      projectPath,
      tool: "claude",
      type: "waiting",
      priority: PRIORITY_BY_TYPE.waiting,
      message: typeof payload.message === "string" ? payload.message : "Waiting for input (or just idle)",
    });
    if (isNew) {
      await notify({ title: "Waiting on you", body: projectPath, sound: false });
    }
  } else if (SILENT_EVENTS.has(eventName)) {
    clearSession(sessionId);
  } else {
    return; // uninteresting event, nothing to persist or broadcast
  }

  await attentionDb.write();
  bus.emit("attention:update", attentionDb.data.items);
}

export function getAttentionItems(): AttentionItem[] {
  return attentionDb.data.items;
}
