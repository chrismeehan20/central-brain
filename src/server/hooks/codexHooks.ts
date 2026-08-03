import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexForwarderPath, installCodexForwarder, rotateInstallId, shellQuote } from "./forwarder.js";

/**
 * Install/uninstall logic for Codex's ~/.codex/hooks.json, factored out of the
 * bin/ scripts so it can be driven against a temp fixture in tests.
 *
 * Codex's hook config is a separate file from Claude's settings.json and only
 * supports `{"type": "command", ...}` handlers — there is no native "http"
 * type — so we install a command that curls the event JSON to the server.
 *
 * We only ever touch our OWN entries, by rule: a real machine already has
 * other people's handlers in here (Better Peacock's, for one). Codex keys hook
 * trust to each exact hook definition — not, as this comment previously
 * claimed, to a hash of the whole file — so rewriting or reordering someone
 * else's handler would be a data loss AND a silent revocation of an approval
 * that had nothing to do with us. Conversely, changing one of ours revokes
 * only ours, which is why repair is safe to offer.
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

/**
 * The canonical definition — the single source of truth for what an installed
 * central-brain hook looks like. "Installed correctly" means an entry that
 * deep-equals this, not merely an entry that mentions our script: an entry
 * naming a checkout that has since moved runs nothing at all, and treating it
 * as installed is what made repair impossible.
 */
export function desiredCodexEntry(command: string, event?: string): CodexHookEntry {
  return {
    type: "command",
    command,
    timeout: event === "SessionEnd" ? SESSION_END_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS,
    statusMessage: CODEX_STATUS_MESSAGE,
  };
}

/**
 * Whether an owned entry already IS the canonical definition.
 *
 * Compared field by field rather than by JSON string, so key order in the
 * user's file is irrelevant, and exhaustively rather than on `command` alone,
 * so an entry with a stale timeout or a missing status message is repaired
 * too. An entry carrying extra keys we don't write is NOT current — we would
 * rather rewrite (and cost one re-approval) than leave a definition we cannot
 * fully account for.
 */
export function entryIsCurrent(entry: CodexHookEntry, command: string, event?: string): boolean {
  const desired = desiredCodexEntry(command, event);
  const keys = Object.keys(entry);
  if (keys.length !== Object.keys(desired).length) return false;
  return keys.every((key) => entry[key] === desired[key as keyof CodexHookEntry]);
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

/**
 * Read and validate the config. Anything we can't confidently understand is an
 * error, not something to overwrite: this file may hold handlers we didn't
 * write, and clobbering them is unrecoverable.
 */
export function readCodexHooksConfig(hooksPath: string): CodexHooksConfig {
  return loadCodexHooks(hooksPath).config;
}

interface LoadedCodexHooks {
  config: CodexHooksConfig;
  /** The exact bytes parsed — what a backup must capture. Undefined when there is no file. */
  raw: string | undefined;
  /** The stat taken alongside the read, for the pre-rename conflict check. */
  stat: fs.Stats | undefined;
}

/**
 * Read the config together with the evidence needed to write it back safely:
 * the bytes it came from and the stat it had at the time.
 */
function loadCodexHooks(hooksPath: string): LoadedCodexHooks {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(hooksPath);
  } catch {
    return { config: {}, raw: undefined, stat: undefined };
  }

  const raw = fs.readFileSync(hooksPath, "utf8");
  if (raw.trim() === "") return { config: {}, raw, stat };

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
  return { config, raw, stat };
}

/** How many timestamped backups of hooks.json we keep before pruning the oldest. */
const BACKUPS_KEPT = 5;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Raised when the file changed underneath us twice — the user's edit wins, we stop. */
export class CodexHooksConflictError extends Error {}

/**
 * Snapshot the file we are about to rewrite.
 *
 * Timestamped, because the old single `.bak` was overwritten on every install:
 * a second run destroyed the only copy of the pre-install state, which is
 * exactly the copy someone reaches for. `raw` is the bytes we actually parsed,
 * so a backup can never capture a concurrent edit we didn't reconcile against.
 */
