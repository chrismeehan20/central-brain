import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Project, ProjectSummary } from "@shared/types.js";
import { summariesDb } from "../store/db.js";
import { AI_MODEL, canSpend, capMessage, isDebounced, recordCall } from "./budget.js";
import { getAnthropic } from "./client.js";
import { readDocBodies } from "./docBodies.js";
import { readCommitSubjects } from "./gitEvidence.js";

/**
 * Evidence for the one-line summary, labelled by what each source actually
 * proves.
 *
 * The labelling is the point. Docs describe plans and session summaries
 * describe what a session was *about*, so on their own they cannot distinguish
 * "still to do" from "shipped last week" — which is how a project whose commits
 * clearly landed a feature still got summarised as needing to build it. Recent
 * commits settle it, exactly as they already do for project detail.
 *
 * The commit list is part of the hash too, so a new commit regenerates the
 * summary instead of leaving a contradicted one on the card.
 */
async function buildContext(project: Project): Promise<string> {
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
  const shipped = await readCommitSubjects(project.path);
  return [
    `Project: ${project.displayName}`,
    shipped
      ? `ALREADY SHIPPED (recent commits — this work is DONE; never describe it as still needed):\n${shipped}`
      : "ALREADY SHIPPED: (no git history)",
    `PLANS AND NOTES — markdown docs present (may describe work already finished):\n${docs || "(none)"}`,
    `RECENT SESSIONS — what was being worked on, not proof it finished:\n${recent || "(none)"}`,
    bodies ? `Doc contents (truncated):\n${bodies}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function hashInput(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/**
 * The model's opt-out. Asking for a sentinel instead of prose is what keeps
 * "I don't have enough evidence to say what's left to build" off the card: a
 * fixed token we can detect beats a paragraph we can only display.
 */
const INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE";

/**
 * Whether the model opted out. Tolerant of the wrappers models add on their own
 * — quotes, backticks, `**bold**` — and of a trailing explanation after the
 * sentinel, but only when the reply *starts* with it: a real summary that
 * happens to mention insufficient evidence mid-sentence is still a summary.
 */
export function isInsufficientEvidence(text: string): boolean {
  const unwrapped = text.trim().replace(/^[\s"'`*_“‘]+/, "");
  return unwrapped.toUpperCase().startsWith(INSUFFICIENT_EVIDENCE);
}

async function persist(projectPath: string, summary: ProjectSummary): Promise<ProjectSummary> {
  summariesDb.data[projectPath] = summary;
  await summariesDb.write();
  return summary;
}

/** Persist a failure so the UI can show it. Never stores the new hash — the next poll retries. */
function recordFailure(projectPath: string, cached: ProjectSummary | undefined, message: string): Promise<ProjectSummary> {
  return persist(
    projectPath,
    cached
      ? { ...cached, lastError: message }
      : { text: "", generatedAt: "", model: AI_MODEL, hash: "", lastError: message }
  );
}

/**
 * Hash-gated so it only calls the API when the project's docs/sessions
 * have actually changed since the last summary — cheap enough to run on
 * a slow background schedule, not just on manual refresh.
 */
export async function getOrGenerateSummary(project: Project, force = false): Promise<ProjectSummary | undefined> {
  const context = await buildContext(project);
  const hash = hashInput(context);
  const cached = summariesDb.data[project.path];
  if (!force && cached && cached.hash === hash) {
    return cached;
  }

  // Debounce rapid manual refreshes, and never exceed the daily call cap —
  // both fall back to the cached summary without spending a token.
  if (force && isDebounced(cached?.generatedAt)) return cached;
  if (!canSpend()) return recordFailure(project.path, cached, capMessage());

  const anthropic = getAnthropic();
  if (!anthropic) return cached;

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content:
            "You're helping a developer track many side projects at once. Write ONE short sentence (under 25 words) " +
            "describing what's likely left to build, or the project's current state. Be concrete, not generic — no " +
            "preamble, just the sentence.\n\n" +
            "Weigh the evidence by what it proves: anything under ALREADY SHIPPED is finished, so never present it " +
            "as outstanding. Plans and session topics are what was intended or discussed, which is not proof it " +
            "shipped. If the docs and the commits disagree, trust the commits.\n\n" +
            `If the evidence below isn't enough for a concrete, grounded sentence, reply with exactly ${INSUFFICIENT_EVIDENCE} ` +
            "and nothing else — do not explain, hedge, or guess.\n\n" +
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

    // Store the sentinel verdict *with* the hash: the call is spent either way,
    // so the point is not to spend another one until the evidence changes.
    if (isInsufficientEvidence(text)) {
      return persist(project.path, {
        text: "",
        generatedAt: new Date().toISOString(),
        model: AI_MODEL,
        hash,
        insufficientEvidence: true,
      });
    }

    return persist(project.path, {
      text,
      generatedAt: new Date().toISOString(),
      model: AI_MODEL,
      hash,
      lastError: undefined,
    });
  } catch (err) {
    console.error("AI summary failed:", err);
    return recordFailure(project.path, cached, String((err as Error)?.message ?? err));
  }
}

export function getCachedSummary(projectPath: string): ProjectSummary | undefined {
  return summariesDb.data[projectPath];
}
