import { useState } from "react";
import type { GithubCliStatus } from "@shared/types";
import { recheckGithubCli } from "./api";

/**
 * What GitHub integration is currently doing, and what to do about it.
 *
 * There is no account to link here: the app has no OAuth flow and stores no
 * token, it just runs the `gh` CLI you already signed in to. That is the whole
 * setup — and it is also why this panel has to exist. When `gh` is missing or
 * signed out, every call site catches and moves on, so the difference between
 * "install gh", "run gh auth login" and "nothing needs you" used to be three
 * identical empty panels.
 */

const INSTALL_URL = "https://cli.github.com";

function summary(status: GithubCliStatus): { label: string; tone: string } {
  switch (status.state) {
    case "connected":
      return { label: status.login ? `Connected as @${status.login}` : "Connected", tone: "ok" };
    case "unauthenticated":
      return { label: "Installed — not signed in", tone: "warn" };
    case "missing":
      return { label: "Not found", tone: "warn" };
    default:
      return { label: "Checking…", tone: "muted" };
  }
}

export default function GithubPanel({ status: initial }: { status: GithubCliStatus }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, tone } = summary(status);

  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await recheckGithubCli());
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ghcli">
      <div className="ghcli__row">
        <span className="ghcli__name">GitHub</span>
        <span className={`ghcli__state ghcli__state--${tone}`} title={status.path ?? undefined}>
          {label}
        </span>
        <button className="ghcli__recheck" disabled={busy} onClick={recheck}>
          {busy ? "Checking…" : "Re-check"}
        </button>
      </div>

      {status.state === "missing" && (
        <p className="ghcli__hint">
          Install the{" "}
          <a href={INSTALL_URL} target="_blank" rel="noreferrer">
            gh CLI
          </a>{" "}
          (<code>brew install gh</code>), then <code>gh auth login</code> once in a terminal.
        </p>
      )}
      {status.state === "unauthenticated" && (
        <p className="ghcli__hint">
          Run <code>gh auth login</code> once in a terminal, then Re-check. Central Brain reads
          that sign-in — it never asks for a token of its own.
        </p>
      )}
      {status.state === "connected" && (
        <p className="ghcli__hint">
          Branch and CI status on project cards, and pull requests that need you in the
          needs-attention panel. Read-only, over this sign-in.
        </p>
      )}
      {/* The resolved path, because "which gh is it even using" is the first
          question when a terminal says one thing and the app shows another. */}
      {status.path && <p className="ghcli__path">{status.path}</p>}
      {status.detail && status.state !== "connected" && (
        <p className="ghcli__path">{status.detail}</p>
      )}
      {error && <p className="setup__error">{error}</p>}
    </div>
  );
}
