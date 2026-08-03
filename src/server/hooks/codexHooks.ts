import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexForwarderPath, installCodexForwarder, shellQuote } from "./forwarder.js";

/**
 * Install/uninstall logic for Codex's ~/.codex/hooks.json, factored out of the
 * bin/ scripts so it can be driven against a temp fixture in tests.
 *
 * Codex's hook config is a separate file from Claude's settings.json and only
 * supports `{"type": "command", ...}` handlers — there is no native "http"
 * type — so we install a command that curls the event JSON to the server.
 *
 * Append-only, by rule: a real machine already has other people's handlers in
 * here (Better Peacock's, for one), and Codex's hook trust is keyed to a hash
 * of this whole file. Rewriting or reordering someone else's handler would be
 * both a data loss and a silent revocation of their trust approval.
 */

/**
 * Codex fires these with the same field names Claude uses. SessionStart /
 * UserPromptSubmit / SessionEnd clear a session's flags, PermissionRequest
 * raises a high-priority one, Stop / SubagentStop clear silently.
 */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

/**
 * Our ownership marker, and the reason uninstall can be surgical. Written into
 * `statusMessage` — a field Codex already understands — rather than a custom
 * key Codex might reject.
 */
export const CODEX_STATUS_MESSAGE = "central-brain: forwarding Codex hook event";

/** Codex's own hook timeout field, in seconds. Matches the 10s other handlers use. */
const HOOK_TIMEOUT_SECONDS = 10;

/**
 * Codex clamps SessionEnd handlers to 3s regardless of what the entry
 * declares — teardown has a hard budget. Declare the real number rather than
 * one Codex will silently ignore.
 */
const SESSION_END_TIMEOUT_SECONDS = 3;

export interface CodexHookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
}

export interface CodexHookGroup {
  hooks?: CodexHookEntry[];
  [key: string]: unknown;
}

export interface CodexHooksConfig {
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

/** `$CODEX_HOME/hooks.json`, falling back to `~/.codex/hooks.json`. */
export function codexHooksPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const codexHome = env.CODEX_HOME?.trim();
  return path.join(codexHome && codexHome.length > 0 ? codexHome : path.join(home, ".codex"), "hooks.json");
}

/**
 * Absolute path to the *installed* forwarder — inside the data dir, not inside
 * the checkout or the `.app`. See forwarder.ts: this is the one path that
 * survives moving and upgrading the app, which is what makes the hook
 * definition (and therefore the user's Codex approval of it) survive too.
 */
export function codexNotifyScriptPath(): string {
  return codexForwarderPath();
}

export function buildCodexHookCommand(notifyScript: string = codexNotifyScriptPath()): string {
  // `/bin/sh` rather than `sh`: the hook runs with whatever PATH Codex hands
  // it, and single quotes rather than double so a home directory containing
  // `$`, a backtick or a quote can't rewrite the command.
  return `/bin/sh ${shellQuote(notifyScript)}`;
}

function buildEntry(command: string, event?: string): CodexHookEntry {
  return {
    type: "command",
    command,
    timeout: event === "SessionEnd" ? SESSION_END_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS,
    statusMessage: CODEX_STATUS_MESSAGE,
  };
}

/**
 * Ours if it carries our status message, or runs our forwarder script. The
 * second test catches entries written by an older install (or a moved repo)
 * whose statusMessage differs; neither test can match a foreign handler.
 */
export function entryIsOurs(entry: CodexHookEntry): boolean {
  if (entry.statusMessage === CODEX_STATUS_MESSAGE) return true;
  return typeof entry.command === "string" && entry.command.includes("notify-codex.sh");
}

function groupContainsOurs(group: CodexHookGroup): boolean {
  return group?.hooks?.some(entryIsOurs) ?? false;
}

export class CodexHooksConfigError extends Error {}

/** True when every event we care about already has one of our entries. */
export function codexHooksInstalled(hooksPath: string, events: readonly string[] = CODEX_HOOK_EVENTS): boolean {
  let config: CodexHooksConfig;
  try {
    config = readCodexHooksConfig(hooksPath);
  } catch {
    return false; // unparseable file = not installed; install surfaces the real error
  }
  if (!config.hooks) return false;
  return events.every((event) => (config.hooks?.[event] ?? []).some(groupContainsOurs));
}

