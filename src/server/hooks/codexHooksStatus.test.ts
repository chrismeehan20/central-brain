import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexHooksOverall, HookLiveness } from "@shared/types.js";
import { hooksDisabledBy, inspectCodexHooks } from "./codexHooksStatus.js";
import { CODEX_HOOK_EVENTS, CODEX_STATUS_MESSAGE, desiredCodexEntry } from "./codexHooks.js";

/**
 * The whole point of a pure inspector: every state below is reached with a
 * temp file and a plain object, so there is no state we can only find out
 * about from a real machine — which is how "Connected while nothing arrives"
 * survived as long as it did.
 */
const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const COMMAND = "/bin/sh '/data/hooks/notify-codex.sh'";
const EVENTS = CODEX_HOOK_EVENTS;

function hooksFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-codex-status-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "hooks.json");
  fs.writeFileSync(file, contents);
  return file;
}

/** A hooks.json with the canonical definition for every event. */
function currentConfig(opts: { approved?: boolean } = {}): string {
  const hooks: Record<string, unknown[]> = {};
  for (const event of EVENTS) {
    hooks[event] = [
      {
        hooks: [desiredCodexEntry(COMMAND, event)],
        ...(opts.approved ? { trusted_hash: `hash-${event}` } : {}),
      },
    ];
  }
  return JSON.stringify({ hooks }, null, 2);
}

const NEVER: HookLiveness = { tool: "codex", live: false, windowMs: 1000 };
const LIVE: HookLiveness = {
  tool: "codex",
  live: true,
  windowMs: 1000,
  lastEventAt: "2026-08-03T12:00:00.000Z",
};
const QUIET: HookLiveness = {
  tool: "codex",
  live: false,
  windowMs: 1000,
  lastEventAt: "2026-07-01T12:00:00.000Z",
};

function inspect(
  hooksPath: string,
  liveness: HookLiveness = NEVER,
  extra: { configToml?: string; codexDirExists?: boolean } = {}
) {
  return inspectCodexHooks({
    codexDirExists: extra.codexDirExists ?? true,
    codexHome: path.dirname(hooksPath),
    hooksPath,
    forwarderPath: "/data/hooks/notify-codex.sh",
    command: COMMAND,
    liveness,
    ...(extra.configToml !== undefined ? { configToml: extra.configToml } : {}),
  });
}

function overallOf(hooksPath: string, liveness?: HookLiveness, extra?: Parameters<typeof inspect>[2]): CodexHooksOverall {
  return inspect(hooksPath, liveness, extra).overall;
}

test("no Codex on this machine is not_detected, with nothing to say about it", () => {
  const diagnosis = inspect(hooksFile(""), NEVER, { codexDirExists: false });
  assert.equal(diagnosis.overall, "not_detected");
  assert.deepEqual(diagnosis.diagnostics, []);
});

test("an unparseable hooks.json is config_error, carrying the reason", () => {
  const diagnosis = inspect(hooksFile("{ not json"));
  assert.equal(diagnosis.overall, "config_error");
  assert.match(diagnosis.diagnostics[0], /Could not parse/);
  assert.match(diagnosis.diagnostics[0], /hooks\.json/);
});

test("an empty or missing hooks.json is needs_install", () => {
  assert.equal(overallOf(hooksFile("")), "needs_install");
  assert.equal(overallOf(hooksFile("{}")), "needs_install");
});

test("a stale definition is needs_repair, and says a repair costs re-approval", () => {
  const stale = JSON.stringify({
    hooks: Object.fromEntries(
      EVENTS.map((event) => [
        event,
        [{ hooks: [{ ...desiredCodexEntry(COMMAND, event), command: 'sh "/old/notify-codex.sh"' }] }],
      ])
    ),
  });
  const diagnosis = inspect(hooksFile(stale));

  assert.equal(diagnosis.overall, "needs_repair");
  assert.deepEqual(diagnosis.staleEvents, [...EVENTS]);
  assert.deepEqual(diagnosis.missingEvents, []);
  assert.match(diagnosis.diagnostics.join(" "), /moved/);
  assert.match(diagnosis.diagnostics.join(" "), /approve them again/);
});

