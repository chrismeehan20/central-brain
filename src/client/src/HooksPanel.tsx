import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexHooksDiagnosis, HooksSetupStatus } from "@shared/types";
import { dismissHooksSetup, fetchHooksStatus, installHooks } from "./api";
import {
  ACTIONABLE_CODEX_STATES,
  claudeRow,
  codexRow,
  IN_FLIGHT_CODEX_STATES,
  onboardingVisibility,
  type HookRow,
} from "./hooksCopy";

/**
 * Dashboard-driven hook install — the "Connect your tools" card.
 *
 * `mode="onboarding"` renders as a first-run card and hides itself once there
 * is nothing actionable or the user clicks Later. `mode="settings"` is the
 * same rows embedded in the ⚙ panel, always visible so the state can be
 * checked forever after.
 *
 * The Codex row renders the server's single `diagnosis.overall` rather than
 * combining `installed` / `trusted` / `live` itself. Those three could
 * disagree, and this component's own if-ordering used to decide which
 * disagreement won — which is how a hook pointing at a path that no longer
 * existed displayed as "Connected — events are arriving".
 */
interface Props {
  mode: "onboarding" | "settings";
  /**
   * Onboarding-only: reports whether this panel currently has something for
   * the user to act on. `App` uses this to hold the API-key card back until
   * hooks onboarding is out of the way — installed, dismissed, or simply
   * unreachable (see the fetch-rejection path below, which reports `false`
   * rather than leaving the caller stuck).
   */
  onOnboardingActionable?: (actionable: boolean) => void;
}

const POLL_MS = 15_000;

/**
 * While the user is mid-flow — they've just installed, or been told to go and
 * approve in Codex — the interesting transition happens in another app and we
 * want it reflected almost immediately. Outside that window a 15s poll is
 * plenty for something that changes a few times a year.
 */
const VERIFYING_POLL_MS = 2_000;
const VERIFYING_WINDOW_MS = 2 * 60_000;

