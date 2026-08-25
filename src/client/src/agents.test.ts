import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttentionItem, Project, SessionRef } from "@shared/types";
import {
  ACTIVE_AGENT_WINDOW_MS,
  ROSTER_WINDOW_MS,
  fleetCounts,
  fleetRows,
  projectAgentStatus,
} from "./agents";

const NOW = Date.parse("2026-08-21T12:00:00Z");

function session(partial: Partial<SessionRef> & { sessionId: string }): SessionRef {
  return {
    tool: "claude",
    lastActivity: new Date(NOW - 60_000).toISOString(),
    ...partial,
  };
}

function project(partial: Partial<Project> & { path: string }): Project {
  return {
    displayName: partial.path.split("/").pop() ?? partial.path,
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    sessions: [],
    markdown: [],
    ...partial,
  };
}

function attention(partial: Partial<AttentionItem> & { sessionId: string }): AttentionItem {
  return {
    id: `${partial.sessionId}:waiting`,
    projectPath: "/repo",
    tool: "claude",
    type: "waiting",
    priority: "medium",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...partial,
  };
}

test("fleetRows classifies waiting > active > idle and sorts that order", () => {
  const projects = [
    project({
      path: "/repo",
      sessions: [
        session({ sessionId: "idle", lastActivity: new Date(NOW - ACTIVE_AGENT_WINDOW_MS - 1000).toISOString() }),
        session({ sessionId: "active" }),
        session({ sessionId: "stuck" }),
      ],
    }),
  ];
  const rows = fleetRows(projects, [attention({ sessionId: "stuck", message: "Needs OK" })], NOW);
  assert.deepEqual(rows.map((r) => r.sessionId), ["stuck", "active", "idle"]);
  assert.deepEqual(rows.map((r) => r.status), ["waiting", "active", "idle"]);
  assert.equal(rows[0].waitingOn, "Needs OK");
});

test("fleetRows drops sessions past the roster window unless they are waiting", () => {
  const old = new Date(NOW - ROSTER_WINDOW_MS - 1000).toISOString();
  const projects = [
    project({
      path: "/repo",
      sessions: [session({ sessionId: "gone", lastActivity: old }), session({ sessionId: "blockedOld", lastActivity: old })],
    }),
  ];
  const rows = fleetRows(projects, [attention({ sessionId: "blockedOld" })], NOW);
  assert.deepEqual(rows.map((r) => r.sessionId), ["blockedOld"]);
});

test("fleetRows skips hidden projects and honours snoozes", () => {
  const projects = [
    project({ path: "/hidden", hidden: true, sessions: [session({ sessionId: "h" })] }),
    project({ path: "/repo", sessions: [session({ sessionId: "snoozed" })] }),
  ];
  const rows = fleetRows(
    projects,
    [attention({ sessionId: "snoozed", snoozedUntil: new Date(NOW + 60_000).toISOString() })],
    NOW,
  );
  // The snoozed session is still listed — as active, not waiting.
  assert.deepEqual(rows.map((r) => [r.sessionId, r.status]), [["snoozed", "active"]]);
});

test("fleetRows prefers a permission item over a waiting item for the same session", () => {
  const projects = [project({ path: "/repo", sessions: [session({ sessionId: "s" })] })];
  const rows = fleetRows(
    projects,
    [
      attention({ sessionId: "s", type: "waiting", message: "idle" }),
      attention({ sessionId: "s", id: "s:permission", type: "permission", message: "Wants to run: Bash" }),
    ],
    NOW,
  );
  assert.equal(rows[0].waitingOn, "Wants to run: Bash");
});

test("projectAgentStatus reports the worst status for the project, or undefined", () => {
  const projects = [
    project({ path: "/a", sessions: [session({ sessionId: "a1" })] }),
    project({
      path: "/b",
      sessions: [session({ sessionId: "b1", lastActivity: new Date(NOW - ACTIVE_AGENT_WINDOW_MS - 1000).toISOString() })],
    }),
  ];
  const rows = fleetRows(projects, [], NOW);
  assert.equal(projectAgentStatus("/a", rows), "active");
  assert.equal(projectAgentStatus("/b", rows), "idle");
  assert.equal(projectAgentStatus("/c", rows), undefined);
});

test("fleetCounts counts sessions, not projects", () => {
  const projects = [
    project({ path: "/a", sessions: [session({ sessionId: "a1" }), session({ sessionId: "a2" })] }),
  ];
  const counts = fleetCounts(fleetRows(projects, [attention({ sessionId: "a1", projectPath: "/a" })], NOW));
  assert.deepEqual(counts, { waiting: 1, active: 1 });
});
