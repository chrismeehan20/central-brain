import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexHooksInstalled,
  codexHooksTrusted,
  CODEX_HOOK_EVENTS,
  CODEX_STATUS_MESSAGE,
  CodexHooksConfigError,
  CodexHooksConflictError,
  codexHooksPath,
  installCodexHooks,
  readCodexHooksConfig,
  uninstallCodexHooks,
  type CodexHookGroup,
  type CodexHooksConfig,
} from "./codexHooks.js";

/**
 * Every test writes to a fresh mkdtemp directory and passes that path in
 * explicitly, so the developer's real ~/.codex/hooks.json is never read,
 * written, backed up, or even resolved.
 */
const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const COMMAND = 'sh "/somewhere/central-brain/hooks/notify-codex.sh"';

/**
 * Install and uninstall rotate the install id, which lives in the data dir.
 * Pointing every call in this file at a throwaway one keeps the developer's
 * real ~/Library/Application Support/central-brain out of the test run.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-codex-hooks-data-"));
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

/**
 * A handler in the exact shape of the Better Peacock entries that are really in
 * ~/.codex/hooks.json — no `matcher` key, with `timeout` and `statusMessage`.
 * These must come out the far side of install + uninstall untouched.
 */
function foreignGroup(): CodexHookGroup {
  return {
    hooks: [
      {
        type: "command",
        command: 'node "/Users/someone/.better-peacock/agent-beacon.cjs" codex',
        timeout: 10,
        statusMessage: "Updating Better Peacock Agent Beacon",
      },
    ],
  };
}

function fixture(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-codex-hooks-test-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "hooks.json");
  fs.writeFileSync(file, contents);
  return file;
}

/** A fixture holding only foreign handlers, on the three events they really use. */
function foreignFixture(): { file: string; original: string } {
  const config: CodexHooksConfig = {
    hooks: {
      UserPromptSubmit: [foreignGroup()],
      PermissionRequest: [foreignGroup()],
      Stop: [foreignGroup()],
    },
  };
  const original = JSON.stringify(config, null, 2) + "\n";
  return { file: fixture(original), original };
}

function read(file: string): CodexHooksConfig {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ourEntries(config: CodexHooksConfig, event: string) {
  return (config.hooks?.[event] ?? [])
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => h.statusMessage === CODEX_STATUS_MESSAGE);
}

function install(file: string) {
  return installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
}

test("installing preserves foreign handlers exactly and appends ours for every event", () => {
  const { file } = foreignFixture();

  const result = install(file);

  assert.deepEqual(result.added, [...CODEX_HOOK_EVENTS]);
  assert.equal(result.wrote, true);
  // Timestamped, so a second install can't destroy the pre-install snapshot.
  assert.match(path.basename(result.backupPath!), /^hooks\.json\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.bak$/);

  const config = read(file);
  for (const event of ["UserPromptSubmit", "PermissionRequest", "Stop"]) {
    const groups = config.hooks![event];
    assert.deepEqual(groups[0], foreignGroup(), `${event}: foreign handler must be byte-for-byte intact`);
    assert.equal(groups.length, 2, `${event}: ours appended after theirs`);
  }
  for (const event of CODEX_HOOK_EVENTS) {
    // SessionEnd declares 3s because that's what Codex actually enforces there.
    const timeout = event === "SessionEnd" ? 3 : 10;
    assert.deepEqual(ourEntries(config, event), [
      { type: "command", command: COMMAND, timeout, statusMessage: CODEX_STATUS_MESSAGE },
    ]);
  }
});

test("installing twice adds no duplicates", () => {
  const { file } = foreignFixture();

  install(file);
  const after = fs.readFileSync(file, "utf8");
  const second = install(file);

  assert.deepEqual(second.added, []);
  assert.deepEqual(second.alreadyPresent, [...CODEX_HOOK_EVENTS]);
  assert.equal(second.wrote, false);
  assert.equal(fs.readFileSync(file, "utf8"), after, "a second install must not rewrite the file at all");

  const config = read(file);
  for (const event of CODEX_HOOK_EVENTS) {
    assert.equal(ourEntries(config, event).length, 1, `${event}: exactly one of our entries`);
  }
});

