import type { FastifyInstance } from "fastify";
import type { HookEventPayload } from "@shared/types.js";
import { handleClaudeHookEvent, getAttentionItems } from "../alert/attention.js";

export async function hookRoutes(app: FastifyInstance) {
  app.post<{ Body: HookEventPayload }>("/api/hook", async (req, reply) => {
    const payload = req.body;
    if (!payload?.session_id || !payload?.hook_event_name) {
      reply.code(400);
      return { error: "invalid hook payload" };
    }
    await handleClaudeHookEvent(payload);
    return { ok: true };
  });

  app.get("/api/attention", async () => ({ items: getAttentionItems() }));
}
