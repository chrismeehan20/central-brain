import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveNotifyScript } from "../appPaths.js";

/**
 * Install/uninstall logic for Claude Code's ~/.claude/settings.json, factored
 * out of the bin/ scripts so the dashboard can drive it too — a Releases user
 * has no checkout to run `npm run install-hooks` from, so the app has to be
 * able to do this itself.
 *
 * Same append-only rule as codexHooks.ts: settings.json holds hooks we did not
 * write (the user's own terminal-notifier setup, other tools'), and we only
 * ever add our own group per event or remove exactly our own entries.
 */

export const CLAUDE_HOOK_EVENTS = [
  "Notification",
  "PermissionRequest",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
] as const;

export interface ClaudeHookEntry {
  type?: string;
  url?: string;
  command?: string;
  [key: string]: unknown;
}

export interface ClaudeHookGroup {
  matcher?: string;
  hooks?: ClaudeHookEntry[];
  [key: string]: unknown;
}

export interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

export function claudeSettingsPath(home: string = os.homedir()): string {
  return path.join(home, ".claude", "settings.json");
}

/**
 * Where our hook entries POST to. Uses the server's actual port so an install
 * done from an app running on CENTRAL_BRAIN_PORT points at itself, not 4317.
 */
export function defaultHookUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CENTRAL_BRAIN_HOOK_URL?.trim();
  if (explicit) return explicit;
  const port = env.PORT?.trim() || "4317";
  return `http://127.0.0.1:${port}/api/hook`;
}

/** Absolute path to hooks/notify.sh — resolved by appPaths so a bundled server can be told where it is. */
export function claudeNotifyScriptPath(): string {
  return resolveNotifyScript({ name: "notify.sh" });
}

/**
 * Ours if it is an http hook pointing at a local /api/hook, or a command hook
 * running our forwarder script. The URL test is deliberately port-agnostic:
 * an entry installed under a custom CENTRAL_BRAIN_PORT (or by an older
 * checkout) must still be recognized as ours, or reinstalling would stack a
 * duplicate for every event.
 */
export function claudeEntryIsOurs(entry: ClaudeHookEntry): boolean {
  if (entry.type === "http" && typeof entry.url === "string") {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/hook$/.test(entry.url);
  }
  return entry.type === "command" && typeof entry.command === "string" && entry.command.includes("notify.sh");
}

function groupContainsOurs(group: ClaudeHookGroup): boolean {
  return group?.hooks?.some(claudeEntryIsOurs) ?? false;
}

export class ClaudeHooksConfigError extends Error {}

/**
 * Read and validate settings.json. Anything we can't confidently understand is
 * an error, not something to overwrite — this file holds the user's whole
 * Claude Code configuration, not just hooks.
 */
export function readClaudeSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) return {};

  const raw = fs.readFileSync(settingsPath, "utf8");
  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ClaudeHooksConfigError(
      `Could not parse ${settingsPath} as JSON — aborting so we don't corrupt your Claude Code settings.\n` +
        `  ${(err as Error).message}\n` +
        `Fix or move that file, then re-run.`
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClaudeHooksConfigError(`${settingsPath} is not a JSON object — aborting rather than replacing it.`);
  }

  const settings = parsed as ClaudeSettings;
  if (settings.hooks !== undefined) {
    if (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
      throw new ClaudeHooksConfigError(
        `${settingsPath} has a "hooks" key that is not an object — aborting rather than replacing it.`
      );
    }
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) {
        throw new ClaudeHooksConfigError(
          `${settingsPath}: hooks.${event} is not an array — aborting rather than replacing it.`
        );
      }
    }
  }
  return settings;
}

export type Logger = (message: string) => void;

function backup(settingsPath: string, log: Logger): string | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  const backupPath = `${settingsPath}.bak`;
  fs.copyFileSync(settingsPath, backupPath);
  log(`Backed up existing settings to ${backupPath}`);
  return backupPath;
}