test("uninstalling removes only our entries and restores the file we found", () => {
  const { file, original } = foreignFixture();

  install(file);
  const result = uninstallCodexHooks({ hooksPath: file, log: () => {}, dataDir: DATA_DIR });

  assert.equal(result.removed, CODEX_HOOK_EVENTS.length);
  assert.equal(result.wrote, true);
  assert.equal(fs.readFileSync(file, "utf8"), original, "install + uninstall must round-trip byte-for-byte");
});

test("uninstalling a config that has no entries of ours changes nothing", () => {
  const { file, original } = foreignFixture();

  const result = uninstallCodexHooks({ hooksPath: file, log: () => {}, dataDir: DATA_DIR });

  assert.equal(result.removed, 0);
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("uninstalling keeps a foreign handler that shares a group with ours", () => {
  const file = fixture(
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                foreignGroup().hooks![0],
                { type: "command", command: COMMAND, timeout: 10, statusMessage: CODEX_STATUS_MESSAGE },
              ],
            },
          ],
        },
      },
      null,
      2
    ) + "\n"
  );

  const result = uninstallCodexHooks({ hooksPath: file, log: () => {}, dataDir: DATA_DIR });

  assert.equal(result.removed, 1);
  assert.deepEqual(read(file).hooks!.Stop, [foreignGroup()]);
});

test("installing aborts without writing when hooks.json is unparseable", () => {
  const broken = '{"hooks": {"Stop": [ }}} not json';
  const file = fixture(broken);

  assert.throws(() => install(file), CodexHooksConfigError);
  assert.equal(fs.readFileSync(file, "utf8"), broken, "the unreadable file must be left exactly as it was");
  assert.equal(fs.existsSync(`${file}.bak`), false, "and no backup should have been taken");
});

test("installing aborts when hooks.json parses but is not the shape we expect", () => {
  const file = fixture('{"hooks": ["Stop"]}');
  assert.throws(() => install(file), CodexHooksConfigError);

  const arrayFile = fixture("[]");
  assert.throws(() => install(arrayFile), CodexHooksConfigError);

  const groupsFile = fixture('{"hooks": {"Stop": {"hooks": []}}}');
  assert.throws(() => install(groupsFile), CodexHooksConfigError);
});

test("installing creates hooks.json when none exists yet, and takes no backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-codex-hooks-test-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "hooks.json");

  const result = install(file);

  assert.equal(result.wrote, true);
  assert.equal(result.backupPath, undefined);
  assert.deepEqual(Object.keys(read(file).hooks!), [...CODEX_HOOK_EVENTS]);
});

test("an empty hooks.json is treated as empty config, not as a parse failure", () => {
  const file = fixture("");
  assert.deepEqual(readCodexHooksConfig(file), {});
  assert.equal(install(file).wrote, true);
});

test("codexHooksPath prefers CODEX_HOME over the home directory", () => {
  assert.equal(
    codexHooksPath({ CODEX_HOME: "/tmp/fake-codex-home" }, "/tmp/fake-home"),
    path.join("/tmp/fake-codex-home", "hooks.json")
  );
  assert.equal(codexHooksPath({}, "/tmp/fake-home"), path.join("/tmp/fake-home", ".codex", "hooks.json"));
  assert.equal(codexHooksPath({ CODEX_HOME: "  " }, "/tmp/fake-home"), path.join("/tmp/fake-home", ".codex", "hooks.json"));
});

// ---- per-group trust detection (round 2, R2) ----

