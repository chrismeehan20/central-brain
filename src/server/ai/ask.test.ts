import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttentionItem, Project, UsageWindow } from "@shared/types.js";
import { answerQuestion, buildAskContext, composeAskPrompt, type AskInput } from "./ask.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const IDLE_USAGE: UsageWindow = { active: false, observations: 0, estimate: true };

function project(partial: Partial<Project> & { path: string }): Project {
  return {
    displayName: partial.path.split("/").pop()!,
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    sessions: [],
    markdown: [],
    ...partial,
  };
}

function input(partial: Partial<AskInput> = {}): AskInput {
  return { projects: [], attention: [], cards: [], usage: IDLE_USAGE, activity: [], now: NOW, ...partial };
}

test("context carries the waiting agent's reason and the project's CI state", () => {
  const attention: AttentionItem[] = [
    {
      id: "s1:waiting",
      sessionId: "s1",
      projectPath: "/dev/atlas",
      tool: "claude",
      type: "waiting",
      priority: "medium",
      message: "Waiting for your review",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    },
  ];
  const projects = [
    project({
      path: "/dev/atlas",
      lastActivity: new Date(NOW - 60_000).toISOString(),
      sessions: [{ tool: "claude", sessionId: "s1", lastActivity: new Date(NOW - 60_000).toISOString() }],
      github: { branch: "main", ciStatus: "failure", openPrs: [{ number: 7, title: "Fix retry", state: "OPEN", isDraft: false }] },
    }),
  ];
  const ctx = buildAskContext(input({ projects, attention }));
  assert.match(ctx, /atlas: WAITING ON USER — Waiting for your review/);
  assert.match(ctx, /CI failure/);
  assert.match(ctx, /PR #7 "Fix retry"/);
});

test("context stays under its cap with absurd inputs", () => {
  const projects = Array.from({ length: 200 }, (_, i) =>
    project({
      path: `/dev/p${i}`,
      lastActivity: new Date(NOW - i * 1000).toISOString(),
      summary: { text: "x".repeat(500), generatedAt: "", model: "", hash: "" },
    }),
  );
  const ctx = buildAskContext(input({ projects }));
  assert.ok(ctx.length <= 9000);
});

test("prompt frames a closed-book spoken answer around the question", () => {
  const prompt = composeAskPrompt("what's on fire?", "STATE");
  assert.match(prompt, /ONLY the state below/);
  assert.match(prompt, /Question: what's on fire\?/);
  assert.match(prompt, /never guess/);
});

test("answerQuestion validates the question before spending anything", async () => {
  let called = 0;
  const deps = { generate: async () => ((called += 1), "answer") };
  const empty = await answerQuestion("   ", input(), deps);
  assert.equal((empty as { status: number }).status, 400);
  const long = await answerQuestion("x".repeat(600), input(), deps);
  assert.equal((long as { status: number }).status, 400);
  assert.equal(called, 0);
});

test("answerQuestion surfaces the generator's status and answer", async () => {
  const ok = await answerQuestion("who is blocked?", input(), { generate: async () => "Nobody is blocked." });
  assert.deepEqual(ok, { answer: "Nobody is blocked." });

  const capped = await answerQuestion("who?", input(), {
    generate: async () => {
      throw Object.assign(new Error("cap reached"), { status: 429 });
    },
  });
  assert.equal((capped as { status: number }).status, 429);
});
