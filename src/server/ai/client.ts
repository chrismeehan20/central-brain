import Anthropic from "@anthropic-ai/sdk";
import { getApiKey } from "./apiKey.js";

/**
 * The one Anthropic client, shared by summaries, project detail and the digest.
 *
 * Replaces three identical `let client: Anthropic | null | undefined` memos that
 * each read `process.env.ANTHROPIC_API_KEY` once and cached the answer forever.
 * That was fine when the key could only come from `.env` at boot, and wrong as
 * soon as it can be entered at runtime: saving a key would appear to do nothing
 * until the app was restarted.
 *
 * Keyed on the key itself, so a change invalidates the cache with no explicit
 * reset call to forget — and a key swap cannot leave a stale client behind.
 */
let cached: { key: string; client: Anthropic } | null = null;

/** The client to use, or null when no key is configured and AI features should no-op. */
export function getAnthropic(): Anthropic | null {
  const key = getApiKey();
  if (!key) {
    cached = null;
    return null;
  }
  if (cached?.key !== key) {
    cached = { key, client: new Anthropic({ apiKey: key }) };
  }
  return cached.client;
}
