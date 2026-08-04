import type { CodexHooksDiagnosis, CodexHooksOverall, HookLiveness } from "@shared/types.js";
import {
  CODEX_HOOK_EVENTS,
  entryIsCurrent,
  entryIsOurs,
  readCodexHooksConfig,
  type CodexHooksConfig,
} from "./codexHooks.js";

/**
 * One honest answer about the Codex hook pipeline, derived in one place.
 *
 * The API used to expose `installed`, `trusted` and `live` as three independent
 * booleans and leave the panel to combine them. They could contradict each
 * other, and the panel's ordering decided which contradiction won — which is
 * how a stale install rendered as "Connected — events are arriving".
 *
 * `inspectCodexHooks` is pure: every input (paths, file contents, the clock's
 * verdict via `liveness`) is injected, so every state below is reachable in a
 * test without a real ~/.codex, a real Codex, or a real wait.
 */

/** Inputs gathered by the caller, so this module reads nothing itself. */
export interface CodexHooksInspection {
  /** False when Codex isn't on this machine at all. */
  codexDirExists: boolean;
  codexHome: string;
  hooksPath: string;
  /** Where the forwarder is installed — shown in diagnostics, not inspected. */
  forwarderPath: string;
  /** The canonical command an entry must carry to count as current. */
  command: string;
  events?: readonly string[];
  /** Already qualified by install id and forwarder revision — see hookLiveness.ts. */
  liveness: HookLiveness;
  /** Raw `$CODEX_HOME/config.toml`, when it exists. Undefined = no file. */
  configToml?: string;
  /** Offline-spool backlog, surfaced so a growing queue is visible rather than silent. */
  spool?: { pending: number; quarantined: number };
}

/**
 * Ways a Codex config can switch hooks off wholesale.
 *
 * Worth detecting because every other diagnosis we could give would be a lie:
 * the entries are installed, they may even be approved, and they will still
 * never run. Told nothing, the user would follow "run /hooks" forever.
 *
 * Deliberately conservative — a line-oriented scan that ignores comments and
 * only fires on an exact `key = value` match. A false positive here tells
 * someone their working setup is broken, which is worse than staying quiet.
 */
export function hooksDisabledBy(configToml: string | undefined): string | undefined {
  if (!configToml) return undefined;
  let section = "";
  for (const rawLine of configToml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(true|false)\b/.exec(line);
    if (!assignment) continue;
    const [, key, value] = assignment;
    if (section === "features" && key === "hooks" && value === "false") {
      return "Codex has hooks turned off: `[features] hooks = false` in config.toml.";
    }
    if (key === "codex_hooks" && value === "false") {
      return "Codex has hooks turned off: the deprecated `codex_hooks = false` in config.toml.";
    }
    if (key === "allow_managed_hooks_only" && value === "true") {
      return "Codex is configured to run only managed hooks (`allow_managed_hooks_only = true`), so hooks installed for your user never run.";
    }
  }
  return undefined;
}

interface EventState {
  missing: string[];
  stale: string[];
  duplicated: string[];
}

function classifyEvents(
  config: CodexHooksConfig,
  events: readonly string[],
  command: string
): EventState {
  const state: EventState = { missing: [], stale: [], duplicated: [] };
  for (const event of events) {
    const ours = (config.hooks?.[event] ?? []).flatMap((group) =>
      (group.hooks ?? []).filter(entryIsOurs)
    );
    if (ours.length === 0) {
      state.missing.push(event);
      continue;
    }
    const current = ours.filter((entry) => entryIsCurrent(entry, command, event));
    if (current.length === 0) state.stale.push(event);
    else if (ours.length > 1) state.duplicated.push(event);
  }
  return state;
}

/**
 * What `trusted_hash` suggests about approval — a hint, never a verdict.
 *
 * Named for what it is. On approval, current Codex stamps a `trusted_hash`
 * into each approved hook group inside hooks.json. (Older builds used a
 * separate `~/.codex/hooks.state` file keyed to a whole-file hash; current
 * builds never write it, which is why testing for that file said "approved" on
 * machines where nothing fired.) Neither location is a documented public
 * contract, so this can only ever inform `inspectCodexHooks` — a real event
 * outranks it, and its absence is a prompt to run `/hooks`, not proof of
 * anything.
 *
 * `unknown` when we have no current group to look at; otherwise `approved`
 * only if EVERY group of ours carries a non-empty hash. A false "approved"
 * hides a dead pipeline while a false "needs review" costs a few seconds, so
 * ties break toward needs-review.
 */
