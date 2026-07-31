import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { AttentionItem, Project } from "@shared/types.js";

const execFileAsync = promisify(execFile);

/**
 * Pause between opening the project window and firing the chat deep link, so
 * the Claude Code extension has time to activate in a cold window. Too short
 * and the deep link lands before the extension knows the session — the benign
 * failure is a fresh chat panel instead of the resumed one.
 */
export const CHAT_DEEP_LINK_DELAY_MS = 2000;

/** A transcript written to this recently is treated as a live session. */
const LIVE_TRANSCRIPT_WINDOW_MS = 2 * 60 * 1000;

/** Both tools use UUID-ish ids; anything else never reaches a command string. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export interface Cmd {
  cmd: string;
  args: string[];
}

export type OpenKind = "project" | "vscode-chat" | "terminal-resume";

export type OpenAction =
  | { error: { status: number; message: string } }
  | { kind: OpenKind; steps: Cmd[]; delayMsBetween?: number; note?: string };

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function escapeAppleScript(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function buildVsCodeOpen(path: string): Cmd {
  return { cmd: "open", args: ["-a", "Visual Studio Code", path] };
}

export function buildChatDeepLink(sessionId: string): Cmd {
  return { cmd: "open", args: [`vscode://anthropic.claude-code/open?session=${sessionId}`] };
}

export function buildTerminalResume(cwd: string, sessionId: string): Cmd {
  // Plain `claude`: Terminal's login shell has the user's full PATH, which the
  // packaged sidecar's environment does not.
  const shell = `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)}`;
  return {
    cmd: "osascript",
    args: [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script "${escapeAppleScript(shell)}"`,
    ],
  };
}

export interface ResolveDeps {
  now?: number;
  /** mtime in ms, or null when the file is gone. */
  statMtimeMs?: (path: string) => number | null;
}

function defaultStatMtimeMs(path: string): number | null {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

const CODEX_NOTE =
  "Codex doesn't support reopening a specific chat yet — opened the project instead. " +
  "Pick the thread from the Codex panel's history.";

const GONE_TRANSCRIPT =
  "This chat's transcript is no longer on disk, so it can't be reopened.";

const LOOKS_LIVE =
  "This chat looks live right now — use the window where it's running, or the Needs-attention panel.";

function err(status: number, message: string): OpenAction {
  return { error: { status, message } };
}

function vsCodeChat(projectPath: string, sessionId: string): OpenAction {
  return {
    kind: "vscode-chat",
    steps: [buildVsCodeOpen(projectPath), buildChatDeepLink(sessionId)],
    delayMsBetween: CHAT_DEEP_LINK_DELAY_MS,
  };
}

/**
 * The whole routing table as a pure function. The client may only open paths
 * and sessions the scanner already knows about — the cached project/session,
 * never the raw request strings, is what reaches `open`/`osascript`.
 */
export function resolveOpenAction(
  projects: Project[],
  attentionItems: AttentionItem[],
  body: unknown,
  deps: ResolveDeps = {}
): OpenAction {
  const { projectPath, sessionId } = (body ?? {}) as { projectPath?: unknown; sessionId?: unknown };
  if (!projectPath || typeof projectPath !== "string") {
    return err(400, "projectPath is required");
  }
  const project = projects.find((p) => p.path === projectPath);
  if (!project) return err(404, "project not found");
  if (project.missing) return err(409, "This folder no longer exists on disk.");

  if (sessionId === undefined) {
    return { kind: "project", steps: [buildVsCodeOpen(project.path)] };
  }
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) {
    return err(400, "sessionId is invalid");
  }
  const session = project.sessions.find((s) => s.sessionId === sessionId);
  if (!session) return err(404, "session not found in this project");

  if (session.tool === "codex") {
    // No safe mechanism yet: the Codex extension has no session deep link, and
    // codex:// is Desktop-only and unstable. Revisit on openai/codex#21779.
    return { kind: "project", steps: [buildVsCodeOpen(project.path)], note: CODEX_NOTE };
  }

  // A session waiting on the user is live by definition. Resuming a live
  // session interleaves two writers into one transcript, so never resume here —
  // but the VS Code deep link only *focuses* an already-open tab, which is
  // safe. A cli/desktop session lives in a window we can't focus, so those
  // fall back to opening the project.
  const attentionActive = attentionItems.some(
    (i) => i.sessionId === sessionId && i.type !== "done"
  );
  const terminalSurface = session.entrypoint === "cli" || session.entrypoint === "claude-desktop";
  if (attentionActive) {
    if (terminalSurface) {
      return { kind: "project", steps: [buildVsCodeOpen(project.path)] };
    }
    return vsCodeChat(project.path, sessionId);
  }

  if (!session.transcriptPath) return err(409, GONE_TRANSCRIPT);
  const mtime = (deps.statMtimeMs ?? defaultStatMtimeMs)(session.transcriptPath);
  if (mtime === null) return err(409, GONE_TRANSCRIPT);
  if ((deps.now ?? Date.now()) - mtime < LIVE_TRANSCRIPT_WINDOW_MS) {
    return err(409, LOOKS_LIVE);
  }

  if (terminalSurface) {
    return { kind: "terminal-resume", steps: [buildTerminalResume(project.path, sessionId)] };
  }
  // claude-vscode — or unknown entrypoint, where the extension is the right
  // default (it dominates real usage, and the failure mode is a fresh panel).
  return vsCodeChat(project.path, sessionId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launch(
  action: Exclude<OpenAction, { error: unknown }>,
  exec: (cmd: string, args: string[]) => Promise<unknown> = (cmd, args) => execFileAsync(cmd, args)
): Promise<void> {
  for (let i = 0; i < action.steps.length; i++) {
    if (i > 0 && action.delayMsBetween) await sleep(action.delayMsBetween);
    const step = action.steps[i];
    await exec(step.cmd, step.args);
  }
}