/** Install ours into a fresh fixture, then optionally stamp trusted_hash the way Codex does on approval. */
function installedFixture(stamp: { ours?: boolean; foreign?: boolean } = {}): string {
  const file = fixture(JSON.stringify({ hooks: { UserPromptSubmit: [foreignGroup()] } }));
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as CodexHooksConfig;
  for (const groups of Object.values(config.hooks ?? {})) {
    for (const group of groups) {
      const ours = (group.hooks ?? []).some((h) => h.command === COMMAND);
      if ((ours && stamp.ours) || (!ours && stamp.foreign)) group.trusted_hash = "abc123";
    }
  }
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test("freshly installed hooks are NOT trusted — Codex hasn't stamped them yet", () => {
  assert.equal(codexHooksTrusted(installedFixture()), false);
});

test("hooks are trusted once every group of ours carries Codex's trusted_hash", () => {
  assert.equal(codexHooksTrusted(installedFixture({ ours: true })), true);
});

test("a trusted foreign group proves nothing about ours", () => {
  assert.equal(codexHooksTrusted(installedFixture({ foreign: true })), false);
});

test("one unstamped event among six means not trusted", () => {
  const file = installedFixture({ ours: true });
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as CodexHooksConfig;
  const group = (config.hooks?.SessionEnd ?? []).find((g) =>
    (g.hooks ?? []).some((h) => h.command === COMMAND)
  );
  delete group!.trusted_hash;
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(codexHooksTrusted(file), false);
});

test("missing or unparseable config is never trusted", () => {
  assert.equal(codexHooksTrusted(path.join(os.tmpdir(), "central-brain-nope", "hooks.json")), false);
  assert.equal(codexHooksTrusted(fixture("{ not json")), false);
});

test("install preserves a foreign group's trusted_hash and never stamps our own", () => {
  const file = fixture(
    JSON.stringify({ hooks: { UserPromptSubmit: [{ ...foreignGroup(), trusted_hash: "keepme" }] } })
  );
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as CodexHooksConfig;
  const groups = config.hooks?.UserPromptSubmit ?? [];
  assert.equal(groups[0].trusted_hash, "keepme");
  const ours = groups.find((g) => (g.hooks ?? []).some((h) => h.command === COMMAND));
  assert.equal(ours?.trusted_hash, undefined);
});

test("SessionEnd declares the 3s timeout Codex actually enforces; other events keep 10s", () => {
  const file = fixture("");
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as CodexHooksConfig;
  const timeoutFor = (event: string) =>
    (config.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).find((h) => h.command === COMMAND)
      ?.timeout;
  assert.equal(timeoutFor("SessionEnd"), 3);
  assert.equal(timeoutFor("PermissionRequest"), 10);
});

/**
 * Reconciliation — the behaviour that replaced append-only install.
 *
 * The bug these cover: an entry naming a path that has moved (an app upgrade,
 * a renamed checkout) used to count as installed. Install became a permanent
 * no-op, the dashboard reported "installed", and the only repair was editing
 * hooks.json by hand.
 */

/** hooks.json as an older central-brain wrote it: a path that no longer exists, double-quoted. */
const STALE_COMMAND = 'sh "/Users/someone/old-checkout/central-brain/hooks/notify-codex.sh"';

function staleFixture(command = STALE_COMMAND): string {
  const hooks: Record<string, CodexHookGroup[]> = {};
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command,
            timeout: event === "SessionEnd" ? 3 : 10,
            statusMessage: CODEX_STATUS_MESSAGE,
          },
        ],
        trusted_hash: "approved-for-the-old-definition",
      },
    ];
  }
  return fixture(JSON.stringify({ hooks }, null, 2) + "\n");
}

test("a stale command is repaired, not reported as already installed", () => {
  const file = staleFixture();

  const result = installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });

  assert.deepEqual(result.updated, [...CODEX_HOOK_EVENTS]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.alreadyPresent, []);
  assert.equal(result.wrote, true);
  assert.equal(result.requiresReapproval, true);

  const config = read(file);
  for (const event of CODEX_HOOK_EVENTS) {
    assert.deepEqual(ourEntries(config, event), [
      {
        type: "command",
        command: COMMAND,
        timeout: event === "SessionEnd" ? 3 : 10,
        statusMessage: CODEX_STATUS_MESSAGE,
      },
    ]);
  }
});

test("a repaired definition drops the trusted_hash that approved the old one", () => {
  const file = staleFixture();
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });

  // Leaving the old hash behind would make codexHooksTrusted() report an
  // approval the user never gave for this command.
  const config = read(file);
  for (const event of CODEX_HOOK_EVENTS) {
    const ourGroups = (config.hooks?.[event] ?? []).filter((g) =>
      (g.hooks ?? []).some((h) => h.command === COMMAND)
    );
    assert.equal(ourGroups.length, 1);
    assert.equal(ourGroups[0].trusted_hash, undefined, `${event}: stale approval must not survive`);
  }
  assert.equal(codexHooksTrusted(file), false);
});

