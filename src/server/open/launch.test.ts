import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttentionItem, Project, SessionRef } from "@shared/types.js";
import {
  CHAT_DEEP_LINK_DELAY_MS,
  buildTerminalResume,
  escapeAppleScript,
  resolveOpenAction,
  shellQuote,
  type ResolveDeps,
} from "./launch.js";

const PROJECT_PATH = "/Users/someone/code/widget";

function makeSession(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    tool: "claude",
    sessionId: "abc-123",
    lastActivity: "2026-07-30T12:00:00.000Z",
    entrypoint: "claude-vscode",
    transcriptPath: "/Users/someone/.claude/projects/x/abc-123.jsonl",
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    path: PROJECT_PATH,
    displayName: "widget",
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    sessions: [],
    markdown: [],
    ...overrides,
  };
}

function makeAttention(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "abc-123:permission",
    sessionId: "abc-123",
    projectPath: PROJECT_PATH,
    tool: "claude",
    type: "permission",
    priority: "high",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
/** Transcript last written an hour ago — comfortably not live. */
const coldDeps: ResolveDeps = { now: NOW, statMtimeMs: () => NOW - 60 * 60 * 1000 };

function resolve(
  project: Project,
  body: unknown,
  attention: AttentionItem[] = [],
  deps = coldDeps
) {
  return resolveOpenAction([project], attention, body, deps);
}

// ---- v1 project-open semantics (unchanged) ----

test("a missing or non-string projectPath is a 400", () => {
  for (const body of [undefined, null, {}, { projectPath: 42 }, { projectPath: "" }]) {
    const res = resolve(makeProject(), body);
    assert.ok("error" in res);
    assert.equal(res.error.status, 400);
  }
});

test("a path the scanner does not know about is a 404 — arbitrary paths never resolve", () => {
  const res = resolve(makeProject(), { projectPath: "/etc" });
  assert.ok("error" in res);
  assert.equal(res.error.status, 404);
});

test("a project whose folder is gone from disk is a 409", () => {
  const res = resolve(makeProject({ missing: true }), { projectPath: PROJECT_PATH });
  assert.ok("error" in res);
  assert.equal(res.error.status, 409);
});

test("a known project without a sessionId opens the folder in VS Code", () => {
  const res = resolve(makeProject(), { projectPath: PROJECT_PATH });
  assert.ok(!("error" in res));
  assert.equal(res.kind, "project");
  assert.deepEqual(res.steps, [
    { cmd: "open", args: ["-a", "Visual Studio Code", PROJECT_PATH] },
  ]);
});

// ---- session routing ----

test("a claude-vscode session routes to the two-step VS Code chat open, folder first", () => {
  const project = makeProject({ sessions: [makeSession()] });
  const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc-123" });
  assert.ok(!("error" in res));
  assert.equal(res.kind, "vscode-chat");
  assert.equal(res.delayMsBetween, CHAT_DEEP_LINK_DELAY_MS);
  assert.equal(res.steps.length, 2);
  assert.deepEqual(res.steps[0], { cmd: "open", args: ["-a", "Visual Studio Code", PROJECT_PATH] });
  assert.deepEqual(res.steps[1], {
    cmd: "open",
    args: ["vscode://anthropic.claude-code/open?session=abc-123"],
  });
});

test("cli and claude-desktop sessions route to a Terminal resume", () => {
  for (const entrypoint of ["cli", "claude-desktop"]) {
    const project = makeProject({ sessions: [makeSession({ entrypoint })] });
    const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc-123" });
    assert.ok(!("error" in res), entrypoint);
    assert.equal(res.kind, "terminal-resume");
    assert.equal(res.steps[0].cmd, "osascript");
  }
});

test("a claude session with no recorded entrypoint defaults to the VS Code chat route", () => {
  const project = makeProject({ sessions: [makeSession({ entrypoint: undefined })] });
  const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc-123" });
  assert.ok(!("error" in res));
  assert.equal(res.kind, "vscode-chat");
});

test("a codex session opens the project and carries the explanatory note", () => {
  const project = makeProject({ sessions: [makeSession({ tool: "codex", entrypoint: "vscode" })] });
  const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc-123" });
  assert.ok(!("error" in res));
  assert.equal(res.kind, "project");
  assert.match(res.note ?? "", /Codex doesn't support reopening a specific chat yet/);
});

test("a sessionId the project does not contain is a 404", () => {
  const project = makeProject({ sessions: [makeSession()] });
  const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "nope" });
  assert.ok("error" in res);
  assert.equal(res.error.status, 404);
});