export function readCodexApprovalHint(
  config: CodexHooksConfig,
  events: readonly string[],
  command: string
): CodexHooksDiagnosis["approval"] {
  const groups = events.flatMap((event) =>
    (config.hooks?.[event] ?? []).filter((group) =>
      (group.hooks ?? []).some((entry) => entryIsOurs(entry) && entryIsCurrent(entry, command, event))
    )
  );
  if (groups.length === 0) return "unknown";
  return groups.every((group) => typeof group.trusted_hash === "string" && group.trusted_hash.length > 0)
    ? "approved"
    : "needs-review";
}

export function inspectCodexHooks(input: CodexHooksInspection): CodexHooksDiagnosis {
  const events = input.events ?? CODEX_HOOK_EVENTS;
  const diagnostics: string[] = [];
  const base = {
    codexHome: input.codexHome,
    hooksPath: input.hooksPath,
    forwarderPath: input.forwarderPath,
    missingEvents: [] as string[],
    staleEvents: [] as string[],
    duplicatedEvents: [] as string[],
    approval: "unknown" as CodexHooksDiagnosis["approval"],
    ...(input.liveness.lastEventAt ? { lastEventAt: input.liveness.lastEventAt } : {}),
    ...(input.spool ? { spool: input.spool } : {}),
  };

  if (!input.codexDirExists) {
    return { ...base, overall: "not_detected", diagnostics: [] };
  }

  let config: CodexHooksConfig;
  try {
    config = readCodexHooksConfig(input.hooksPath);
  } catch (err) {
    return {
      ...base,
      overall: "config_error",
      diagnostics: [(err as Error).message],
    };
  }

  // Checked before anything about our own entries: when hooks are switched off
  // globally, "install these hooks" is the wrong instruction no matter what
  // hooks.json says.
  const disabled = hooksDisabledBy(input.configToml);
  if (disabled) {
    return { ...base, overall: "disabled", diagnostics: [disabled] };
  }

  const { missing, stale, duplicated } = classifyEvents(config, events, input.command);
  const approval = readCodexApprovalHint(config, events, input.command);
  const withEvents = {
    ...base,
    missingEvents: missing,
    staleEvents: stale,
    duplicatedEvents: duplicated,
    approval,
  };

  if (stale.length > 0 || duplicated.length > 0) {
    if (stale.length > 0) {
      diagnostics.push(
        `Hook definitions for ${stale.join(", ")} don't match what this version installs — most likely they point at a copy of the app that has moved.`
      );
    }
    if (duplicated.length > 0) {
      diagnostics.push(`Duplicate central-brain entries for ${duplicated.join(", ")}.`);
    }
    if (missing.length > 0) diagnostics.push(`No entry at all for ${missing.join(", ")}.`);
    diagnostics.push("Repairing rewrites those definitions, so Codex will ask you to approve them again.");
    return { ...withEvents, overall: "needs_repair", diagnostics };
  }

  if (missing.length === events.length) {
    return { ...withEvents, overall: "needs_install", diagnostics };
  }
  if (missing.length > 0) {
    diagnostics.push(`No entry for ${missing.join(", ")} — some events are wired up and some aren't.`);
    return { ...withEvents, overall: "needs_repair", diagnostics };
  }

  // Config is exactly right from here down, so the remaining question is
  // whether it actually runs — and a real event outranks any approval marker.
  if (input.liveness.live) {
    return { ...withEvents, overall: "connected", diagnostics };
  }

  if (input.liveness.disqualifiedBy === "stale-install") {
    diagnostics.push(
      "The last event came from a previous install, so it can't vouch for this one. Start a Codex session to confirm."
    );
    return { ...withEvents, overall: derive(approval), diagnostics };
  }
  if (input.liveness.disqualifiedBy === "unsupported-forwarder") {
    diagnostics.push(
      "The last event came from an older forwarder than the one installed now. The next event will confirm the current one."
    );
    return { ...withEvents, overall: derive(approval), diagnostics };
  }

  // A previously-verified pipeline that has simply gone quiet is not the same
  // as one that was never verified — and only the first justifies saying the
  // staleness heuristic is quietly covering.
  if (input.liveness.lastEventAt && approval !== "needs-review") {
    diagnostics.push(
      "No Codex events recently. Central Brain is falling back to its slower staleness heuristic, which can be wrong."
    );
    return { ...withEvents, overall: "stale", diagnostics };
  }

  return { ...withEvents, overall: derive(approval), diagnostics };
}

/**
 * With the config correct and no proof yet, the approval marker is all we have
 * — and it is a hint, not a verdict. `unknown` (a Codex that doesn't record
 * one) is treated as needing review rather than as approved: being sent to
 * `/hooks` unnecessarily costs a few seconds, while a false "waiting" leaves
 * someone watching a pipeline that was never switched on.
 */
function derive(approval: CodexHooksDiagnosis["approval"]): CodexHooksOverall {
  return approval === "approved" ? "waiting_for_verification" : "needs_review";
}
