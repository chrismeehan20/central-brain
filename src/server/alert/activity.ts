import { randomUUID } from "node:crypto";
import type { ActivityEvent, HookEventPayload, SourceTool } from "@shared/types.js";
import { activityDb } from "../store/db.js";
import { bus } from "../events/bus.js";
import { canonicalize } from "../scan/paths.js";

/**
 * The stream keeps this many events. Big enough to cover a full overnight run
 * of several agents (7 event kinds × a handful of sessions × many turns),
 * small enough that the JSON file stays trivially cheap to rewrite on every
 * append — lowdb rewrites the whole file, so this cap is also a write-cost cap.
 */
const MAX_EVENTS = 500;

/**
 * One line per hook event for the feed. Metadata only, same rule as the
 * attention pipeline: the event's *name* plus already-safe scalars (a tool
 * name, a notification message) — never prompts, never tool_input.
 *
 * Returns null for event names this version doesn't know: recording
 * "something happened" with no words for it would just be noise, and new
 * event kinds should be added here deliberately, with copy.
 */
export function describeHookEvent(payload: HookEventPayload): string | null {
  switch (payload.hook_event_name) {
    case "SessionStart":
      return "Session started";
    case "UserPromptSubmit":
      return "You sent a prompt";
    case "PermissionRequest":
      return typeof payload.tool_name === "string"
        ? `Asked permission to run ${payload.tool_name}`
        : "Asked for a permission decision";
    case "Notification":
      return typeof payload.message === "string" && payload.message
        ? payload.message
        : "Waiting for input (or idle)";
    case "Stop":
      return "Finished its turn";
    case "SubagentStop":
      return "A subagent finished";
    case "SessionEnd":
      return "Session ended";
    default:
      return null;
  }
}

/** The slice of a lowdb `Low` this module needs — lets tests pass a throwaway store. */
export interface ActivityStoreLike {
  data: { events: ActivityEvent[] };
  write(): Promise<void>;
}

/** Injection seam, same shape as the attention module's. */
export interface ActivityDeps {
  store?: ActivityStoreLike;
  emit?: (event: ActivityEvent) => void;
  now?: number;
  id?: () => string;
}

/**
 * Append one hook event to the rolling stream and broadcast it. Quietly does
 * nothing for unknown event names — the caller (the hook route) fires this for
 * every arrival and must not care which ones the feed renders.
 */
export async function recordActivity(
  payload: HookEventPayload,
  tool: SourceTool,
  deps: ActivityDeps = {},
): Promise<void> {
  const message = describeHookEvent(payload);
  if (message === null) return;

  const store = deps.store ?? activityDb;
  const emit = deps.emit ?? ((event: ActivityEvent) => void bus.emit("activity:append", event));
  const now = deps.now ?? Date.now();

  const event: ActivityEvent = {
    id: deps.id?.() ?? randomUUID(),
    at: new Date(now).toISOString(),
    tool,
    sessionId: payload.session_id,
    ...(payload.cwd ? { projectPath: canonicalize(payload.cwd) } : {}),
    event: payload.hook_event_name,
    message,
  };

  store.data.events.push(event);
  if (store.data.events.length > MAX_EVENTS) {
    store.data.events = store.data.events.slice(-MAX_EVENTS);
  }
  await store.write();
  emit(event);
}

/** Oldest first, as stored; the client renders newest-first. */
export function getActivityEvents(): ActivityEvent[] {
  return activityDb.data.events;
}