test("a sessionId with shell-hostile characters is a 400 before any lookup", () => {
  const project = makeProject({ sessions: [makeSession()] });
  const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc; rm -rf /" });
  assert.ok("error" in res);
  assert.equal(res.error.status, 400);
});

// ---- liveness + transcript guards ----

test("a claude session without a transcript on disk is a 409", () => {
  for (const session of [
    makeSession({ transcriptPath: undefined }),
    makeSession(), // transcriptPath set, but stat says the file is gone
  ]) {
    const project = makeProject({ sessions: [session] });
    const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc-123" }, [], {
      now: NOW,
      statMtimeMs: () => null,
    });
    assert.ok("error" in res);
    assert.equal(res.error.status, 409);
  }
});

test("a transcript written 1 minute ago blocks resume; 3 minutes ago allows it", () => {
  const project = makeProject({ sessions: [makeSession()] });
  const body = { projectPath: PROJECT_PATH, sessionId: "abc-123" };

  const live = resolve(project, body, [], { now: NOW, statMtimeMs: () => NOW - 60 * 1000 });
  assert.ok("error" in live);
  assert.equal(live.error.status, 409);
  assert.match(live.error.message, /looks live/);

  const cold = resolve(project, body, [], { now: NOW, statMtimeMs: () => NOW - 3 * 60 * 1000 });
  assert.ok(!("error" in cold));
});

test("an active attention item flips a vscode session to the focus deep link instead of a 409", () => {
  const project = makeProject({ sessions: [makeSession()] });
  // Live transcript AND an attention item: the deep link only focuses, so allow it.
  const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc-123" }, [makeAttention()], {
    now: NOW,
    statMtimeMs: () => NOW,
  });
  assert.ok(!("error" in res));
  assert.equal(res.kind, "vscode-chat");
});

test("an active attention item on a cli session opens the project — a terminal can't be focused", () => {
  const project = makeProject({ sessions: [makeSession({ entrypoint: "cli" })] });
  const res = resolve(project, { projectPath: PROJECT_PATH, sessionId: "abc-123" }, [makeAttention()], {
    now: NOW,
    statMtimeMs: () => NOW,
  });
  assert.ok(!("error" in res));
  assert.equal(res.kind, "project");
});

test("a 'done' attention item does not count as live", () => {
  const project = makeProject({ sessions: [makeSession()] });
  const res = resolve(
    project,
    { projectPath: PROJECT_PATH, sessionId: "abc-123" },
    [makeAttention({ type: "done", priority: "none" })],
    coldDeps
  );
  assert.ok(!("error" in res));
  // Not attention-flipped: this is the normal resume route.
  assert.equal(res.kind, "vscode-chat");
});

// ---- quoting / escaping ----

test("shellQuote survives spaces and single quotes", () => {
  assert.equal(shellQuote("/Users/o'brien/my code"), `'/Users/o'\\''brien/my code'`);
});

test("escapeAppleScript escapes backslashes and double quotes", () => {
  assert.equal(escapeAppleScript('say "hi" \\ bye'), 'say \\"hi\\" \\\\ bye');
});

test("buildTerminalResume quotes the cwd and embeds the resume command", () => {
  const cmd = buildTerminalResume("/Users/o'brien/my code", "abc-123");
  assert.equal(cmd.cmd, "osascript");
  const doScript = cmd.args[3];
  assert.match(doScript, /do script "/);
  assert.ok(doScript.includes(`claude --resume 'abc-123'`));
  // shellQuote's '\'' escape, with its backslash doubled again for AppleScript.
  assert.ok(doScript.includes(`cd '/Users/o'\\\\''brien/my code'`));
});
