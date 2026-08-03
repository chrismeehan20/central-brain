import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { DailyDigest } from "@shared/types.js";
import { digestDb } from "../store/db.js";
import { getCachedProjects } from "../scan/index.js";
import { getGithubStatus } from "../poll/githubPoller.js";
import { AI_MODEL, canSpend, capMessage, isDebounced, recordCall, today } from "./budget.js";
import { getAnthropic } from "./client.js";

const WINDOW_MS = 24 * 60 * 60_000;

/**
 * How old a digest may be and still be shown. Past this it is treated as
 * absent — a two-day-old paragraph about a two-day-old day is worse than
 * nothing, because it reads as current.
 */
export const DIGEST_MAX_AGE_MS = 48 * 60 * 60_000;

/** Bump when the digest prompt changes so cached digests regenerate. */
const PROMPT_VERSION = 2;

/**
 * Whether a stored digest is recent enough to serve. Absent, never-generated
 * (`generatedAt: ""`, which is what the error/cap fallback stores) and
 * unparseable timestamps are all stale.
 */
export function isDigestFresh(
  digest: { generatedAt: string } | null | undefined,
  now: Date = new Date()
): boolean {
  if (!digest?.generatedAt) return false;
  const at = Date.parse(digest.generatedAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= DIGEST_MAX_AGE_MS;
}

/** Last-24h activity, a few lines per project — the digest's evidence and its hash input. */
function buildContext(): string {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const lines: string[] = [];
  for (const p of getCachedProjects()) {
    if (p.hidden || p.missing) continue;
    if ((p.lastActivity ?? "") <= cutoff) continue;
    const sessions = p.sessions
      .filter((s) => s.lastActivity > cutoff)
      .slice(0, 3)
      .map((s) => `  - [${s.tool}] ${s.summary ?? s.firstPrompt ?? "(session)"}`);
    const gh = getGithubStatus(p.path);
    const commit =
      gh?.lastCommitMessage && (gh.lastCommitDate ?? "") > cutoff ? [`  - [commit] ${gh.lastCommitMessage}`] : [];
    if (!sessions.length && !commit.length) continue;
    lines.push(`${p.displayName}:\n${[...sessions, ...commit].join("\n")}`);
  }
  return lines.join("\n\n");
}

function hashInput(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

async function persist(digest: DailyDigest): Promise<DailyDigest> {
  digestDb.data.digest = digest;
  await digestDb.write();
  return digest;
}

/**
 * Cross-project daily digest — regenerated when the day rolls over or new
 * activity lands (hash-gated), so it stays a ~1-2-calls-per-day feature.
 *
 * Every path that hands back the *stored* digest goes through
 * `isDigestFresh` first: the invariant is that no digest text older than 48h
 * ever leaves the server, however quiet things have been. (The hash-match path
 * can't actually hold a stale digest — `today()` is in the hash, so yesterday's
 * digest never matches today's hash — but it's filtered too so the rule holds
 * by construction rather than by that coincidence.)
 */
export async function getOrGenerateDigest(force = false): Promise<DailyDigest | null> {
  const context = buildContext();
  const cached = digestDb.data.digest;
  const servable = isDigestFresh(cached) ? cached : null;

  if (!context) return servable; // nothing moved in 24h — show what we had only while it's current

  const hash = hashInput(`v${PROMPT_VERSION}\n${today()}\n${context}`);
  if (!force && cached && cached.hash === hash) return servable;
  if (force && isDebounced(cached?.generatedAt)) return servable;

  // Built from the *servable* cache, so an error/cap fallback carries the
  // failure without dragging stale prose back onto the dashboard with it.
  const fallback: DailyDigest = servable ?? {
    date: today(),
    text: "",
    generatedAt: "",
    model: AI_MODEL,
    hash: "",
  };
  if (!canSpend()) return persist({ ...fallback, lastError: capMessage() });

  const anthropic = getAnthropic();
  if (!anthropic) return servable;

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content:
            "You're helping a developer who juggles many side projects. From the last-24h activity below, write " +
            "ONE tight paragraph (3-4 sentences) telling them what moved across their projects. Wrap each " +
            "project name in **double asterisks**; use no other markdown, no bullet points, no preamble. " +
            "The final sentence must state the single thing that most needs their attention next.\n\n" +
            context,
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();

    await recordCall();
    if (!text) return servable;

    return persist({
      date: today(),
      text,
      generatedAt: new Date().toISOString(),
      model: AI_MODEL,
      hash,
      lastError: undefined,
    });
  } catch (err) {
    console.error("AI digest failed:", err);
    return persist({ ...fallback, lastError: String((err as Error)?.message ?? err) });
  }
}

/** The stored digest, or null once it has aged out. Routes serve this raw. */
export function getCachedDigest(): DailyDigest | null {
  const cached = digestDb.data.digest;
  return isDigestFresh(cached) ? cached : null;
}

/**
 * True when there is no digest for the boring reason: nothing moved in the last
 * 24h. The API-key check is what keeps it honest — someone who never configured
 * AI should see nothing at all, not a claim about their recorded activity.
 */
export function digestQuietState(): boolean {
  return !buildContext() && getAnthropic() !== null;
}
