#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename_dir = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_URL = process.env.CENTRAL_BRAIN_HOOK_URL ?? "http://127.0.0.1:4317/api/hook";
const NOTIFY_SCRIPT = path.resolve(__filename_dir, "../hooks/notify.sh");

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

function groupIsOurs(group: HookGroup): boolean {
  return (
    group.hooks?.some(
      (h) => (h.type === "http" && h.url === HOOK_URL) || (h.type === "command" && h.command?.includes(NOTIFY_SCRIPT))
    ) ?? false
  );
}

function main() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log("No settings.json found — nothing to uninstall.");
    return;
  }

  const settings: ClaudeSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  if (!settings.hooks) {
    console.log("No hooks configured — nothing to uninstall.");
    return;
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((g) => !groupIsOurs(g));
    removed += before - settings.hooks[event].length;
  }

  if (removed === 0) {
    console.log("No central-brain hooks found — nothing to uninstall.");
    return;
  }

  const backupPath = `${SETTINGS_PATH}.bak`;
  fs.copyFileSync(SETTINGS_PATH, backupPath);
  console.log(`Backed up existing settings to ${backupPath}`);

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Removed ${removed} central-brain hook group(s). Your other hooks were left untouched.`);
}

main();