/**
 * Whether OUR handlers are actually trusted, read the way current Codex
 * records it: on approval, Codex stamps a `trusted_hash` into each approved
 * hook GROUP inside hooks.json itself. (Older builds used a separate
 * ~/.codex/hooks.state file keyed to a whole-file hash; current builds never
 * write it, which is why testing for that file said "approved" on machines
 * where nothing fires — or nagged forever with the wrong instructions.)
 *
 * True only when every event we handle has at least one of our groups AND
 * every group of ours carries a non-empty trusted_hash. An untrusted verdict
 * is recoverable — approving inside Codex fixes it and liveness then proves
 * it — while a false "trusted" hides a dead pipeline, so ties break toward
 * false.
 */
export function codexHooksTrusted(hooksPath: string, events: readonly string[] = CODEX_HOOK_EVENTS): boolean {
  let config: CodexHooksConfig;
  try {
    config = readCodexHooksConfig(hooksPath);
  } catch {
    return false;
  }
  if (!config.hooks) return false;
  return events.every((event) => {
    const ourGroups = (config.hooks?.[event] ?? []).filter(groupContainsOurs);
    if (ourGroups.length === 0) return false;
    return ourGroups.every(
      (group) => typeof group.trusted_hash === "string" && group.trusted_hash.length > 0
    );
  });
}

/**
 * Read and validate the config. Anything we can't confidently understand is an
 * error, not something to overwrite: this file may hold handlers we didn't
 * write, and clobbering them is unrecoverable.
 */
export function readCodexHooksConfig(hooksPath: string): CodexHooksConfig {
  if (!fs.existsSync(hooksPath)) return {};

  const raw = fs.readFileSync(hooksPath, "utf8");
  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CodexHooksConfigError(
      `Could not parse ${hooksPath} as JSON — aborting so we don't corrupt your existing Codex hooks.\n` +
        `  ${(err as Error).message}\n` +
        `Fix or move that file, then re-run.`
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CodexHooksConfigError(
      `${hooksPath} is not a JSON object — aborting rather than replacing it.`
    );
  }

  const config = parsed as CodexHooksConfig;
  if (config.hooks !== undefined) {
    if (config.hooks === null || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
      throw new CodexHooksConfigError(
        `${hooksPath} has a "hooks" key that is not an object — aborting rather than replacing it.`
      );
    }
    for (const [event, groups] of Object.entries(config.hooks)) {
      if (!Array.isArray(groups)) {
        throw new CodexHooksConfigError(
          `${hooksPath}: hooks.${event} is not an array — aborting rather than replacing it.`
        );
      }
    }
  }
  return config;
}

function backup(hooksPath: string, log: Logger): string | undefined {
  if (!fs.existsSync(hooksPath)) return undefined;
  const backupPath = `${hooksPath}.bak`;
  fs.copyFileSync(hooksPath, backupPath);
  log(`Backed up existing Codex hooks to ${backupPath}`);
  return backupPath;
}

function write(hooksPath: string, config: CodexHooksConfig): void {
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
}

export type Logger = (message: string) => void;

export interface CodexHooksOptions {
  hooksPath: string;
  command?: string;
  events?: readonly string[];
  log?: Logger;
}

export interface InstallResult {
  added: string[];
  alreadyPresent: string[];
  wrote: boolean;
  backupPath?: string;
}

