#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename_dir = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_URL = process.env.CENTRAL_BRAIN_HOOK_URL ?? "http://127.0.0.1:4317/api/hook";
const NOTIFY_SCRIPT = path.resolve(__filename_dir, "../hooks/notify.sh");
// http hooks are the default; set CENTRAL_BRAIN_HOOK_MODE=command for older
// Claude Code versions without native "http" hook support.
const MODE = process.env.CENTRAL_BRAIN_HOOK_MODE === "command" ? "command" : "http";
const EVENTS = [
  "Notification",
  "PermissionRequest",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
];

interface HookEntry {
  type: string;
  url?: string;
  command?: string;
}

interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function readSettings(): ClaudeSettings {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch (err) {
    console.error(
      `Could not parse ${SETTINGS_PATH} as JSON — aborting so we don't corrupt your existing hooks.`
    );
    throw err;
  }
}

function backup() {
  if (!fs.existsSync(SETTINGS_PATH)) return;
  const backupPath = `${SETTINGS_PATH}.bak`;
  fs.copyFileSync(SETTINGS_PATH, backupPath);
  console.log(`Backed up existing settings to ${backupPath}`);
}

function groupIsOurs(group: HookGroup): boolean {
  return (
    group.hooks?.some(
      (h) => (h.type === "http" && h.url === HOOK_URL) || (h.type === "command" && h.command?.includes(NOTIFY_SCRIPT))
    ) ?? false
  );
}

function buildHookEntry(): HookEntry {
  return MODE === "command" ? { type: "command", command: `sh "${NOTIFY_SCRIPT}"` } : { type: "http", url: HOOK_URL };
}

function main() {
  const settings = readSettings();
  settings.hooks ??= {};

  let added = 0;
  for (const event of EVENTS) {
    settings.hooks[event] ??= [];
    const groups = settings.hooks[event];

    if (groups.some(groupIsOurs)) {
      continue; // already installed for this event — idempotent no-op
    }

    // Appended as its own group so it never touches your existing
    // terminal-notifier / iTerm hooks — safe to add and remove independently.
    groups.push({ matcher: "", hooks: [buildHookEntry()] });
    added++;
  }

  if (added === 0) {
    console.log("central-brain hooks are already installed — nothing to do.");
    return;
  }

  backup();
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Installed central-brain hooks for: ${EVENTS.join(", ")}`);
  console.log("Your existing hooks were preserved — we only appended new entries.");
}

main();
