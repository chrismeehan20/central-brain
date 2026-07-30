import type {
  AttentionItem,
  AttentionPriority,
  AttentionType,
  HookEventPayload,
  SourceTool,
} from "@shared/types.js";
import { attentionDb } from "../store/db.js";
import { bus } from "../events/bus.js";
import { notify, type NotifyOptions } from "./notifier.js";
import { canonicalize } from "../scan/paths.js";
import { recordHookEvent, type LivenessStoreLike } from "./hookLiveness.js";

const PRIORITY_BY_TYPE: Record<AttentionType, AttentionPriority> = {
  permission: "high",
  waiting: "medium",
  "codex-maybe-waiting": "low",
  done: "none",
};

// Fires ~every 60s while idle, plus on real permission/blocked states —
// clearing events mean "user is back", silent events mean "turn finished,
// nothing to review" (per the "only truly-blocked pings" rule from prior art).
//
// Codex uses the same event names as Claude (hook_event_name, session_id, cwd,
// message), so both tools share these sets: Codex's SessionStart /
// UserPromptSubmit / SessionEnd clear, its Stop / SubagentStop clear silently,
// and its PermissionRequest is a real block. Codex has no `Notification`
// event; the branch below simply never fires for it.
const CLEARING_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "SessionEnd"]);
const SILENT_EVENTS = new Set(["Stop", "SubagentStop"]);

/** The slice of a lowdb `Low` this module needs — lets tests pass a throwaway store. */
export interface AttentionStoreLike {
  data: { items: AttentionItem[] };
  write(): Promise<void>;
}

/**
 * Injection seam. Production passes nothing and gets the module-level lowdb
 * store, the real notifier, and the real event bus; tests pass in-memory
 * stubs so they never touch data/*.json or fire a desktop notification.
 */
export interface HookHandlerDeps {
  store?: AttentionStoreLike;
  livenessStore?: LivenessStoreLike;
  notify?: (opts: NotifyOptions) => Promise<void>;
  emit?: (items: AttentionItem[]) => void;
  now?: number;
}

function clearSession(store: AttentionStoreLike, sessionId: string) {
  store.data.items = store.data.items.filter((i) => i.sessionId !== sessionId);
}

/** Returns true if this created a new item (vs. refreshing an existing one). */
function upsert(
  store: AttentionStoreLike,
  nowIso: string,
  item: Omit<AttentionItem, "createdAt" | "updatedAt">,
): boolean {
  const items = store.data.items;
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...item, updatedAt: nowIso };
    return false;
  }
  items.push({ ...item, createdAt: nowIso, updatedAt: nowIso });
  return true;
}

/**
 * Handle one hook event from `tool`. The tool comes from the route the event
 * arrived on, not from sniffing the payload — Claude and Codex send the same
 * field names, so the payload cannot tell them apart.
 */
export async function handleHookEvent(
  payload: HookEventPayload,
  tool: SourceTool,
  deps: HookHandlerDeps = {},
): Promise<void> {
  const store = deps.store ?? attentionDb;
  const notifyFn = deps.notify ?? notify;
  const emit = deps.emit ?? ((items: AttentionItem[]) => void bus.emit("attention:update", items));
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();

  const sessionId = payload.session_id;
  const projectPath = payload.cwd ? canonicalize(payload.cwd) : "unknown";
  const eventName = payload.hook_event_name;

  // Recorded before any early return: an event we don't act on (PreToolUse,
  // SubagentStart, …) still proves this tool's hooks are firing, which is what
  // gates the Codex staleness heuristic.
  await recordHookEvent(tool, { store: deps.livenessStore, now });

  if (CLEARING_EVENTS.has(eventName)) {
    clearSession(store, sessionId);
  } else if (eventName === "PermissionRequest") {
    const isNew = upsert(store, nowIso, {
      id: `${sessionId}:permission`,
      sessionId,
      projectPath,
      tool,
      type: "permission",
      priority: PRIORITY_BY_TYPE.permission,
      message: typeof payload.tool_name === "string" ? `Wants to run: ${payload.tool_name}` : "Needs a permission decision",
    });
    if (isNew) {
      await notifyFn({
        title: tool === "codex" ? "Codex needs your OK" : "Needs your OK",
        body: projectPath,
        sound: true,
      });
    }
  } else if (eventName === "Notification") {
    const isNew = upsert(store, nowIso, {
      id: `${sessionId}:waiting`,
      sessionId,
      projectPath,
      tool,
      type: "waiting",
      priority: PRIORITY_BY_TYPE.waiting,
      message: typeof payload.message === "string" ? payload.message : "Waiting for input (or just idle)",
    });
    if (isNew) {
      await notifyFn({
        title: tool === "codex" ? "Codex is waiting on you" : "Waiting on you",
        body: projectPath,
        sound: false,
      });
    }
  } else if (SILENT_EVENTS.has(eventName)) {
    clearSession(store, sessionId);
  } else {
    return; // uninteresting event, nothing to persist or broadcast
  }

  await store.write();
  emit(store.data.items);
}

export function getAttentionItems(): AttentionItem[] {
  return attentionDb.data.items;
}
