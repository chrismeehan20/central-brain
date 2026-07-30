import Anthropic from "@anthropic-ai/sdk";
import type { ApiKeySource, ApiKeyStatus } from "@shared/types.js";
import { settingsDb, writeSettings } from "../store/db.js";

/**
 * Where the Anthropic API key comes from, and how it gets there.
 *
 * Two sources, deliberately ordered:
 *  - `env`      — `ANTHROPIC_API_KEY`, i.e. `.env` under `npm run dev`, or a
 *                 shell that exported it. Wins, because someone who set it in
 *                 the environment meant it, and silently preferring a stored
 *                 key would make `.env` edits look broken.
 *  - `settings` — entered through the dashboard, stored in the user-data dir.
 *                 The only path that works in a packaged `.app`, whose sidecar
 *                 runs with cwd `/` and therefore never loads a `.env`.
 *
 * The key is never returned to the client. Only `ApiKeyStatus` crosses the
 * wire, and it carries a last-4 hint rather than the value.
 */

/**
 * An env var set to "" or whitespace is unset, not a key. The same trap as
 * appPaths.envPath: the bundle test injects `ANTHROPIC_API_KEY: ""` precisely
 * so no real call can happen, and that must read as absent rather than as a
 * key that fails every request.
 */
function envKey(env: NodeJS.ProcessEnv): string | null {
  const trimmed = env.ANTHROPIC_API_KEY?.trim();
  return trimmed ? trimmed : null;
}

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): {
  key: string | null;
  source: ApiKeySource;
} {
  const fromEnv = envKey(env);
  if (fromEnv) return { key: fromEnv, source: "env" };

  const stored = settingsDb.data.apiKey?.trim();
  if (stored) return { key: stored, source: "settings" };

  return { key: null, source: "none" };
}

/** The key to use, or null when AI features should stay switched off. */
export function getApiKey(): string | null {
  return resolveApiKey().key;
}

export function apiKeyStatus(): ApiKeyStatus {
  const { key, source } = resolveApiKey();
  return {
    configured: key !== null,
    source,
    hint: key ? key.slice(-4) : null,
    managedByEnv: source === "env",
    setupDismissed: settingsDb.data.setupDismissed,
  };
}

/**
 * Cheap local sanity check before spending a network round trip on an obvious
 * paste error (a whole shell line, a truncated key, an OpenAI key).
 */
export function looksLikeAnthropicKey(value: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

/**
 * Verify a key against the real API before saving it.
 *
 * Uses `models.list`, which authenticates without generating tokens, so
 * onboarding costs nothing and does not touch the daily call budget. A key that
 * saves but then fails on every summary is the failure mode this prevents.
 */
export async function validateApiKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Paste a key first." };
  if (!looksLikeAnthropicKey(trimmed)) {
    return {
      ok: false,
      error: "That does not look like an Anthropic key — they start with `sk-ant-`.",
    };
  }

  try {
    const client = new Anthropic({ apiKey: trimmed, maxRetries: 1 });
    await client.models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return { ok: false, error: "Anthropic rejected that key. Check it was copied in full." };
    }
    const message = (err as Error).message ?? String(err);
    return { ok: false, error: `Could not reach Anthropic to verify the key: ${message}` };
  }
}

/** Validate, then persist. Returns the failure instead of storing a key that cannot work. */
export async function saveApiKey(key: string): Promise<{ ok: true; status: ApiKeyStatus } | { ok: false; error: string }> {
  const result = await validateApiKey(key);
  if (!result.ok) return result;

  settingsDb.data.apiKey = key.trim();
  settingsDb.data.setupDismissed = true;
  await writeSettings();
  return { ok: true, status: apiKeyStatus() };
}

export async function clearApiKey(): Promise<ApiKeyStatus> {
  settingsDb.data.apiKey = "";
  await writeSettings();
  return apiKeyStatus();
}

/** Remember that the user chose to run without AI, so onboarding stops nagging. */
export async function dismissSetup(): Promise<ApiKeyStatus> {
  settingsDb.data.setupDismissed = true;
  await writeSettings();
  return apiKeyStatus();
}
