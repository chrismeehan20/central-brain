import type { CodexHooksDiagnosis, HookToolStatus } from "@shared/types";
import { relativeTime } from "./format";

/**
 * What each hook state says to the user.
 *
 * Separated from the component so it can be tested directly: the copy is the
 * part that was wrong before. HooksPanel used to combine `installed`,
 * `trusted` and `live` itself, and its own if-ordering decided which of those
 * contradictions won — which is how a hook pointing at a path that no longer
 * existed rendered as "Connected — events are arriving".
 */

export interface HookRow {
  state: string;
  detail?: string;
  /** Rendered in the accent colour. Reserved for a pipeline actually proven to work. */
  good?: boolean;
  action?: { label: string; busyLabel: string };
  /** Shown with a copy button, because it has to be typed into another app. */
  command?: string;
}

/** States where the user still has something to do. Drives onboarding visibility. */
export const ACTIONABLE_CODEX_STATES: ReadonlySet<CodexHooksDiagnosis["overall"]> = new Set([
  "needs_install",
  "needs_repair",
  "needs_review",
  "config_error",
  "disabled",
]);

export function codexRow(diagnosis: CodexHooksDiagnosis, lastEventAt?: string): HookRow {
  const detail = diagnosis.diagnostics.join(" ");
  switch (diagnosis.overall) {
    case "not_detected":
      return { state: "Not detected on this Mac." };
    case "config_error":
      return {
        state: "Codex's hooks.json can't be read, so nothing was changed.",
        detail: `${detail} Fix or move ${diagnosis.hooksPath}, then reload.`.trim(),
      };
    case "disabled":
      return { state: "Codex has hooks switched off.", detail };
    case "needs_install":
      return {
        state: "Not connected — alerts fall back to slower scanning.",
        action: { label: "Install", busyLabel: "Installing…" },
      };
    case "needs_repair":
      return {
        // Never opens with "Connected". Someone scanning the panel reads the
        // first word, and every other state has to be unmistakably not that.
        state: "Out of date — Codex is running a hook that can't reach us.",
        detail,
        // Deliberately a different word from Install: this rewrites definitions
        // Codex may already have approved, and costs an approval to do.
        action: { label: "Repair", busyLabel: "Repairing…" },
      };
    case "needs_review":
      return {
        state: "Installed — one step left: approve the hooks inside Codex.",
        detail: `${detail} Run this in Codex, then approve the central-brain entries. Codex runs none of them until you do.`.trim(),
        command: "/hooks",
      };
    case "waiting_for_verification":
      return {
        state: "Approved — waiting for the first event to confirm it.",
        detail: `${detail} Start a Codex session or send it a prompt.`.trim(),
      };
    case "connected":
      return {
        state: lastEventAt ? `Connected — last event ${relativeTime(lastEventAt)}.` : "Connected.",
        good: true,
      };
    case "stale":
      return { state: "No events recently.", detail };
  }
}

export function claudeRow(tool: HookToolStatus): HookRow {
  if (!tool.dirExists) return { state: "Not detected on this Mac." };
  if (!tool.installed) {
    return {
      state: "Not connected — alerts fall back to slower scanning.",
      action: { label: "Install", busyLabel: "Installing…" },
    };
  }
  if (tool.live) {
    return {
      state: tool.lastEventAt ? `Connected — last event ${relativeTime(tool.lastEventAt)}.` : "Connected.",
      good: true,
    };
  }
  return { state: "Installed — waiting for the first session event." };
}
