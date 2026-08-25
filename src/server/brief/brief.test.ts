import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttentionItem, BoardCard, Project, UsageWindow } from "@shared/types.js";
import { composeBrief, speakDuration } from "./brief.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");

function project(path: string, sessions: Array<{ id: string; agoMs: number }>): Project {
  return {
    path,
    displayName: path.split("/").pop()!,
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    markdown: [],
    sessions: sessions.map((s) => ({
      tool: "claude" as const,
      sessionId: s.id,
      lastActivity: new Date(NOW - s.agoMs).toISOString(),
    })),
  };
}

function attn(sessionId: string, message: string): AttentionItem {
  return {
    id: `${sessionId}:waiting`,
    sessionId,
    projectPath: "/x",
    tool: "claude",
    type: "waiting",
    priority: "medium",
    message,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function card(title: string, column: BoardCard["column"]): BoardCard {
  return { id: title, title, column, createdAt: "", updatedAt: "" };
}

const IDLE_USAGE: UsageWindow = { active: false, observations: 0, estimate: true };

test("speakDuration reads aloud", () => {
  assert.equal(speakDuration(130 * 60_000), "2 hours and 10 minutes");
  assert.equal(speakDuration(60 * 60_000), "1 hour");
  assert.equal(speakDuration(45_000), "less than a minute");
});

test("blocked agents lead, with the reason inlined as a sentence", () => {
  const text = composeBrief({
    projects: [project("/dev/atlas", [{ id: "s1", agoMs: 60_000 }])],
    attention: [attn("s1", "Waiting for your review of the retry plan.")],
    cards: [],
    usage: IDLE_USAGE,
    now: NOW,
  });
  assert.match(text, /^One agent needs you\. atlas is waiting for your review of the retry plan\./);
});

test("quiet fleet says so and reads the board", () => {
  const text = composeBrief({
    projects: [],
    attention: [],
    cards: [card("Ship v2", "doing"), card("Write release notes", "next")],
    usage: IDLE_USAGE,
    now: NOW,
  });
  assert.match(text, /^All agents are quiet\./);
  assert.match(text, /1 card in progress; up next is Write release notes\./);
});

test("usage window is spoken as an estimate when active", () => {
  const text = composeBrief({
    projects: [],
    attention: [],
    cards: [],
    usage: {
      active: true,
      windowStart: new Date(NOW - 60_000).toISOString(),
      windowEnd: new Date(NOW + 2 * 3600_000).toISOString(),
      remainingMs: 2 * 3600_000,
      observations: 5,
      estimate: true,
    },
    now: NOW,
  });
  assert.match(text, /Claude window has 2 hours left, estimated\./);
});

test("active agents are named without duplicates", () => {
  const text = composeBrief({
    projects: [project("/dev/atlas", [{ id: "a1", agoMs: 60_000 }, { id: "a2", agoMs: 90_000 }])],
    attention: [],
    cards: [],
    usage: IDLE_USAGE,
    now: NOW,
  });
  assert.match(text, /2 agents are working right now, on atlas\./);
});
