import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexHooksTrusted,
  CODEX_HOOK_EVENTS,
  CODEX_STATUS_MESSAGE,
  CodexHooksConfigError,
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
  return installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {} });
}

test("installing preserves foreign handlers exactly and appends ours for every event", () => {
  const { file } = foreignFixture();

  const result = install(file);

  assert.deepEqual(result.added, [...CODEX_HOOK_EVENTS]);
  assert.equal(result.wrote, true);
  assert.equal(result.backupPath, `${file}.bak`);

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
  const result = uninstallCodexHooks({ hooksPath: file, log: () => {} });

  assert.equal(result.removed, CODEX_HOOK_EVENTS.length);
  assert.equal(result.wrote, true);
  assert.equal(fs.readFileSync(file, "utf8"), original, "install + uninstall must round-trip byte-for-byte");
});

test("uninstalling a config that has no entries of ours changes nothing", () => {
  const { file, original } = foreignFixture();

  const result = uninstallCodexHooks({ hooksPath: file, log: () => {} });

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

  const result = uninstallCodexHooks({ hooksPath: file, log: () => {} });

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
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {} });
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
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {} });
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as CodexHooksConfig;
  const groups = config.hooks?.UserPromptSubmit ?? [];
  assert.equal(groups[0].trusted_hash, "keepme");
  const ours = groups.find((g) => (g.hooks ?? []).some((h) => h.command === COMMAND));
  assert.equal(ours?.trusted_hash, undefined);
});

test("SessionEnd declares the 3s timeout Codex actually enforces; other events keep 10s", () => {
  const file = fixture("");
  installCodexHooks({ hooksPath: file, command: COMMAND, log: () => {} });
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as CodexHooksConfig;
  const timeoutFor = (event: string) =>
    (config.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).find((h) => h.command === COMMAND)
      ?.timeout;
  assert.equal(timeoutFor("SessionEnd"), 3);
  assert.equal(timeoutFor("PermissionRequest"), 10);
});
