import type { FastifyInstance } from "fastify";
import { apiKeyStatus, clearApiKey, dismissSetup, saveApiKey } from "../ai/apiKey.js";
import { AI_MODEL, callsRemaining, dailyCap } from "../ai/budget.js";

interface ApiKeyBody {
  apiKey?: string;
}

/**
 * Settings the user can change without a terminal — currently just the
 * Anthropic API key, which is the one thing a packaged app genuinely cannot
 * obtain any other way.
 *
 * The key itself is never sent back to the client: every response carries an
 * `ApiKeyStatus` with a last-4 hint instead. Localhost-only binding is not a
 * reason to hand a live credential to a webview that also renders project text.
 */
export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => ({
    apiKey: apiKeyStatus(),
    ai: { model: AI_MODEL, dailyCap: dailyCap(), callsRemaining: callsRemaining() },
  }));

  app.put<{ Body: ApiKeyBody }>("/api/settings/api-key", async (req, reply) => {
    const apiKey = req.body?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      reply.code(400);
      return { error: "apiKey is required" };
    }

    const result = await saveApiKey(apiKey);
    if (!result.ok) {
      // 400, not 502: the actionable problem is almost always the pasted value,
      // and the message says so when it was a network failure instead.
      reply.code(400);
      return { error: result.error };
    }
    return { apiKey: result.status };
  });

  app.delete("/api/settings/api-key", async () => ({ apiKey: await clearApiKey() }));

  /** "Skip for now" — the dashboard is fully usable without a key. */
  app.post("/api/settings/dismiss-setup", async () => ({ apiKey: await dismissSetup() }));
}
