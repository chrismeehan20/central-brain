import type { FastifyInstance } from "fastify";
import { composeBrief } from "../brief/brief.js";
import { answerQuestion } from "../ai/ask.js";
import { runSkillMiner } from "../ai/skillMiner.js";
import { getActivityEvents } from "../alert/activity.js";
import { getAttentionItems } from "../alert/attention.js";
import { getBoardCards } from "../board/board.js";
import { getUsageWindow } from "../usage/usage.js";
import { getCachedProjects, getLastScanAt, runScan } from "../scan/index.js";

interface BriefQuery {
  format?: string;
}

/**
 * The Siri endpoint. An Apple Shortcut ("Get Contents of URL" over Tailscale,
 * then "Speak Text") reads this to the user; plain text is the default so the
 * Shortcut needs zero parsing steps. `?format=json` adds the same text plus
 * the raw numbers for Shortcuts that want to branch ("only speak when
 * something needs me").
 */
export async function briefRoutes(app: FastifyInstance) {
  app.get<{ Querystring: BriefQuery }>("/api/brief", async (req, reply) => {
    if (!getLastScanAt()) runScan();
    const projects = getCachedProjects();
    const attention = getAttentionItems();
    const cards = getBoardCards();
    const usage = getUsageWindow();
    const now = Date.now();
    const text = composeBrief({ projects, attention, cards, usage, now });

    if (req.query.format === "json") {
      const waiting = attention.filter(
        (i) => i.type !== "done" && (!i.snoozedUntil || Date.parse(i.snoozedUntil) <= now),
      ).length;
      return {
        text,
        waiting,
        cardsInProgress: cards.filter((c) => c.column === "doing").length,
        usage,
      };
    }
    reply.type("text/plain; charset=utf-8");
    return text;
  });

  // Free-form voice Q&A: the brief's big sibling. Costs one budgeted AI call
  // per question; answers only from state the dashboard already computed.
  // Plain text by default so a Shortcut can pipe it straight to Speak Text.
  app.post<{ Body: { question?: unknown }; Querystring: BriefQuery }>(
    "/api/ask",
    async (req, reply) => {
      const question = req.body?.question;
      if (typeof question !== "string") {
        reply.code(400);
        return { error: "Send JSON like {\"question\": \"which project has failing CI?\"}" };
      }
      if (!getLastScanAt()) runScan();
      const result = await answerQuestion(question, {
        projects: getCachedProjects(),
        attention: getAttentionItems(),
        cards: getBoardCards(),
        usage: getUsageWindow(),
        activity: getActivityEvents(),
        now: Date.now(),
      });
      if ("error" in result) {
        reply.code(result.status);
        return { error: result.error };
      }
      if (req.query.format === "json") return { answer: result.answer };
      reply.type("text/plain; charset=utf-8");
      return result.answer;
    },
  );

  // Manual skill-miner run. `force` skips only the weekly cadence — the
  // budget, the evidence minimum, and the unchanged-evidence gate still hold.
  app.post("/api/skill-miner/run", async () => {
    if (!getLastScanAt()) runScan();
    return await runSkillMiner(true);
  });
}
