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
    // `snoozedUntil` is deliberately dropped rather than merged: this path only
    // runs for a freshly-arrived hook event, and a new PermissionRequest /
    // Notification is new information that must un-hide a snoozed row. Spreading
    // the old item would silently carry the snooze over the new event.
    items[idx] = { ...items[idx], ...item, snoozedUntil: undefined, updatedAt: nowIso };
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

/**
 * The user-driven half of the seam. Snooze and dismiss are the same shape as
 * `handleHookEvent` minus the notifier and liveness tracking: production passes
 * nothing, tests pass in-memory stubs.
 */
export type AttentionMutationDeps = Pick<HookHandlerDeps, "store" | "emit" | "now">;

function resolveMutationDeps(deps: AttentionMutationDeps) {
  return {
    store: deps.store ?? attentionDb,
    emit: deps.emit ?? ((items: AttentionItem[]) => void bus.emit("attention:update", items)),
    now: deps.now ?? Date.now(),
  };
}

/** A dismissed heuristic flag hides for this long — see `dismissAttentionItem`. */
const DISMISS_SNOOZE_MINUTES = 24 * 60;

/**
 * Hide one item for `minutes`. Returns false (writing and emitting nothing) when
 * the id is gone — by the time a click lands, a hook event may already have
 * cleared the row.
 */
export async function snoozeAttentionItem(
  id: string,
  minutes: number,
  deps: AttentionMutationDeps = {},
): Promise<boolean> {
  const { store, emit, now } = resolveMutationDeps(deps);
  const item = store.data.items.find((i) => i.id === id);
  if (!item) return false;

  const nowIso = new Date(now).toISOString();
  item.snoozedUntil = new Date(now + minutes * 60_000).toISOString();
  item.updatedAt = nowIso;

  await store.write();
  emit(store.data.items);
  return true;
}

/**
 * Get rid of one item for good — as far as the user is concerned.
 *
 * Two mechanics behind one verb, because the two kinds of row are created
 * differently:
 *
 * - `codex-maybe-waiting` is *polled*, not pushed. The staleness pass re-creates
 *   any missing id for as long as the rollout file stays quiet inside its
 *   5min–1h window, so deleting the row would just resurrect it a minute later.
 *   A 24h snooze is the honest implementation, and 24h is not arbitrary: it
 *   matches the heuristic's own ABANDONED window, past which the poller clears
 *   the item itself — so on default settings the snooze expires into a list the
 *   item has already left.
 * - every other type is *edge-triggered* by a hook event, so removal sticks.
 *   If a genuinely new event fires, the row comes back — which is correct.
 */
export async function dismissAttentionItem(
  id: string,
  deps: AttentionMutationDeps = {},
): Promise<boolean> {
  const { store, emit } = resolveMutationDeps(deps);
  const item = store.data.items.find((i) => i.id === id);
  if (!item) return false;

  if (item.type === "codex-maybe-waiting") {
    return snoozeAttentionItem(id, DISMISS_SNOOZE_MINUTES, deps);
  }

  store.data.items = store.data.items.filter((i) => i.id !== id);
  await store.write();
  emit(store.data.items);
  return true;
}
