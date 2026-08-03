import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodexHooksDiagnosis, CodexHooksOverall } from "@shared/types";
import { ACTIONABLE_CODEX_STATES, claudeRow, codexRow } from "./hooksCopy";

/**
 * The copy is what was actually wrong before: the server's booleans could
 * disagree and the panel's if-ordering picked a winner, so a hook pointing at
 * a path that no longer existed said "Connected — events are arriving".
 */

const ALL_STATES: CodexHooksOverall[] = [
  "not_detected",
  "config_error",
  "disabled",
  "needs_install",
  "needs_repair",
  "needs_review",
  "waiting_for_verification",
  "connected",
  "stale",
];

function diagnosis(overall: CodexHooksOverall, extra: Partial<CodexHooksDiagnosis> = {}): CodexHooksDiagnosis {
  return {
    overall,
    codexHome: "/Users/someone/.codex",
    hooksPath: "/Users/someone/.codex/hooks.json",
    forwarderPath: "/Users/someone/Library/Application Support/central-brain/hooks/notify-codex.sh",
    missingEvents: [],
    staleEvents: [],
    duplicatedEvents: [],
    approval: "unknown",
    diagnostics: [],
    ...extra,
  };
}

test("every state produces copy — no state can render blank", () => {
  for (const overall of ALL_STATES) {
    const row = codexRow(diagnosis(overall));
    assert.ok(row.state.length > 0, `${overall} has no state line`);
  }
});

test("only connected reads as good, and only connected says Connected", () => {
  for (const overall of ALL_STATES) {
    const row = codexRow(diagnosis(overall), "2026-08-03T12:00:00.000Z");
    if (overall === "connected") {
      assert.equal(row.good, true);
      assert.match(row.state, /^Connected/);
    } else {
      assert.notEqual(row.good, true, `${overall} must not render as a working pipeline`);
      assert.doesNotMatch(row.state, /^Connected\b/, `${overall} must not claim to be connected`);
    }
  }
});

test("needs_repair offers Repair, not Install", () => {
  // Repair rewrites definitions Codex may already have approved, and costs an
  // approval to do. Calling it Install would hide that.
  const row = codexRow(diagnosis("needs_repair", { staleEvents: ["Stop"], diagnostics: ["Hook definitions for Stop don't match."] }));
  assert.equal(row.action?.label, "Repair");
  assert.match(row.detail ?? "", /don't match/);
});

test("needs_install offers Install and nothing about approval yet", () => {
  const row = codexRow(diagnosis("needs_install"));
  assert.equal(row.action?.label, "Install");
  assert.equal(row.command, undefined);
});

test("needs_review offers /hooks to copy rather than a button that can't help", () => {
  const row = codexRow(diagnosis("needs_review"));
  assert.equal(row.command, "/hooks");
  assert.equal(row.action, undefined, "there is no button we can press on the user's behalf");
  assert.match(row.detail ?? "", /approve/i);
});

test("waiting_for_verification tells the user what actually resolves it", () => {
  const row = codexRow(diagnosis("waiting_for_verification"));
  assert.match(row.detail ?? "", /Codex session|prompt/);
  assert.equal(row.action, undefined);
});

test("stale explains the fallback rather than going quiet", () => {
  const row = codexRow(diagnosis("stale", { diagnostics: ["No Codex events recently. Falling back to the heuristic."] }));
  assert.match(`${row.state} ${row.detail}`, /heuristic|recently/);
});

test("config_error names the file, since fixing it is a manual job", () => {
  const row = codexRow(diagnosis("config_error", { diagnostics: ["Could not parse it as JSON."] }));
  assert.match(row.detail ?? "", /\/Users\/someone\/\.codex\/hooks\.json/);
  assert.equal(row.action, undefined, "we must not offer to write to a file we cannot read");
});

test("disabled carries the server's specific reason", () => {
  const row = codexRow(
    diagnosis("disabled", { diagnostics: ["Codex has hooks turned off: `[features] hooks = false`."] })
  );
  assert.match(row.detail ?? "", /\[features\] hooks = false/);
  assert.equal(row.action, undefined);
});

test("connected shows when it was last verified, not just that it is", () => {
  const row = codexRow(diagnosis("connected"), new Date(Date.now() - 5 * 60_000).toISOString());
  assert.match(row.state, /5m ago/);
});

test("actionable states are exactly the ones with something to do", () => {
  for (const overall of ALL_STATES) {
    const row = codexRow(diagnosis(overall));
    const hasSomethingToDo = row.action !== undefined || row.command !== undefined;
    if (hasSomethingToDo) {
      assert.ok(ACTIONABLE_CODEX_STATES.has(overall), `${overall} offers an action but is not actionable`);
    }
  }
  // The two with no button but a real problem to fix by hand.
  assert.ok(ACTIONABLE_CODEX_STATES.has("config_error"));
  assert.ok(ACTIONABLE_CODEX_STATES.has("disabled"));
  // And the three the user cannot help with.
  for (const quiet of ["not_detected", "connected", "stale"] as const) {
    assert.equal(ACTIONABLE_CODEX_STATES.has(quiet), false, `${quiet} must not keep onboarding on screen`);
  }
});

test("Claude's row never claims connected without a live event", () => {
  assert.equal(claudeRow({ dirExists: false, installed: false, live: false }).state, "Not detected on this Mac.");
  assert.equal(claudeRow({ dirExists: true, installed: false, live: false }).action?.label, "Install");

  const installed = claudeRow({ dirExists: true, installed: true, live: false });
  assert.notEqual(installed.good, true);
  assert.match(installed.state, /waiting/i);

  const live = claudeRow({
    dirExists: true,
    installed: true,
    live: true,
    lastEventAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(live.good, true);
  assert.match(live.state, /Connected/);
});