export function installCodexHooks(opts: CodexHooksOptions): InstallResult {
  const { hooksPath } = opts;
  // Put the forwarder in place *before* naming it in hooks.json. Writing a
  // definition whose script does not exist yet would spend the user's one
  // interactive approval on a command that can only fail.
  const command = opts.command ?? buildCodexHookCommand(installCodexForwarder().path);
  const events = opts.events ?? CODEX_HOOK_EVENTS;
  const log = opts.log ?? console.log;

  const config = readCodexHooksConfig(hooksPath);
  config.hooks ??= {};

  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const event of events) {
    const groups = (config.hooks[event] ??= []);
    if (groups.some(groupContainsOurs)) {
      alreadyPresent.push(event); // idempotent no-op
      continue;
    }
    // Appended as its own group, so it never touches handlers we don't own
    // and can be removed again independently.
    groups.push({ hooks: [buildEntry(command, event)] });
    added.push(event);
  }

  if (added.length === 0) {
    log(`central-brain Codex hooks are already installed in ${hooksPath} — nothing to do.`);
    logTrustNotice(log, hooksPath);
    return { added, alreadyPresent, wrote: false };
  }

  const backupPath = backup(hooksPath, log);
  write(hooksPath, config);
  log(`Installed central-brain Codex hooks in ${hooksPath} for: ${added.join(", ")}`);
  if (alreadyPresent.length > 0) {
    log(`Already present (left alone): ${alreadyPresent.join(", ")}`);
  }
  log("Your existing Codex hooks were preserved — we only appended new entries.");
  logTrustNotice(log, hooksPath);
  return { added, alreadyPresent, wrote: true, ...(backupPath ? { backupPath } : {}) };
}

export interface UninstallResult {
  removed: number;
  wrote: boolean;
  backupPath?: string;
}

export function uninstallCodexHooks(opts: Omit<CodexHooksOptions, "command" | "events">): UninstallResult {
  const { hooksPath } = opts;
  const log = opts.log ?? console.log;

  if (!fs.existsSync(hooksPath)) {
    log(`No ${hooksPath} found — nothing to uninstall.`);
    return { removed: 0, wrote: false };
  }

  const config = readCodexHooksConfig(hooksPath);
  if (!config.hooks) {
    log("No Codex hooks configured — nothing to uninstall.");
    return { removed: 0, wrote: false };
  }

  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const groups = config.hooks[event];
    const kept: CodexHookGroup[] = [];
    let removedHere = 0;
    for (const group of groups) {
      if (!groupContainsOurs(group)) {
        kept.push(group); // foreign group — untouched, including its key order
        continue;
      }
      // Filter entry-by-entry rather than dropping the group, in case someone
      // hand-merged one of our entries into a group of their own.
      const hooks = (group.hooks ?? []).filter((entry) => {
        if (!entryIsOurs(entry)) return true;
        removedHere++;
        return false;
      });
      if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    removed += removedHere;
    // An event key we emptied was one install created, so drop it and leave the
    // file as we found it. An event key that was already empty isn't ours to
    // tidy, so it stays.
    if (removedHere > 0 && kept.length === 0) delete config.hooks[event];
    else config.hooks[event] = kept;
  }

  if (removed === 0) {
    log("No central-brain Codex hooks found — nothing to uninstall.");
    return { removed: 0, wrote: false };
  }

  const backupPath = backup(hooksPath, log);
  write(hooksPath, config);
  log(`Removed ${removed} central-brain Codex hook entr${removed === 1 ? "y" : "ies"}. Your other Codex hooks were left untouched.`);
  log("Codex re-prompts for hook approval on the next session, because the config hash changed.");
  return { removed, wrote: true, ...(backupPath ? { backupPath } : {}) };
}

/**
 * The part that must not be skipped. Codex hooks silently do nothing until the
 * user approves them once, interactively, and approval is keyed to a hash of
 * the hook config — so installing these invalidates any approval already
 * granted, for every handler in the file.
 */
function logTrustNotice(log: Logger, hooksPath: string): void {
  log("");
  log("IMPORTANT — these hooks will NOT fire until you approve them inside Codex.");
  log("Codex only runs hook definitions you have explicitly trusted:");
  log("  1. Start a new Codex session (`codex`) — it should ask you to review the new hooks.");
  log("  2. Approve them.");
  log(`  3. Confirm it took:  grep trusted_hash ${hooksPath}`);
  log("     Codex stamps a trusted_hash into each approved hook group; every");
  log("     central-brain group carrying one is the sign it worked.");
  log("");
  log("Trust is per hook definition, so our new entries start untrusted even if");
  log("you approved other hooks before. Until you approve them, they run silently");
  log("never, and Codex does not warn you about it.");
  log("");
  log("Until then, central-brain keeps falling back to its Codex staleness");
  log("heuristic, which guesses from rollout-file activity and can be wrong.");
}
