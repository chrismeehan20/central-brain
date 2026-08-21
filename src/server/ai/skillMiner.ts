import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { BoardCard, Project } from "@shared/types.js";
import { getAnthropic } from "./client.js";
import { AI_MODEL, canSpend, recordCall } from "./budget.js";
import { skillMinerDb } from "../store/db.js";
import { createCard, getBoardCards } from "../board/board.js";
import { getCachedProjects } from "../scan/index.js";

/**
 * The skill miner: don't guess what's worth codifying — read what actually
 * repeats. Once a week it looks at the opening prompts and summaries of the
 * last month of agent sessions (metadata Central Brain already holds; no
 * transcript files are read), asks the model to spot workflows that recur
 * often enough to deserve a reusable Claude Code skill, and files each
 * suggestion as a card in the board's inbox — where the user triages
 * everything else. The suggestion is a card, not a generated skill: deciding
 * what becomes durable automation stays a human call.
 */

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CADENCE_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this many sessions the month is too thin to claim a pattern. */
const MIN_SESSIONS = 15;
const MAX_SUGGESTIONS = 2;
const CARD_PREFIX = "Skill idea: ";

/** One line per session, grouped by project — the model sees intent, not content. */
export function buildEvidence(projects: Project[], now: number): { text: string; sessionCount: number } {
  const lines: string[] = [];
  let sessionCount = 0;
  for (const project of projects) {
    if (project.hidden) continue;
    const labels = project.sessions
      .filter((s) => now - Date.parse(s.lastActivity) <= WINDOW_MS)
      .map((s) => (s.summary ?? s.firstPrompt ?? "").replace(/\s+/g, " ").trim().slice(0, 120))
      .filter(Boolean);
    if (!labels.length) continue;
    sessionCount += labels.length;
    lines.push(`${project.displayName} (${labels.length} sessions):`);
    for (const label of labels.slice(0, 25)) lines.push(`  - ${label}`);
  }
  return { text: lines.join("\n").slice(0, 12_000), sessionCount };
}

export interface SkillSuggestion {
  title: string;
  evidence: string;
  outline: string;
}

export function composeMinerPrompt(evidence: string): string {
  return (
    "Below are the opening prompts and summaries of a developer's Claude Code / Codex sessions from the " +
    "last 30 days, grouped by project. Identify at most " +
    `${MAX_SUGGESTIONS} workflows that RECUR often enough to be worth codifying as a reusable Claude Code ` +
    "skill (a written, repeatable procedure). A pattern needs at least three similar sessions to count. " +
    "Prefer boring, concrete, high-frequency work over interesting one-offs.\n\n" +
    'Reply with STRICT JSON only, no prose: {"found": false} or ' +
    '{"found": true, "suggestions": [{"title": "<imperative skill name, under 60 chars>", ' +
    '"evidence": "<one sentence citing the repetition you saw>", ' +
    '"outline": "<3-5 short numbered steps the skill would perform>"}]}\n\n' +
    evidence
  );
}

/** Tolerant of the model wrapping JSON in fences or prose; null when unusable. */
export function parseSuggestions(raw: string): SkillSuggestion[] | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { found?: unknown; suggestions?: unknown };
    if (parsed.found !== true) return [];
    if (!Array.isArray(parsed.suggestions)) return null;
    return parsed.suggestions
      .filter(
        (s): s is SkillSuggestion =>
          typeof (s as SkillSuggestion)?.title === "string" &&
          typeof (s as SkillSuggestion)?.evidence === "string" &&
          typeof (s as SkillSuggestion)?.outline === "string",
      )
      .slice(0, MAX_SUGGESTIONS);
  } catch {
    return null;
  }
}

/** Drop suggestions whose card already exists — a re-run must not spam the inbox. */
export function withoutExisting(suggestions: SkillSuggestion[], cards: BoardCard[]): SkillSuggestion[] {
  const titles = new Set(cards.map((c) => c.title.toLowerCase()));
  return suggestions.filter((s) => !titles.has(`${CARD_PREFIX}${s.title}`.toLowerCase()));
}

export type MineResult = { filed: string[] } | { skipped: string };

/**
 * One mining pass. `force` skips the weekly cadence gate (the manual route),
 * never the budget, the evidence minimum, or the unchanged-evidence gate —
 * re-running on identical evidence would pay for the same answer twice.
 */
export async function runSkillMiner(force = false, now = Date.now()): Promise<MineResult> {
  const anthropic = getAnthropic();
  if (!anthropic) return { skipped: "no API key configured" };
  if (!canSpend()) return { skipped: "daily AI cap reached" };

  const last = skillMinerDb.data.generatedAt ? Date.parse(skillMinerDb.data.generatedAt) : 0;
  if (!force && now - last < CADENCE_MS) return { skipped: "ran within the last week" };

  const { text, sessionCount } = buildEvidence(getCachedProjects(), now);
  if (sessionCount < MIN_SESSIONS) {
    return { skipped: `only ${sessionCount} sessions in the last 30 days (needs ${MIN_SESSIONS})` };
  }
  const hash = createHash("sha256").update(text).digest("hex");
  if (!force && hash === skillMinerDb.data.hash) return { skipped: "no new session evidence since last run" };

  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content: composeMinerPrompt(text) }],
  });
  await recordCall();
  skillMinerDb.data.generatedAt = new Date(now).toISOString();
  skillMinerDb.data.hash = hash;
  await skillMinerDb.write();

  const raw = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const suggestions = parseSuggestions(raw);
  if (suggestions === null) return { skipped: "model reply wasn't parseable" };

  const fresh = withoutExisting(suggestions, getBoardCards());
  const filed: string[] = [];
  for (const s of fresh) {
    const title = `${CARD_PREFIX}${s.title}`.slice(0, 300);
    await createCard({
      title,
      note:
        `${s.evidence}\n\nSuggested skill outline:\n${s.outline}\n\n` +
        "Mined from your last 30 days of session activity. Delete this card if it's off; " +
        "run it past Claude Code to draft the actual skill if it's right.",
    });
    filed.push(title);
  }
  return { filed };
}

/**
 * Boot wiring: first look shortly after startup (once the initial scan has
 * populated sessions), then a twice-daily check that the weekly cadence gate
 * turns into an actual weekly run. Failures log and wait for the next tick —
 * a mining pass must never take the server down.
 */
export function startSkillMinerPoller(log: (msg: string) => void = () => {}): void {
  const tick = async () => {
    try {
      const result = await runSkillMiner();
      if ("filed" in result && result.filed.length) {
        log(`skill miner filed: ${result.filed.join("; ")}`);
      }
    } catch (err) {
      log(`skill miner failed: ${(err as Error).message}`);
    }
  };
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, 12 * 60 * 60 * 1000);
}
