import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Project, ProjectSummary } from "@shared/types.js";
import { summariesDb } from "../store/db.js";

const MODEL = "claude-haiku-4-5-20251001";

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
  return `Project: ${project.displayName}\n\nMarkdown docs present:\n${docs || "(none)"}\n\nRecent session summaries:\n${recent || "(none)"}`;
}

function hashInput(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
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

  const anthropic = getClient();
  if (!anthropic) return cached;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
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

    if (!text) return cached;

    const summary: ProjectSummary = { text, generatedAt: new Date().toISOString(), model: MODEL, hash };
    summariesDb.data[project.path] = summary;
    await summariesDb.write();
    return summary;
  } catch (err) {
    console.error("AI summary failed:", err);
    return cached;
  }
}

export function getCachedSummary(projectPath: string): ProjectSummary | undefined {
  return summariesDb.data[projectPath];
}
