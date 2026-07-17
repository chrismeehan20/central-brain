import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Project, ProjectSummary } from "@shared/types.js";
import { summariesDb } from "../store/db.js";
import { AI_MODEL, canSpend, capMessage, isDebounced, recordCall } from "./budget.js";
import { readDocBodies } from "./docBodies.js";

let client: Anthropic | null | undefined;
function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  return client;
}

function buildContext(project: Project): string {
  const docs = project.markdown
    .slice(0, 5)
    .map((d) => `## ${d.relativePath}${d.firstHeading ? ` — ${d.firstHeading}` : ""}`)
    .join("\n");
  const recent = project.sessions
    .slice(0, 8)
    .map((s) => `- [${s.tool}] ${s.summary ?? s.firstPrompt ?? "(no summary)"}`)
    .join("\n");
  // Doc bodies are part of the context (and therefore the hash) so editing a
  // README/PLAN actually regenerates the summary — headings alone miss that.
  const bodies = readDocBodies(project, { budget: 3000, perDoc: 800 });
  return (
    `Project: ${project.displayName}\n\nMarkdown docs present:\n${docs || "(none)"}\n\n` +
    `Recent session summaries:\n${recent || "(none)"}` +
    (bodies ? `\n\nDoc contents (truncated):\n${bodies}` : "")
  );
}

function hashInput(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** Persist a failure so the UI can show it. Never stores the new hash — the next poll retries. */
async function recordFailure(projectPath: string, cached: ProjectSummary | undefined, message: string): Promise<ProjectSummary> {
  const summary: ProjectSummary = cached
    ? { ...cached, lastError: message }
    : { text: "", generatedAt: "", model: AI_MODEL, hash: "", lastError: message };
  summariesDb.data[projectPath] = summary;
  await summariesDb.write();
  return summary;
}

/**
 * Hash-gated so it only calls the API when the project's docs/sessions
 * have actually changed since the last summary — cheap enough to run on
 * a slow background schedule, not just on manual refresh.
 */
export async function getOrGenerateSummary(project: Project, force = false): Promise<ProjectSummary | undefined> {
  const context = buildContext(project);
  const hash = hashInput(context);
  const cached = summariesDb.data[project.path];
  if (!force && cached && cached.hash === hash) {
    return cached;
  }

  // Debounce rapid manual refreshes, and never exceed the daily call cap —
  // both fall back to the cached summary without spending a token.
  if (force && isDebounced(cached?.generatedAt)) return cached;
  if (!canSpend()) return recordFailure(project.path, cached, capMessage());

  const anthropic = getClient();
  if (!anthropic) return cached;

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content:
            "You're helping a developer track many side projects at once. Based on this project's docs and recent " +
            "AI-coding-session summaries, write ONE short sentence (under 25 words) describing what's likely left " +
            "to build or its current state. Be concrete, not generic — no preamble, just the sentence.\n\n" +
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

    const summary: ProjectSummary = {
      text,
      generatedAt: new Date().toISOString(),
      model: AI_MODEL,
      hash,
      lastError: undefined,
    };
    summariesDb.data[project.path] = summary;
    await summariesDb.write();
    return summary;
  } catch (err) {
    console.error("AI summary failed:", err);
    return recordFailure(project.path, cached, String((err as Error)?.message ?? err));
  }
}

export function getCachedSummary(projectPath: string): ProjectSummary | undefined {
  return summariesDb.data[projectPath];
}
