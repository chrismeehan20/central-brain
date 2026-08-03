import { useEffect, useState } from "react";
import type { HooksSetupStatus } from "@shared/types";
import { dismissHooksSetup, fetchHooksStatus, installHooks } from "./api";

/**
 * Dashboard-driven hook install — the "Connect your tools" card.
 *
 * `mode="onboarding"` renders as a first-run card and hides itself once there
 * is nothing actionable (every detected tool has hooks installed) or the user
 * clicks Later. `mode="settings"` is the same rows embedded in the ⚙ panel,
 * always visible so the state can be checked (and Codex's approval nagged
 * about) forever after.
 *
 * Status is polled while visible: the interesting transitions — the user
 * approves the config inside Codex, the first real event lands — happen
 * outside the browser, and the panel should notice without a reload.
 */
interface Props {
  mode: "onboarding" | "settings";
  /**
   * Onboarding-only: reports whether this panel currently has something for
   * the user to act on (install a hook, approve Codex). `App` uses this to
   * hold the API-key card back until hooks onboarding is out of the way —
   * installed, dismissed, or simply unreachable (see the fetch-rejection
   * path below, which reports `false` rather than leaving the caller stuck).
   */
  onOnboardingActionable?: (actionable: boolean) => void;
}

const POLL_MS = 15_000;

export default function HooksPanel({ mode, onOnboardingActionable }: Props) {
  const [status, setStatus] = useState<HooksSetupStatus | null>(null);
  const [busy, setBusy] = useState<"claude" | "codex" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchHooksStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          // Quiet: a failed status fetch must not break the dashboard around
          // it. It also must not leave onboarding stuck waiting on hooks
          // forever, so tell the caller there's nothing actionable here.
          if (!cancelled) onOnboardingActionable?.(false);
        });
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // `onOnboardingActionable` is a useState setter from the caller (stable
    // identity across renders), so listing it here doesn't tear down and
    // restart the poll loop.
  }, [onOnboardingActionable]);

  // Derive + report actionability whenever status changes (initial load,
  // install, or dismiss) — same boolean the render below uses to decide
  // onboarding visibility, kept in one place so they can't drift.
  useEffect(() => {
    if (!status) return;
    const actionable =
      (status.claude.dirExists && !status.claude.installed) ||
      (status.codex.dirExists && !status.codex.installed);
    const codexNeedsApproval =
      status.codex.installed && !status.codex.live && !status.codex.approvalStateExists;
    onOnboardingActionable?.(!status.setupDismissed && (actionable || codexNeedsApproval));
  }, [status, onOnboardingActionable]);

  if (!status) return null;

  const actionable =
    (status.claude.dirExists && !status.claude.installed) ||
    (status.codex.dirExists && !status.codex.installed);
  const codexNeedsApproval =
    status.codex.installed && !status.codex.live && !status.codex.approvalStateExists;

  // The onboarding card earns its screen space only while there is a button to
  // click or an approval to chase; the settings copy is always reachable.
  if (mode === "onboarding" && (status.setupDismissed || !(actionable || codexNeedsApproval))) {
    return null;
  }

  async function run(tool: "claude" | "codex") {
    setBusy(tool);
    setError(null);
    try {
      setStatus(await installHooks(tool));
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(null);
    }
  }

  function describe(tool: "claude" | "codex"): string {
    const t = tool === "claude" ? status!.claude : status!.codex;
    if (!t.dirExists) return "Not detected on this Mac.";
    if (!t.installed) return "Hooks not installed — alerts fall back to slower scanning.";
    if (t.live) return "Connected — events are arriving.";
    if (tool === "codex") {
      return status!.codex.approvalStateExists
        ? "Installed — waiting for events. If Codex asks you to approve the hook config again, accept it."
        : "Installed — one step left: start a Codex session and approve the hook config when it asks. Codex runs no hooks until you do.";
    }
    return "Installed — waiting for the first session event.";
  }

  const row = (tool: "claude" | "codex", label: string) => {
    const t = tool === "claude" ? status!.claude : status!.codex;
    return (
      <div className="hooks__row">
        <span className="hooks__tool">{label}</span>
        <span className={`hooks__state ${t.live ? "hooks__state--live" : ""}`}>{describe(tool)}</span>
        {t.dirExists && !t.installed && (
          <button onClick={() => run(tool)} disabled={busy !== null}>
            {busy === tool ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    );
  };

  const body = (
    <>
      {row("claude", "Claude Code")}
      {row("codex", "Codex")}
      {error && <p className="setup__error">{error}</p>}
    </>
  );

  if (mode === "settings") {
    return (
      <div className="hooks hooks--settings">
        <h3 className="hooks__title">Connected tools</h3>
        {body}
      </div>
    );
  }

  return (
    <section className="setup setup--onboarding">
      <div className="setup__header">
        <h2 className="setup__title">Get alerts the moment an agent needs you</h2>
      </div>
      <p className="setup__lede">
        Install a hook so Claude Code and Codex tell Central Brain when a session is blocked on a
        permission or waiting for your reply. It only appends entries — your existing hooks are
        never touched, and there's a backup either way.
      </p>
      {body}
      <div className="setup__footer">
        <span className="setup__meta">Without hooks, alerts rely on slower file scanning.</span>
        <div className="setup__actions">
          <button
            className="setup__secondary"
            onClick={() => dismissHooksSetup().then(setStatus).catch(() => {})}
            disabled={busy !== null}
          >
            Later
          </button>
        </div>
      </div>
    </section>
  );
}
