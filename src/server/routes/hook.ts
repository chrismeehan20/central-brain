import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HookEventPayload, SourceTool } from "@shared/types.js";
import { handleHookEvent, getAttentionItems } from "../alert/attention.js";
import { getHookLiveness } from "../alert/hookLiveness.js";

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
}
