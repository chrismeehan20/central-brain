import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_HOOK_EVENTS,
  ClaudeHooksConfigError,
  claudeEntryIsOurs,
  claudeHooksInstalled,
  installClaudeHooks,
  readClaudeSettings,
  uninstallClaudeHooks,
  type ClaudeHookGroup,
  type ClaudeSettings,
} from "./claudeHooks.js";

/**
 * Every test writes to a fresh mkdtemp directory and passes that path in
 * explicitly, so the developer's real ~/.claude/settings.json is never read,
 * written, backed up, or even resolved.
 */
const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-hooks-"));
  tmpDirs.push(dir);
  return path.join(dir, "settings.json");
}

const quiet = () => {};

/** A hook group in the shape of a user's own terminal-notifier setup. */
function foreignGroup(): ClaudeHookGroup {
  return {
    matcher: "",
    hooks: [{ type: "command", command: "terminal-notifier -message 'claude is waiting'" }],
  };
}

test("install into an empty file covers every event and is idempotent", () => {
  const settingsPath = tmpSettingsPath();

  const first = installClaudeHooks({ settingsPath, mode: "http", hookUrl: "http://127.0.0.1:4317/api/hook", log: quiet });
  assert.deepEqual(first.added, [...CLAUDE_HOOK_EVENTS]);
  assert.equal(first.wrote, true);
  assert.equal(claudeHooksInstalled(settingsPath), true);

  const second = installClaudeHooks({ settingsPath, mode: "http", hookUrl: "http://127.0.0.1:4317/api/hook", log: quiet });
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.alreadyPresent, [...CLAUDE_HOOK_EVENTS]);
  assert.equal(second.wrote, false);
});

test("an entry installed under a different port still reads as ours", () => {
  const settingsPath = tmpSettingsPath();
  installClaudeHooks({ settingsPath, mode: "http", hookUrl: "http://127.0.0.1:5000/api/hook", log: quiet });

  assert.equal(claudeHooksInstalled(settingsPath), true);
  // Reinstalling on the default port must not stack duplicates.
  const again = installClaudeHooks({ settingsPath, mode: "http", hookUrl: "http://127.0.0.1:4317/api/hook", log: quiet });
  assert.deepEqual(again.added, []);
});

test("a foreign http hook on a non-local host is not ours", () => {
  assert.equal(claudeEntryIsOurs({ type: "http", url: "https://example.com/api/hook" }), false);
  assert.equal(claudeEntryIsOurs({ type: "http", url: "http://127.0.0.1:4317/api/hook" }), true);
  assert.equal(claudeEntryIsOurs({ type: "command", command: 'sh "/x/hooks/notify.sh"' }), true);
  assert.equal(claudeEntryIsOurs({ type: "command", command: "terminal-notifier -m hi" }), false);
});

test("install preserves foreign hooks and other settings keys", () => {
  const settingsPath = tmpSettingsPath();
  const existing: ClaudeSettings = {
    model: "opus",
    hooks: { Notification: [foreignGroup()] },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing));

  installClaudeHooks({ settingsPath, mode: "http", hookUrl: "http://127.0.0.1:4317/api/hook", log: quiet });

  const after = readClaudeSettings(settingsPath);
  assert.equal(after.model, "opus");
  assert.equal(after.hooks?.Notification.length, 2);
  assert.deepEqual(after.hooks?.Notification[0], foreignGroup());
  // A backup was taken before the first write to an existing file.
  assert.equal(fs.existsSync(`${settingsPath}.bak`), true);
});

test("uninstall removes exactly ours, leaves foreign groups, prunes emptied events", () => {
  const settingsPath = tmpSettingsPath();
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Notification: [foreignGroup()] } }));
  installClaudeHooks({ settingsPath, mode: "http", hookUrl: "http://127.0.0.1:4317/api/hook", log: quiet });

  const result = uninstallClaudeHooks({ settingsPath, log: quiet });
  assert.equal(result.removed, CLAUDE_HOOK_EVENTS.length);

  const after = readClaudeSettings(settingsPath);
  // Notification keeps the foreign group; events only we created are pruned.
  assert.deepEqual(after.hooks?.Notification, [foreignGroup()]);
  assert.equal(after.hooks?.Stop, undefined);
  assert.equal(claudeHooksInstalled(settingsPath), false);
});

test("command mode writes a notify.sh command entry", () => {
  const settingsPath = tmpSettingsPath();
  installClaudeHooks({ settingsPath, mode: "command", notifyScript: "/opt/cb/hooks/notify.sh", log: quiet });

  const after = readClaudeSettings(settingsPath);
  const entry = after.hooks?.Stop[0].hooks?.[0];
  assert.equal(entry?.type, "command");
  assert.equal(entry?.command, 'sh "/opt/cb/hooks/notify.sh"');
  assert.equal(claudeHooksInstalled(settingsPath), true);
});

test("unparseable settings.json aborts rather than clobbering", () => {
  const settingsPath = tmpSettingsPath();
  fs.writeFileSync(settingsPath, "{not json");

  assert.throws(() => installClaudeHooks({ settingsPath, log: quiet }), ClaudeHooksConfigError);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "{not json"); // untouched
  assert.equal(claudeHooksInstalled(settingsPath), false); // reads as not installed, not as a crash
});