export default function HooksPanel({ mode, onOnboardingActionable }: Props) {
  const [status, setStatus] = useState<HooksSetupStatus | null>(null);
  const [busy, setBusy] = useState<"claude" | "codex" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // A timestamp rather than a boolean, so the fast poll expires on its own
  // instead of running until the panel unmounts.
  const [verifyingUntil, setVerifyingUntil] = useState(0);
  const verifying = verifyingUntil > Date.now();

  // Read inside the interval callback so changing the rate doesn't need the
  // effect (and the request in flight) torn down.
  const verifyingRef = useRef(verifyingUntil);
  verifyingRef.current = verifyingUntil;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      const rate = verifyingRef.current > Date.now() ? VERIFYING_POLL_MS : POLL_MS;
      timer = setTimeout(load, rate);
    };
    const load = () =>
      fetchHooksStatus()
        .then((s) => {
          if (cancelled) return;
          setStatus(s);
          schedule();
        })
        .catch(() => {
          // Quiet: a failed status fetch must not break the dashboard around
          // it. It also must not leave onboarding stuck waiting on hooks
          // forever, so tell the caller there's nothing actionable here.
          if (cancelled) return;
          onOnboardingActionable?.(false);
          schedule();
        });

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `onOnboardingActionable` is a useState setter from the caller (stable
    // identity across renders), so listing it here doesn't restart the loop.
  }, [onOnboardingActionable]);

  const claudeNeedsUser = status ? status.claude.dirExists && !status.claude.installed : false;
  // Two predicates, deliberately: `needsUser` gates the API-key card below and
  // must not include a passive wait, or someone who approved and then didn't
  // reopen Codex would be blocked from it indefinitely. `inFlight` decides
  // whether this card stays on screen, and does include that wait.
  const needsUser = status
    ? claudeNeedsUser || ACTIONABLE_CODEX_STATES.has(status.codex.diagnosis.overall)
    : false;
  const inFlight = status
    ? claudeNeedsUser || IN_FLIGHT_CODEX_STATES.has(status.codex.diagnosis.overall)
    : false;

  // Remembers that a flow was under way, so the success state is shown to
  // someone who finished one — and never to someone who just loaded a
  // dashboard that already worked.
  const sawIncomplete = useRef(false);
  useEffect(() => {
    if (inFlight) sawIncomplete.current = true;
  }, [inFlight]);

  // Derive + report actionability whenever status changes (initial load,
  // install, or dismiss) — same value the render below uses, kept in one place
  // so they can't drift.
  useEffect(() => {
    if (!status) return;
    onOnboardingActionable?.(!status.setupDismissed && needsUser);
  }, [status, needsUser, onOnboardingActionable]);

  const run = useCallback(async (tool: "claude" | "codex") => {
    setBusy(tool);
    setError(null);
    try {
      setStatus(await installHooks(tool));
      // Whatever just happened, the next thing is a transition we can't see:
      // the user approving inside Codex, or the first event landing.
      setVerifyingUntil(Date.now() + VERIFYING_WINDOW_MS);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard denied — the command is on screen to type by hand */
      }
    );
  }, []);

  if (!status) return null;

  const { visible, celebrating } = onboardingVisibility({
    setupDismissed: status.setupDismissed,
    inFlight,
    sawIncomplete: sawIncomplete.current,
  });
  // The onboarding card earns its screen space while setup is unfinished, plus
  // one last render once it finishes — the payoff. The settings copy is always
  // reachable regardless.
  if (mode === "onboarding" && !visible) return null;

  const renderRow = (tool: "claude" | "codex", label: string, row: HookRow) => (
    <div className="hooks__row" key={tool}>
      <span className="hooks__tool">{label}</span>
      <span className={`hooks__state ${row.good ? "hooks__state--live" : ""}`}>
        {row.state}
        {row.detail && <span className="hooks__detail">{row.detail}</span>}
        {row.command && (
          <span className="hooks__command">
            <code>{row.command}</code>
            <button type="button" className="hooks__copy" onClick={() => copy(row.command!)}>
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        )}
      </span>
      {row.action && (
        <button onClick={() => run(tool)} disabled={busy !== null}>
          {busy === tool ? row.action.busyLabel : row.action.label}
        </button>
      )}
    </div>
  );

  const diagnosis = status.codex.diagnosis;
  const body = (
    <>
      {renderRow("claude", "Claude Code", claudeRow(status.claude))}
      {renderRow("codex", "Codex", codexRow(diagnosis, diagnosis.lastEventAt))}
      {mode === "settings" && diagnosis.overall !== "not_detected" && (
        <p className="hooks__paths">
          Codex folder: <code>{diagnosis.codexHome}</code>
          <br />
          Forwarder: <code>{diagnosis.forwarderPath}</code>
          {diagnosis.spool && diagnosis.spool.pending > 0 && (
            <>
              <br />
              {diagnosis.spool.pending} event{diagnosis.spool.pending === 1 ? "" : "s"} waiting to be replayed.
            </>
          )}
        </p>
      )}
      {verifying && <p className="hooks__watching">Watching for changes…</p>}
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
        <h2 className="setup__title">
          {celebrating ? "You're connected" : "Get alerts the moment an agent needs you"}
        </h2>
      </div>
      <p className="setup__lede">
        {celebrating
          ? "Events are arriving. Central Brain will tell you the moment a session needs your OK, without you having to watch it."
          : "Install a hook so Claude Code and Codex tell Central Brain when a session needs your OK — and, for Claude Code, when it's waiting on your reply. It only touches its own entries — your existing hooks are never changed, and there's a backup either way."}
      </p>
      {body}
      <div className="setup__footer">
        <span className="setup__meta">
          {celebrating
            ? "You can check this any time under ⚙ → Connected tools."
            : "Without hooks, alerts rely on slower file scanning."}
        </span>
        <div className="setup__actions">
          <button
            className="setup__secondary"
            onClick={() => dismissHooksSetup().then(setStatus).catch(() => {})}
            disabled={busy !== null}
          >
            {/* Dismissal is persisted, which is right here: once it's proven
                working there is nothing to come back to this card for. */}
            {celebrating ? "Done" : "Later"}
          </button>
        </div>
      </div>
    </section>
  );
}