test("a half-installed config is needs_repair, not needs_install", () => {
  const config = JSON.parse(currentConfig()) as { hooks: Record<string, unknown> };
  delete config.hooks.SessionEnd;
  const diagnosis = inspect(hooksFile(JSON.stringify(config)));

  assert.equal(diagnosis.overall, "needs_repair");
  assert.deepEqual(diagnosis.missingEvents, ["SessionEnd"]);
});

test("duplicate entries of ours are needs_repair", () => {
  const config = JSON.parse(currentConfig()) as { hooks: Record<string, unknown[]> };
  config.hooks.Stop.push({ hooks: [desiredCodexEntry(COMMAND, "Stop")] });
  const diagnosis = inspect(hooksFile(JSON.stringify(config)));

  assert.equal(diagnosis.overall, "needs_repair");
  assert.deepEqual(diagnosis.duplicatedEvents, ["Stop"]);
});

test("correct but unapproved is needs_review", () => {
  const diagnosis = inspect(hooksFile(currentConfig()));
  assert.equal(diagnosis.overall, "needs_review");
  assert.equal(diagnosis.approval, "needs-review");
});

test("correct and apparently approved, with no event yet, is waiting_for_verification", () => {
  const diagnosis = inspect(hooksFile(currentConfig({ approved: true })));
  assert.equal(diagnosis.overall, "waiting_for_verification");
  assert.equal(diagnosis.approval, "approved");
});

test("a live event is connected, and outranks a missing approval marker", () => {
  // The marker's location is current-Codex behaviour, not a contract; a real
  // event is stronger evidence than its absence is counter-evidence.
  const diagnosis = inspect(hooksFile(currentConfig()), LIVE);
  assert.equal(diagnosis.overall, "connected");
  assert.equal(diagnosis.approval, "needs-review");
  assert.equal(diagnosis.lastEventAt, LIVE.lastEventAt);
});

test("an approval marker alone never reads as connected", () => {
  assert.notEqual(overallOf(hooksFile(currentConfig({ approved: true }))), "connected");
});

test("a live event cannot rescue a missing or stale config", () => {
  // The regression this whole queue exists for: liveness must never outvote a
  // configuration that cannot run.
  assert.equal(overallOf(hooksFile("{}"), LIVE), "needs_install");

  const stale = JSON.stringify({
    hooks: Object.fromEntries(
      EVENTS.map((e) => [e, [{ hooks: [{ ...desiredCodexEntry(COMMAND, e), command: "sh /old.sh" }] }]])
    ),
  });
  assert.equal(overallOf(hooksFile(stale), LIVE), "needs_repair");
});

test("a verified pipeline gone quiet is stale, and says the heuristic is covering", () => {
  const diagnosis = inspect(hooksFile(currentConfig({ approved: true })), QUIET);
  assert.equal(diagnosis.overall, "stale");
  assert.match(diagnosis.diagnostics.join(" "), /heuristic/);
});

test("quiet but never approved is needs_review rather than stale", () => {
  // "Falling back to the heuristic" implies it worked once. Without an
  // approval marker we have no reason to believe it ever did.
  assert.equal(overallOf(hooksFile(currentConfig()), QUIET), "needs_review");
});

test("an event from a previous install does not read as connected", () => {
  const disqualified: HookLiveness = {
    tool: "codex",
    live: false,
    windowMs: 1000,
    lastEventAt: "2026-08-03T12:00:00.000Z",
    disqualifiedBy: "stale-install",
  };

  const approved = inspect(hooksFile(currentConfig({ approved: true })), disqualified);
  assert.equal(approved.overall, "waiting_for_verification");
  assert.match(approved.diagnostics.join(" "), /previous install/);

  assert.equal(overallOf(hooksFile(currentConfig()), disqualified), "needs_review");
});

