import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardCard, Project } from "@shared/types.js";
import { buildEvidence, composeMinerPrompt, parseSuggestions, withoutExisting } from "./skillMiner.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function project(path: string, labels: Array<{ text: string; agoDays: number }>, hidden = false): Project {
  return {
    path,
    displayName: path.split("/").pop()!,
    discovered: false,
    hidden,
    pinned: false,
    missing: false,
    markdown: [],
    sessions: labels.map((l, i) => ({
      tool: "claude" as const,
      sessionId: `${path}-${i}`,
      lastActivity: new Date(NOW - l.agoDays * DAY).toISOString(),
      firstPrompt: l.text,
    })),
  };
}

test("evidence groups by project, counts sessions, and drops the stale and the hidden", () => {
  const { text, sessionCount } = buildEvidence(
    [
      project("/dev/atlas", [
        { text: "Cut a release", agoDays: 2 },
        { text: "Cut a release again", agoDays: 40 }, // outside the window
      ]),
      project("/dev/secret", [{ text: "hidden work", agoDays: 1 }], true),
    ],
    NOW,
  );
  assert.equal(sessionCount, 1);
  assert.match(text, /atlas \(1 sessions\):/);
  assert.match(text, /Cut a release/);
  assert.ok(!text.includes("hidden work"));
});

test("prompt demands strict JSON and recurrence", () => {
  const prompt = composeMinerPrompt("EVIDENCE");
  assert.match(prompt, /STRICT JSON/);
  assert.match(prompt, /at least three similar sessions/);
});

test("parseSuggestions handles fences, found:false, and garbage", () => {
  const fenced = parseSuggestions(
    '```json\n{"found": true, "suggestions": [{"title": "Release dance", "evidence": "seen 4x", "outline": "1. tag 2. build"}]}\n```',
  );
  assert.equal(fenced?.length, 1);
  assert.equal(fenced?.[0].title, "Release dance");

  assert.deepEqual(parseSuggestions('{"found": false}'), []);
  assert.equal(parseSuggestions("I could not find patterns."), null);
  assert.equal(parseSuggestions('{"found": true, "suggestions": "nope"}'), null);
});

test("withoutExisting drops suggestions already on the board, case-insensitively", () => {
  const cards: BoardCard[] = [
    { id: "1", title: "skill idea: release dance", column: "inbox", createdAt: "", updatedAt: "" },
  ];
  const kept = withoutExisting(
    [
      { title: "Release Dance", evidence: "", outline: "" },
      { title: "Weekly digest sweep", evidence: "", outline: "" },
    ],
    cards,
  );
  assert.deepEqual(kept.map((s) => s.title), ["Weekly digest sweep"]);
});