function write(settingsPath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

export interface ClaudeHooksOptions {
  settingsPath: string;
  /** "http" (native, default) or "command" for Claude Code versions without http hooks. */
  mode?: "http" | "command";
  hookUrl?: string;
  notifyScript?: string;
  events?: readonly string[];
  log?: Logger;
}

export interface InstallResult {
  added: string[];
  alreadyPresent: string[];
  wrote: boolean;
  backupPath?: string;
}

export function installClaudeHooks(opts: ClaudeHooksOptions): InstallResult {
  const { settingsPath } = opts;
  const mode = opts.mode ?? (process.env.CENTRAL_BRAIN_HOOK_MODE === "command" ? "command" : "http");
  const events = opts.events ?? CLAUDE_HOOK_EVENTS;
  const log = opts.log ?? console.log;

  const entry: ClaudeHookEntry =
    mode === "command"
      ? { type: "command", command: `sh "${opts.notifyScript ?? claudeNotifyScriptPath()}"` }
      : { type: "http", url: opts.hookUrl ?? defaultHookUrl() };

  const settings = readClaudeSettings(settingsPath);
  settings.hooks ??= {};

  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const event of events) {
    const groups = (settings.hooks[event] ??= []);
    if (groups.some(groupContainsOurs)) {
      alreadyPresent.push(event); // idempotent no-op
      continue;
    }
    // Appended as its own group so it never touches hooks we don't own and
    // can be removed again independently.
    groups.push({ matcher: "", hooks: [entry] });
    added.push(event);
  }

  if (added.length === 0) {
    log("central-brain hooks are already installed — nothing to do.");
    return { added, alreadyPresent, wrote: false };
  }

  const backupPath = backup(settingsPath, log);
  write(settingsPath, settings);
  log(`Installed central-brain hooks for: ${added.join(", ")}`);
  log("Your existing hooks were preserved — we only appended new entries.");
  return { added, alreadyPresent, wrote: true, ...(backupPath ? { backupPath } : {}) };
}

export interface UninstallResult {
  removed: number;
  wrote: boolean;
  backupPath?: string;
}

export function uninstallClaudeHooks(opts: Pick<ClaudeHooksOptions, "settingsPath" | "log">): UninstallResult {
  const { settingsPath } = opts;
  const log = opts.log ?? console.log;

  if (!fs.existsSync(settingsPath)) {
    log("No settings.json found — nothing to uninstall.");
    return { removed: 0, wrote: false };
  }

  const settings = readClaudeSettings(settingsPath);
  if (!settings.hooks) {
    log("No hooks configured — nothing to uninstall.");
    return { removed: 0, wrote: false };
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    const kept: ClaudeHookGroup[] = [];
    let removedHere = 0;
    for (const group of groups) {
      if (!groupContainsOurs(group)) {
        kept.push(group); // foreign group — untouched
        continue;
      }
      // Filter entry-by-entry in case someone hand-merged one of our entries
      // into a group of their own.
      const hooks = (group.hooks ?? []).filter((entry) => {
        if (!claudeEntryIsOurs(entry)) return true;
        removedHere++;
        return false;
      });
      if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    removed += removedHere;
    // Only prune an event key install created; an already-empty key isn't ours.
    if (removedHere > 0 && kept.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = kept;
  }

  if (removed === 0) {
    log("No central-brain hooks found — nothing to uninstall.");
    return { removed: 0, wrote: false };
  }

  const backupPath = backup(settingsPath, log);
  write(settingsPath, settings);
  log(`Removed ${removed} central-brain hook entr${removed === 1 ? "y" : "ies"}. Your other hooks were left untouched.`);
  return { removed, wrote: true, ...(backupPath ? { backupPath } : {}) };
}

/** True when every event we care about already has one of our entries. */
export function claudeHooksInstalled(settingsPath: string, events: readonly string[] = CLAUDE_HOOK_EVENTS): boolean {
  let settings: ClaudeSettings;
  try {
    settings = readClaudeSettings(settingsPath);
  } catch {
    return false; // unparseable file = not installed, and install will surface the real error
  }
  if (!settings.hooks) return false;
  return events.every((event) => (settings.hooks?.[event] ?? []).some(groupContainsOurs));
}
