import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { DailyDigest } from "@shared/types.js";
import { digestDb } from "../store/db.js";
import { getCachedProjects } from "../scan/index.js";
import { getGithubStatus } from "../poll/githubPoller.js";
import { AI_MODEL, canSpend, capMessage, isDebounced, recordCall, today } from "./budget.js";
import { getAnthropic } from "./client.js";

const WINDOW_MS = 24 * 60 * 60_000;

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
 */
export async function getOrGenerateDigest(force = false): Promise<DailyDigest | null> {
  const context = buildContext();
  const cached = digestDb.data.digest;

  if (!context) return cached; // nothing moved in 24h — keep whatever we had

  const hash = hashInput(`${today()}\n${context}`);
  if (!force && cached && cached.hash === hash) return cached;
  if (force && isDebounced(cached?.generatedAt)) return cached;

  const fallback: DailyDigest = cached ?? {
    date: today(),
    text: "",
    generatedAt: "",
    model: AI_MODEL,
    hash: "",
  };
  if (!canSpend()) return persist({ ...fallback, lastError: capMessage() });

  const anthropic = getAnthropic();
  if (!anthropic) return cached;

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content:
            "You're helping a developer who juggles many side projects. From the last-24h activity below, write " +
            "ONE tight paragraph (3-5 sentences) telling them what moved across their projects and what most " +
            "needs their attention next. Name the projects. Plain text only — no markdown, no asterisks, no " +
            "bullet points, no preamble.\n\n" +
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
    if (!text) return cached;

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

export function getCachedDigest(): DailyDigest | null {
  return digestDb.data.digest;
}