test("an event from an older forwarder does not read as connected", () => {
  const diagnosis = inspect(hooksFile(currentConfig({ approved: true })), {
    tool: "codex",
    live: false,
    windowMs: 1000,
    lastEventAt: "2026-08-03T12:00:00.000Z",
    disqualifiedBy: "unsupported-forwarder",
  });
  assert.equal(diagnosis.overall, "waiting_for_verification");
  assert.match(diagnosis.diagnostics.join(" "), /older forwarder/);
});

test("hooks switched off in config.toml beats every other diagnosis", () => {
  // Otherwise a perfectly installed, perfectly approved config would be told
  // to run /hooks forever, and running it would change nothing.
  const file = hooksFile(currentConfig({ approved: true }));
  const diagnosis = inspect(file, NEVER, { configToml: "[features]\nhooks = false\n" });

  assert.equal(diagnosis.overall, "disabled");
  assert.match(diagnosis.diagnostics[0], /turned off/);
});

test("a config error is reported even before checking whether hooks are disabled", () => {
  // A file we cannot read is the more actionable problem, and reading a
  // disabled flag out of a broken setup would be guessing.
  assert.equal(
    overallOf(hooksFile("{ not json"), NEVER, { configToml: "[features]\nhooks = false\n" }),
    "config_error"
  );
});

test("hooksDisabledBy fires only on real, uncommented switches", () => {
  assert.ok(hooksDisabledBy("[features]\nhooks = false"));
  assert.ok(hooksDisabledBy("[features]\n  hooks   =   false   # off for now"));
  assert.ok(hooksDisabledBy("codex_hooks = false"));
  assert.ok(hooksDisabledBy("allow_managed_hooks_only = true"));

  // A false positive tells someone their working setup is broken, so every one
  // of these has to stay quiet.
  assert.equal(hooksDisabledBy(undefined), undefined);
  assert.equal(hooksDisabledBy(""), undefined);
  assert.equal(hooksDisabledBy("[features]\nhooks = true"), undefined);
  assert.equal(hooksDisabledBy("# [features]\n# hooks = false"), undefined);
  assert.equal(hooksDisabledBy("[other]\nhooks = false"), undefined, "hooks=false outside [features]");
  assert.equal(hooksDisabledBy("[features]\nhooks_enabled = false"), undefined, "a different key");
  assert.equal(hooksDisabledBy('[features]\nhooks = "false"'), undefined, "a string, not the boolean");
  assert.equal(hooksDisabledBy("allow_managed_hooks_only = false"), undefined);
});

test("paths and event names are reported for the panel to show", () => {
  const file = hooksFile(currentConfig());
  const diagnosis = inspect(file);

  assert.equal(diagnosis.hooksPath, file);
  assert.equal(diagnosis.codexHome, path.dirname(file));
  assert.equal(diagnosis.forwarderPath, "/data/hooks/notify-codex.sh");
});

test("a foreign handler alone is needs_install, not needs_repair", () => {
  const foreign = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "node /other/tool.js", statusMessage: "Someone else" }] }],
    },
  });
  const diagnosis = inspect(hooksFile(foreign));

  assert.equal(diagnosis.overall, "needs_install");
  assert.deepEqual(diagnosis.staleEvents, []);
  assert.deepEqual(diagnosis.missingEvents, [...EVENTS]);
});

test("our own status message on an otherwise foreign entry still counts as ours", () => {
  const config = JSON.parse(currentConfig()) as { hooks: Record<string, unknown[]> };
  config.hooks.Stop = [
    { hooks: [{ type: "command", command: "sh /somewhere-else.sh", statusMessage: CODEX_STATUS_MESSAGE }] },
  ];
  assert.deepEqual(inspect(hooksFile(JSON.stringify(config))).staleEvents, ["Stop"]);
});