test("codexHooksInstalled is false for a stale command and true only for the current one", () => {
  const file = staleFixture();
  assert.equal(codexHooksInstalled(file, CODEX_HOOK_EVENTS, COMMAND), false);

  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
  assert.equal(codexHooksInstalled(file, CODEX_HOOK_EVENTS, COMMAND), true);

  // The same file read against a *different* desired command is stale again —
  // this is what makes "the app moved" visible instead of silent.
  assert.equal(codexHooksInstalled(file, CODEX_HOOK_EVENTS, 'sh "/elsewhere/notify-codex.sh"'), false);
});

test("an entry that differs only by timeout or status message is still repaired", () => {
  for (const drift of [
    { type: "command", command: COMMAND, timeout: 60, statusMessage: CODEX_STATUS_MESSAGE },
    { type: "command", command: COMMAND, timeout: 10 },
    { type: "command", command: COMMAND, timeout: 10, statusMessage: CODEX_STATUS_MESSAGE, extra: 1 },
  ]) {
    const file = fixture(JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [drift] }] } }));
    const result = installCodexHooks({
      hooksPath: file,
      command: COMMAND,
      events: ["PermissionRequest"],
      log: () => {},
      dataDir: DATA_DIR,
    });
    assert.deepEqual(result.updated, ["PermissionRequest"], `drift ${JSON.stringify(drift)}`);
    assert.deepEqual(ourEntries(read(file), "PermissionRequest"), [
      { type: "command", command: COMMAND, timeout: 10, statusMessage: CODEX_STATUS_MESSAGE },
    ]);
  }
});

test("duplicate entries of ours collapse to exactly one, keeping foreign groups", () => {
  const current = {
    type: "command",
    command: COMMAND,
    timeout: 10,
    statusMessage: CODEX_STATUS_MESSAGE,
  };
  const file = fixture(
    JSON.stringify({
      hooks: {
        PermissionRequest: [
          { ...foreignGroup(), trusted_hash: "theirs" },
          { hooks: [current] },
          { hooks: [current] },
          { hooks: [{ ...current, command: STALE_COMMAND }] },
        ],
      },
    })
  );

  const result = installCodexHooks({
    hooksPath: file,
    command: COMMAND,
    events: ["PermissionRequest"],
    log: () => {},
    dataDir: DATA_DIR,
  });

  assert.deepEqual(result.deduplicated, ["PermissionRequest"]);
  const groups = read(file).hooks!.PermissionRequest;
  assert.deepEqual(groups[0], { ...foreignGroup(), trusted_hash: "theirs" });
  assert.equal(groups.length, 2);
  assert.deepEqual(ourEntries(read(file), "PermissionRequest"), [current]);
});

test("one of our entries hand-merged into a foreign group is lifted out, not deleted from theirs", () => {
  const file = fixture(
    JSON.stringify({
      hooks: {
        Stop: [
          {
            trusted_hash: "theirs",
            hooks: [
              foreignGroup().hooks![0],
              { type: "command", command: STALE_COMMAND, statusMessage: CODEX_STATUS_MESSAGE },
            ],
          },
        ],
      },
    })
  );

  installCodexHooks({ hooksPath: file, command: COMMAND, events: ["Stop"], log: () => {}, dataDir: DATA_DIR });

  const groups = read(file).hooks!.Stop;
  // Their handler and their approval survive; ours moves to its own group.
  assert.deepEqual(groups[0].hooks, [foreignGroup().hooks![0]]);
  assert.equal(groups[0].trusted_hash, "theirs");
  assert.deepEqual(groups[1], {
    hooks: [{ type: "command", command: COMMAND, timeout: 10, statusMessage: CODEX_STATUS_MESSAGE }],
  });
});

test("an already-current install is left byte-for-byte alone, approval included", () => {
  const file = fixture("");
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
  // Simulate the user approving in Codex.
  const approved = read(file);
  for (const event of CODEX_HOOK_EVENTS) approved.hooks![event][0].trusted_hash = `hash-${event}`;
  const bytes = JSON.stringify(approved, null, 2) + "\n";
  fs.writeFileSync(file, bytes);

  const result = installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });

  assert.equal(result.wrote, false);
  assert.equal(result.requiresReapproval, false);
  assert.deepEqual(result.alreadyPresent, [...CODEX_HOOK_EVENTS]);
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "an approved, current install must never be rewritten");
});

