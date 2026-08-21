import type { FastifyInstance } from "fastify";
import { composeBrief } from "../brief/brief.js";
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
}
