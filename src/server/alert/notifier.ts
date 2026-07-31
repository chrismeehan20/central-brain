import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPreferences } from "../store/db.js";

const execFileAsync = promisify(execFile);

let hasTerminalNotifier: boolean | null = null;

async function checkTerminalNotifier(): Promise<boolean> {
  if (hasTerminalNotifier !== null) return hasTerminalNotifier;
  try {
    await execFileAsync("which", ["terminal-notifier"]);
    hasTerminalNotifier = true;
  } catch {
    hasTerminalNotifier = false;
  }
  return hasTerminalNotifier;
}

export interface NotifyOptions {
  title: string;
  body: string;
  sound?: boolean;
}

/**
 * Owns its own notification path so a fresh install works without any
 * pre-existing hook setup: terminal-notifier if present on PATH (nicer,
 * click-to-activate), otherwise osascript (ships with every Mac).
 */
export async function notify({ title, body, sound }: NotifyOptions): Promise<void> {
  // Gated here, not at call sites, so muting covers every alert path at once.
  // Muting only silences the desktop banner — the attention panel and SSE
  // stream still update.
  if (!getPreferences().notifications) return;
  try {
    if (await checkTerminalNotifier()) {
      const args = ["-title", title, "-message", body];
      if (sound) args.push("-sound", "default");
      await execFileAsync("terminal-notifier", args);
    } else {
      const soundClause = sound ? ' sound name "default"' : "";
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}${soundClause}`;
      await execFileAsync("osascript", ["-e", script]);
    }
  } catch (err) {
    console.error("notify failed:", err);
  }
}