test("repeated repair is idempotent — the second run writes nothing", () => {
  const file = staleFixture();
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
  const after = fs.readFileSync(file, "utf8");

  const second = installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });

  assert.equal(second.wrote, false);
  assert.equal(fs.readFileSync(file, "utf8"), after);
});

test("uninstall removes repaired entries as cleanly as freshly installed ones", () => {
  const file = staleFixture();
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });

  const result = uninstallCodexHooks({ hooksPath: file, log: () => {}, dataDir: DATA_DIR });

  assert.equal(result.removed, CODEX_HOOK_EVENTS.length);
  assert.deepEqual(read(file).hooks ?? {}, {});
});

test("each write keeps its own backup instead of overwriting one .bak", () => {
  const file = staleFixture();
  const dir = path.dirname(file);

  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {}, dataDir: DATA_DIR });
  installCodexHooks({ hooksPath: file, command: 'sh "/another/notify-codex.sh"', log: () => {}, dataDir: DATA_DIR });

  const backups = fs.readdirSync(dir).filter((n) => n.endsWith(".bak"));
  assert.equal(backups.length, 2, "the pre-install snapshot must survive a second install");
  // The oldest backup is the original, stale state — the one worth having.
  const oldest = JSON.parse(fs.readFileSync(path.join(dir, backups.sort()[0]), "utf8")) as CodexHooksConfig;
  assert.equal(ourEntries(oldest, "Stop")[0].command, STALE_COMMAND);
});

test("backups are pruned to the five most recent", () => {
  const file = fixture("{}");
  const dir = path.dirname(file);
  for (let i = 0; i < 8; i++) {
    installCodexHooks({ hooksPath: file, command: `sh "/v${i}/notify-codex.sh"`, log: () => {}, dataDir: DATA_DIR });
  }
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".bak")).length, 5);
});

test("a hooks.json edited mid-reconcile is retried, then refused", () => {
  const file = staleFixture();
  const original = fs.readFileSync(file, "utf8");

  // Rewriting the file from the logger runs after the read but before the
  // rename — the exact window the stat check exists to catch.
  let edits = 0;
  const editOnLog = () => {
    edits++;
    fs.writeFileSync(file, original.replace("old-checkout", `edited-${edits}`));
  };

  assert.throws(
    () => installCodexHooks({ hooksPath: file, command: COMMAND, log: editOnLog, dataDir: DATA_DIR }),
    (err: unknown) => err instanceof CodexHooksConflictError
  );
  // Refused, not half-written: the file is still someone's edit, still valid JSON.
  assert.doesNotThrow(() => read(file));
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp")),
    [],
    "a refused write must leave no temp file behind"
  );
});

test("an install interrupted by a concurrent edit retries and succeeds", () => {
  const file = staleFixture();
  const original = fs.readFileSync(file, "utf8");

  let edited = false;
  const editOnce = () => {
    if (edited) return;
    edited = true;
    fs.writeFileSync(file, original.replace("old-checkout", "moved-once"));
  };

  const result = installCodexHooks({ hooksPath: file, command: COMMAND, log: editOnce, dataDir: DATA_DIR });

  assert.equal(result.wrote, true);
  assert.deepEqual(result.updated, [...CODEX_HOOK_EVENTS]);
  assert.equal(ourEntries(read(file), "Stop")[0].command, COMMAND);
});

test("pruning never deletes a backup someone made by hand", () => {
  const file = fixture("{}");
  const dir = path.dirname(file);
  const manual = path.join(dir, "hooks.json.before-i-broke-it.bak");
  fs.writeFileSync(manual, "{}");

  for (let i = 0; i < 8; i++) {
    installCodexHooks({ hooksPath: file, command: `sh "/v${i}/notify-codex.sh"`, log: () => {}, dataDir: DATA_DIR });
  }

  assert.equal(fs.existsSync(manual), true);
});
