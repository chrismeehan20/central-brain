import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HookEventPayload, SourceTool } from "@shared/types.js";
import {
  dismissAttentionItem,
  getAttentionItems,
  handleHookEvent,
  snoozeAttentionItem,
} from "../alert/attention.js";
import { getHookLiveness } from "../alert/hookLiveness.js";

const DEFAULT_SNOOZE_MINUTES = 60;
const MAX_SNOOZE_MINUTES = 24 * 60;

/**
 * One handler per tool, chosen by route rather than by sniffing the body:
 * Codex sends the same `hook_event_name` / `session_id` / `cwd` fields Claude
 * does, so the payload is genuinely ambiguous.
 */
function hookHandler(tool: SourceTool) {
  return async (req: FastifyRequest<{ Body: HookEventPayload }>, reply: FastifyReply) => {
    const payload = req.body;
    if (!payload?.session_id || !payload?.hook_event_name) {
      reply.code(400);
      return { error: "invalid hook payload" };
    }
    await handleHookEvent(payload, tool);
    return { ok: true };
  };
}

export async function hookRoutes(app: FastifyInstance) {
  // Unchanged path and contract: the already-installed Claude hooks post here.
  app.post<{ Body: HookEventPayload }>("/api/hook", hookHandler("claude"));
  app.post<{ Body: HookEventPayload }>("/api/hook/codex", hookHandler("codex"));

  app.get("/api/attention", async () => ({
    items: getAttentionItems(),
    // Additive: tells the dashboard whether Codex's push signal is real or
    // whether the staleness heuristic is carrying the load.
    hooks: { codex: getHookLiveness("codex") },
  }));

  // Both take the id in the body, not the path: attention ids are
  // `<sessionId>:<kind>`, and a colon in a URL segment is a needless
  // encode/decode hazard for no gain.
  app.post<{ Body: { id?: unknown; minutes?: unknown } }>(
    "/api/attention/snooze",
    async (req, reply) => {
      const id = req.body?.id;
      if (typeof id !== "string" || !id) {
        reply.code(400);
        return { error: "id is required" };
      }
      const requested = Number(req.body?.minutes ?? DEFAULT_SNOOZE_MINUTES);
      const minutes = Number.isFinite(requested)
        ? Math.min(Math.max(Math.round(requested), 1), MAX_SNOOZE_MINUTES)
        : DEFAULT_SNOOZE_MINUTES;

      if (!(await snoozeAttentionItem(id, minutes))) {
        reply.code(404);
        return { error: "no attention item with that id" };
      }
      return { items: getAttentionItems() };
    }
  );

  app.post<{ Body: { id?: unknown } }>("/api/attention/dismiss", async (req, reply) => {
    const id = req.body?.id;
    if (typeof id !== "string" || !id) {
      reply.code(400);
      return { error: "id is required" };
    }
    if (!(await dismissAttentionItem(id))) {
      reply.code(404);
      return { error: "no attention item with that id" };
    }
    return { items: getAttentionItems() };
  });
}
