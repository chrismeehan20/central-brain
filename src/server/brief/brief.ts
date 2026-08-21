import type { AttentionItem, BoardCard, Project, UsageWindow } from "@shared/types.js";
import { fleetRows } from "@shared/fleet.js";

/**
 * The spoken status brief behind GET /api/brief — written for Siri's voice,
 * not for a screen. An Apple Shortcut fetches it over Tailscale and hands it
 * to "Speak Text", so every line here must survive being read aloud: full
 * sentences, no symbols, no paths, durations in words. Same privacy rule as
 * everything else: project names and event kinds, never prompt contents.
 */

/** "about 2 hours and 10 minutes" — durations as Siri should say them. */
export function speakDuration(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (rest) parts.push(`${rest} minute${rest === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

/** Lowercase a hook message into the middle of a sentence without mangling names. */
function inline(message: string): string {
  const trimmed = message.trim().replace(/[.!]\s*$/, "");
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

export interface BriefInput {
  projects: Project[];
  attention: AttentionItem[];
  cards: BoardCard[];
  usage: UsageWindow;
  now: number;
}

export function composeBrief({ projects, attention, cards, usage, now }: BriefInput): string {
  const rows = fleetRows(projects, attention, now);
  const waiting = rows.filter((r) => r.status === "waiting");
  const active = rows.filter((r) => r.status === "active");
  const sentences: string[] = [];

  // Blocked agents lead — they are the reason to ask for a brief at all.
  if (waiting.length > 0) {
    const count = waiting.length === 1 ? "One agent needs" : `${waiting.length} agents need`;
    const details = waiting
      .slice(0, 3)
      .map((r) => `${r.projectName} is ${r.waitingOn ? inline(r.waitingOn) : "waiting on you"}`)
      .join(". ");
    const overflow = waiting.length > 3 ? ` And ${waiting.length - 3} more.` : "";
    sentences.push(`${count} you. ${details}.${overflow}`);
  }

  if (active.length > 0) {
    // Count sessions, name projects: "2 agents on atlas" is two sessions in
    // one repo, and both facts belong in the sentence.
    const names = [...new Set(active.map((r) => r.projectName))];
    const shown = names.slice(0, 3).join(", ");
    sentences.push(
      active.length === 1
        ? `One agent is working right now, on ${shown}.`
        : `${active.length} agents are working right now, on ${shown}${names.length > 3 ? " and others" : ""}.`,
    );
  }

  if (waiting.length === 0 && active.length === 0) {
    sentences.push("All agents are quiet.");
  }

  if (usage.active && usage.remainingMs !== undefined) {
    sentences.push(`Your Claude window has ${speakDuration(usage.remainingMs)} left, estimated.`);
  } else if (usage.windowStart) {
    sentences.push("A fresh Claude window opens with your next prompt.");
  }

  const doing = cards.filter((c) => c.column === "doing").length;
  const next = cards.find((c) => c.column === "next");
  if (doing > 0 || next) {
    const parts: string[] = [];
    if (doing > 0) parts.push(`${doing} card${doing === 1 ? "" : "s"} in progress`);
    if (next) parts.push(`up next is ${next.title}`);
    sentences.push(`On the board: ${parts.join("; ")}.`);
  }

  return sentences.join(" ");
}
