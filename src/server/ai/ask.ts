import type Anthropic from "@anthropic-ai/sdk";
import type {
  ActivityEvent,
  AttentionItem,
  BoardCard,
  Project,
  UsageWindow,
} from "@shared/types.js";
import { fleetRows } from "@shared/fleet.js";
import { getAnthropic } from "./client.js";
import { AI_MODEL, canSpend, capMessage, recordCall } from "./budget.js";
import { speakDuration } from "../brief/brief.js";

/**
 * Free-form Q&A over the brain's own state — the voice tier the fixed
 * /api/brief can't cover ("which project has the failing CI?", "what did the
 * atlas agent last do?"). Deliberately a closed-book answerer: the model sees
 * ONLY the state Central Brain already computed and is told to say so when
 * the answer isn't in it. No search, no tools, no reading files — that keeps
 * it fast enough for voice, cheap enough for the daily cap, and honest.
 */

const MAX_QUESTION = 500;

/** Per-section and overall caps: this context rides a small model on a daily budget. */
const MAX_CONTEXT = 9000;

function rel(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clip(text: string | undefined, max: number): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export interface AskInput {
  projects: Project[];
  attention: AttentionItem[];
  cards: BoardCard[];
  usage: UsageWindow;
  activity: ActivityEvent[];
  now: number;
}

/**
 * The evidence pack, as labeled plain-text sections. Pure so the caps and
 * the shape are testable without a client.
 */
export function buildAskContext({ projects, attention, cards, usage, activity, now }: AskInput): string {
  const rows = fleetRows(projects, attention, now);
  const sections: string[] = [];

  const waiting = rows.filter((r) => r.status === "waiting");
  const active = rows.filter((r) => r.status === "active");
  sections.push(
    "AGENTS NOW:\n" +
      (waiting.length || active.length
        ? [
            ...waiting.map((r) => `- ${r.projectName}: WAITING ON USER — ${clip(r.waitingOn, 120) || "blocked"}`),
            ...active.map((r) => `- ${r.projectName}: working now (${clip(r.label, 80) || "no summary"})`),
          ].join("\n")
        : "- all quiet"),
  );

  const visible = projects
    .filter((p) => !p.hidden && !p.missing)
    .sort((a, b) => Date.parse(b.lastActivity ?? "0") - Date.parse(a.lastActivity ?? "0"))
    .slice(0, 25);
  sections.push(
    "PROJECTS (most recent first):\n" +
      visible
        .map((p) => {
          const gh = p.github;
          const bits = [
            `last activity ${rel(p.lastActivity, now)}`,
            gh?.branch ? `branch ${gh.branch}` : "",
            gh?.dirty ? "uncommitted changes" : "",
            gh?.ciStatus ? `CI ${gh.ciStatus}` : "",
            gh?.openPrs?.length ? `${gh.openPrs.length} open PR${gh.openPrs.length === 1 ? "" : "s"}` : "",
          ].filter(Boolean);
          const prs = (gh?.openPrs ?? [])
            .slice(0, 3)
            .map((pr) => `PR #${pr.number} "${clip(pr.title, 60)}"${pr.ciStatus ? ` (CI ${pr.ciStatus})` : ""}`)
            .join("; ");
          return (
            `- ${p.displayName}: ${bits.join(", ")}.` +
            (p.summary?.text ? ` Status: ${clip(p.summary.text, 140)}` : "") +
            (prs ? ` ${prs}.` : "")
          );
        })
        .join("\n"),
  );

  sections.push(
    "BOARD:\n" +
      (cards.length
        ? cards
            .map((c) => `- [${c.column}] ${clip(c.title, 90)}${c.projectPath ? ` (${c.projectPath.split("/").pop()})` : ""}`)
            .join("\n")
        : "- empty"),
  );

  sections.push(
    "CLAUDE USAGE WINDOW (estimated): " +
      (usage.active && usage.remainingMs !== undefined
        ? `about ${speakDuration(usage.remainingMs)} left`
        : usage.windowStart
          ? "expired; a fresh window opens on the next prompt"
          : "no data"),
  );

  sections.push(
    "RECENT AGENT EVENTS (newest first):\n" +
      (activity.length
        ? activity
            .slice(-15)
            .reverse()
            .map((e) => `- ${rel(e.at, now)}: ${e.projectPath?.split("/").pop() ?? "unknown"} (${e.tool}) — ${e.message}`)
            .join("\n")
        : "- none recorded"),
  );

  const context = sections.join("\n\n");
  return context.length > MAX_CONTEXT ? context.slice(0, MAX_CONTEXT) : context;
}

export function composeAskPrompt(question: string, context: string): string {
  return (
    "You are Central Brain's voice — a dashboard tracking a developer's AI-agent sessions, projects, " +
    "and task board. Answer the question using ONLY the state below. Speak the answer: one to three plain " +
    "sentences, no markdown, no symbols, no paths unless asked, suitable for text-to-speech. If the state " +
    "doesn't contain the answer, say you don't have that in front of you — never guess or invent.\n\n" +
    `=== CURRENT STATE ===\n${context}\n=== END STATE ===\n\n` +
    `Question: ${question}`
  );
}

export type AskResult = { answer: string } | { error: string; status: number };

export interface AskDeps {
  /** Injectable generation for tests; production calls the shared client. */
  generate?: (prompt: string) => Promise<string>;
}

export async function answerQuestion(question: string, input: AskInput, deps: AskDeps = {}): Promise<AskResult> {
  const trimmed = question.trim();
  if (!trimmed || trimmed.length > MAX_QUESTION) {
    return { error: `question must be 1–${MAX_QUESTION} characters`, status: 400 };
  }

  const generate =
    deps.generate ??
    (async (prompt: string) => {
      const anthropic = getAnthropic();
      if (!anthropic) {
        throw Object.assign(new Error("Add an Anthropic API key in ⚙ settings to use ask."), { status: 400 });
      }
      if (!canSpend()) {
        throw Object.assign(new Error(capMessage()), { status: 429 });
      }
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 250,
        messages: [{ role: "user", content: prompt }],
      });
      await recordCall();
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    });

  try {
    const answer = await generate(composeAskPrompt(trimmed, buildAskContext(input)));
    if (!answer) return { error: "The model returned nothing — try rephrasing.", status: 502 };
    return { answer };
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return { error: (err as Error).message ?? String(err), status };
  }
}