function backup(hooksPath: string, raw: string, log: Logger): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Two writes inside the same millisecond would otherwise land on the same
  // name and the second would clobber the first — the very bug timestamping is
  // here to fix, just with a narrower window. The counter is always present and
  // zero-padded so that every name has one shape and sorting them lexically
  // sorts them chronologically; `pruneBackups` relies on that to drop the
  // OLDEST, and a variable-length suffix would have had it dropping whichever
  // sorted first. `wx` fails rather than overwrites.
  let backupPath = "";
  for (let n = 0; ; n++) {
    backupPath = `${hooksPath}.${stamp}-${String(n).padStart(2, "0")}.bak`;
    try {
      fs.writeFileSync(backupPath, raw, { mode: 0o600, flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  log(`Backed up existing Codex hooks to ${backupPath}`);
  pruneBackups(hooksPath, log);
  return backupPath;
}

function pruneBackups(hooksPath: string, log: Logger): void {
  const dir = path.dirname(hooksPath);
  // Matches only the names we generate. A hand-made `hooks.json.before-x.bak`
  // is someone's deliberate safety copy and is not ours to delete.
  // The trailing `-NN` is `backup()`'s same-millisecond counter; it is always
  // present, which is what makes a lexical sort chronological.
  const ours = new RegExp(
    `^${escapeRegExp(path.basename(hooksPath))}\\.\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z-\\d{2}\\.bak$`
  );
  let stale: string[];
  try {
    stale = fs
      .readdirSync(dir)
      .filter((name) => ours.test(name))
      .sort() // ISO timestamps sort chronologically as strings
      .slice(0, -BACKUPS_KEPT);
  } catch {
    return; // pruning is housekeeping — never fail an install over it
  }
  for (const name of stale) {
    try {
      fs.rmSync(path.join(dir, name));
    } catch {
      log(`Could not remove the old backup ${name} — harmless, but it will accumulate.`);
    }
  }
}

/**
 * Write via a same-directory temp file and an atomic rename, refusing if the
 * original changed since we read it.
 *
 * A plain `writeFileSync` is a truncate-then-write: a crash, a full disk, or
 * two writers at once leaves hooks.json half-written, which Codex then cannot
 * parse — and an unparseable hooks.json disables every hook in it, including
 * handlers we don't own. `expected` is the stat we took at read time; a
 * mismatch means someone edited the file (or `/hooks` stamped a trusted_hash
 * into it) while we were deciding, so our reconciliation is stale.
 */
function writeConfig(hooksPath: string, config: CodexHooksConfig, expected: fs.Stats | undefined): void {
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const contents = JSON.stringify(config, null, 2) + "\n";
  // Match the file we're replacing, so a user who tightened permissions on
  // hooks.json doesn't silently get them loosened back.
  const mode = expected ? expected.mode & 0o777 : 0o600;
  const tmp = path.join(path.dirname(hooksPath), `.${path.basename(hooksPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, contents, { mode });
  try {
    if (!statMatches(hooksPath, expected)) {
      throw new CodexHooksConflictError(
        `${hooksPath} changed while central-brain was updating it — nothing was written.`
      );
    }
    fs.renameSync(tmp, hooksPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** True when the file on disk still looks like the one we read. */
function statMatches(hooksPath: string, expected: fs.Stats | undefined): boolean {
  let current: fs.Stats | undefined;
  try {
    current = fs.statSync(hooksPath);
  } catch {
    current = undefined;
  }
  if (!expected || !current) return !expected && !current;
  return current.mtimeMs === expected.mtimeMs && current.size === expected.size;
}

export type Logger = (message: string) => void;

export interface CodexHooksOptions {
  hooksPath: string;
  command?: string;
  events?: readonly string[];
  log?: Logger;
  /**
   * Where the install id lives. Defaults to the resolved data dir; tests pass
   * a temp dir so rotating one never touches the developer's real install.
   */
  dataDir?: string;
}

export interface InstallResult {
  /** Events that had no entry of ours at all. */
  added: string[];
  /** Events already carrying the exact canonical definition — untouched, approval intact. */
  alreadyPresent: string[];
  /** Events whose entry of ours was stale (moved path, old format) and was rewritten. */
  updated: string[];
  /** Events where duplicate entries of ours collapsed to one. */
  deduplicated: string[];
  wrote: boolean;
  /**
   * True when a definition changed, so Codex's approval of it no longer
   * applies. The user must re-approve via `/hooks` before hooks fire again —
   * the single most important thing to tell them after a repair.
   */
  requiresReapproval: boolean;
  backupPath?: string;
}

/** What reconciliation decided to do about one event, before anything is written. */
type EventPlan = "unchanged" | "added" | "updated" | "deduplicated";

/**
 * Decide, without writing, what each event needs — and mutate `config` into the
 * desired state.
 *
 * The rule for leaving a file alone is deliberately strict: an event is
 * `unchanged` only when exactly one group holds exactly one entry of ours and
 * that entry deep-equals the canonical definition. That group keeps every key
 * it had, including the `trusted_hash` Codex stamps on approval — the whole
 * point of not rewriting it.
 *
 * Anything else is rebuilt: our entries are stripped from wherever they are
 * (including out of a group someone hand-merged them into, whose foreign
 * entries and approval are left untouched) and one canonical group is appended.
 */
function planEvent(config: CodexHooksConfig, event: string, command: string): EventPlan {
  const groups = config.hooks?.[event] ?? [];
  const ourEntries = groups.flatMap((group) => (group.hooks ?? []).filter(entryIsOurs));

  if (ourEntries.length === 0) {
    (config.hooks ??= {})[event] ??= [];
    config.hooks[event].push({ hooks: [desiredCodexEntry(command, event)] });
    return "added";
  }

  const owningGroups = groups.filter(groupContainsOurs);
  const soleGroup = owningGroups.length === 1 ? owningGroups[0] : undefined;
  const isCanonical =
    ourEntries.length === 1 &&
    soleGroup !== undefined &&
    (soleGroup.hooks ?? []).length === 1 &&
    entryIsCurrent(ourEntries[0], command, event);
  if (isCanonical) return "unchanged";

  // Was any of what we're replacing already correct? That distinguishes "your
  // install was stale and got repaired" from "you had duplicates".
  const hadCurrent = ourEntries.some((entry) => entryIsCurrent(entry, command, event));

  const kept: CodexHookGroup[] = [];
  for (const group of groups) {
    if (!groupContainsOurs(group)) {
      kept.push(group); // foreign group — untouched, key order and all
      continue;
    }
    const foreign = (group.hooks ?? []).filter((entry) => !entryIsOurs(entry));
    // A group that also holds someone else's handler keeps it — and keeps its
    // trusted_hash, which covers their definition as much as ours.
    if (foreign.length > 0) kept.push({ ...group, hooks: foreign });
  }
  kept.push({ hooks: [desiredCodexEntry(command, event)] });
  (config.hooks ??= {})[event] = kept;

  return hadCurrent ? "deduplicated" : "updated";
}

/**
 * Converge $CODEX_HOME/hooks.json on the canonical definition.
 *
 * Previously this was append-only and treated *any* entry mentioning our
 * script as an idempotent success. That made the common failure unrecoverable:
 * once an entry pointed at a checkout that had moved or an `.app` that had
 * been replaced, the hook ran nothing, the dashboard reported "installed", the
 * Install button disappeared, and re-running install wrote nothing. The only
 * way out was hand-editing hooks.json.
 */
export function installCodexHooks(opts: CodexHooksOptions): InstallResult {
  const { hooksPath } = opts;
  // Put the forwarder in place *before* naming it in hooks.json. Writing a
  // definition whose script does not exist yet would spend the user's one
  // interactive approval on a command that can only fail.
  const command = opts.command ?? buildCodexHookCommand(installCodexForwarder().path);
  const events = opts.events ?? CODEX_HOOK_EVENTS;
  const log = opts.log ?? console.log;

  // One retry, because the likeliest concurrent writer is Codex itself
  // stamping a trusted_hash — a change we want to reconcile against, not
  // clobber. A second conflict means someone is actively editing; stop.
  for (let attempt = 0; ; attempt++) {
    const { config, raw, stat } = loadCodexHooks(hooksPath);

    const plans = new Map<EventPlan, string[]>([
      ["unchanged", []],
      ["added", []],
      ["updated", []],
      ["deduplicated", []],
    ]);
    for (const event of events) plans.get(planEvent(config, event, command))!.push(event);

    const added = plans.get("added")!;
    const updated = plans.get("updated")!;
    const deduplicated = plans.get("deduplicated")!;
    const alreadyPresent = plans.get("unchanged")!;
    const wrote = added.length + updated.length + deduplicated.length > 0;

    if (!wrote) {
      log(`central-brain Codex hooks are already current in ${hooksPath} — nothing to do.`);
      logTrustNotice(log, hooksPath, false);
      return { added, alreadyPresent, updated, deduplicated, wrote: false, requiresReapproval: false };
    }

    // Backing up before the conflict check would litter the directory on every
    // failed attempt, so both happen inside the retry.
    let backupPath: string | undefined;
    try {
      if (raw !== undefined) backupPath = backup(hooksPath, raw, log);
      writeConfig(hooksPath, config, stat);
    } catch (err) {
      if (err instanceof CodexHooksConflictError && attempt === 0) continue;
      throw err;
    }

    // The definitions changed, so every receipt collected under the old ones
    // stops counting. Without this, a repair would inherit "Connected" from
    // events the previous, broken wiring produced — and the user would never
    // learn that the repair still needs approving.
    rotateInstallId({ ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });

    if (added.length > 0) log(`Installed central-brain Codex hooks for: ${added.join(", ")}`);
    if (updated.length > 0) {
      log(`Repaired stale central-brain hook definitions for: ${updated.join(", ")}`);
      log("  (they pointed somewhere that no longer exists, so Codex was running nothing.)");
    }
    if (deduplicated.length > 0) {
      log(`Collapsed duplicate central-brain entries for: ${deduplicated.join(", ")}`);
    }
    if (alreadyPresent.length > 0) log(`Already current (left alone): ${alreadyPresent.join(", ")}`);
    log("Your existing Codex hooks were preserved — only our own entries were touched.");
    logTrustNotice(log, hooksPath, updated.length > 0 || deduplicated.length > 0);
    return {
      added,
      alreadyPresent,
      updated,
      deduplicated,
      wrote: true,
      requiresReapproval: true,
      ...(backupPath ? { backupPath } : {}),
    };
  }
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

  const { config, raw, stat } = loadCodexHooks(hooksPath);
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

  const backupPath = raw !== undefined ? backup(hooksPath, raw, log) : undefined;
  writeConfig(hooksPath, config, stat);
  // Nothing can fire any more, so no past event may keep vouching for the
  // pipeline — this is what stops the dashboard reading "Connected" for days
  // after an uninstall.
  rotateInstallId({ ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
  log(`Removed ${removed} central-brain Codex hook entr${removed === 1 ? "y" : "ies"}. Your other Codex hooks were left untouched.`);
  log("Your other hooks keep their approval: Codex trusts each hook definition");
  log("separately, and none of theirs changed.");
  return { removed, wrote: true, ...(backupPath ? { backupPath } : {}) };
}

/**
 * The part that must not be skipped. Codex hooks silently do nothing until the
 * user approves them once, interactively, and approval is keyed to the exact
 * hook definition — so a definition we just wrote or rewrote starts untrusted,
 * while every OTHER handler in the file keeps the approval it already had.
 */
function logTrustNotice(log: Logger, hooksPath: string, repaired: boolean): void {
  log("");
  if (repaired) {
    log("IMPORTANT — repairing these hooks changed their definitions, so Codex's");
    log("previous approval of them no longer applies. They will not fire until you");
    log("approve them again:");
  } else {
    log("IMPORTANT — these hooks will NOT fire until you approve them inside Codex.");
    log("Codex only runs hook definitions you have explicitly trusted:");
  }
  log("  1. Start a new Codex session (`codex`) and run `/hooks`.");
  log("  2. Review and approve the central-brain entries.");
  log(`  3. Confirm it took:  grep trusted_hash ${hooksPath}`);
  log("     Codex stamps a trusted_hash into each approved hook group; every");
  log("     central-brain group carrying one is the sign it worked.");
  log("");
  log("Trust is per hook definition, so ours start untrusted even if you approved");
  log("other hooks before — and, equally, hooks you did not change keep working.");
  log("Until you approve ours, they run silently never, and Codex does not warn you.");
  log("");
  log("Until then, central-brain keeps falling back to its Codex staleness");
  log("heuristic, which guesses from rollout-file activity and can be wrong.");
}
