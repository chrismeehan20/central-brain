import { useState } from "react";
import type { ApiKeyStatus, EditorId, Preferences, SettingsResponse } from "@shared/types";
import { EDITORS } from "@shared/types";
import { clearApiKey, dismissApiKeySetup, saveApiKey, saveNtfyUrl, updatePreferences } from "./api";
import HooksPanel from "./HooksPanel";
import GithubPanel from "./GithubPanel";

/**
 * Anthropic API key setup, in two guises.
 *
 * `mode="onboarding"` is the first-run card the dashboard shows above
 * everything else when no key is configured and setup has not been skipped.
 * `mode="settings"` is the same form, reachable from the topbar forever after,
 * so a user who skips setup on day one is not locked out of AI features.
 *
 * Both exist because the key has nowhere else to come from in a packaged app:
 * the sidecar runs with cwd `/`, so there is no `.env` to edit and no shell to
 * export from. Before this, an installed app could never enable AI at all.
 */
interface Props {
  mode: "onboarding" | "settings";
  settings: SettingsResponse;
  onStatusChange: (status: ApiKeyStatus) => void;
  onPreferencesChange?: (preferences: Preferences) => void;
  onClose?: () => void;
}

const CONSOLE_URL = "https://console.anthropic.com/settings/keys";

export default function ApiKeyPanel({ mode, settings, onStatusChange, onPreferencesChange, onClose }: Props) {
  const { apiKey: status, ai, preferences } = settings;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  // Seeded from the server's stored value; edited locally until Save.
  const [ntfyValue, setNtfyValue] = useState(settings.ntfy?.url ?? "");
  const [ntfySaved, setNtfySaved] = useState(false);

  async function applyNtfy() {
    setPrefsError(null);
    setNtfySaved(false);
    try {
      const next = await saveNtfyUrl(ntfyValue.trim());
      setNtfyValue(next.url ?? "");
      setNtfySaved(true);
    } catch (err) {
      setPrefsError((err as Error).message ?? String(err));
    }
  }
  // Edited as free text and saved on blur: one PUT per edit session rather than
  // one per keystroke, and a half-typed "owner/" never reaches the validator.
  const [reposDraft, setReposDraft] = useState(() => preferences.remoteRepos.join("\n"));

  async function applyPreferences(patch: Partial<Preferences>) {
    setPrefsError(null);
    try {
      onPreferencesChange?.(await updatePreferences(patch));
    } catch (err) {
      setPrefsError((err as Error).message ?? String(err));
    }
  }

  async function run(action: () => Promise<ApiKeyStatus>, clearInput: boolean) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await action();
      onStatusChange(next);
      if (clearInput) setValue("");
      setSaved(clearInput);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  const handleSave = () => run(() => saveApiKey(value), true);
  const handleRemove = () => run(clearApiKey, false);
  const handleSkip = () => run(dismissApiKeySetup, false);

  return (
    <section className={`setup ${mode === "onboarding" ? "setup--onboarding" : ""}`}>
      <div className="setup__header">
        <h2 className="setup__title">
          {mode === "onboarding" ? "Turn on AI summaries" : "Settings"}
        </h2>
        {onClose && (
          <button className="setup__close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        )}
      </div>

      {mode === "onboarding" && (
        <p className="setup__lede">
          Central Brain already works — projects, alerts and GitHub status need no key. Add an
          Anthropic API key to also get the one-line “what’s left” summaries and the daily digest.
        </p>
      )}

      {status.managedByEnv ? (
        <p className="setup__note">
          A key is set in this server’s environment (<code>ANTHROPIC_API_KEY</code>), ending{" "}
          <code>…{status.hint}</code>. The environment wins, so there is nothing to enter here.
          Remove it from your <code>.env</code> or shell if you would rather manage the key from
          this screen.
        </p>
      ) : (
        <>
          {/* Em dash rather than a full stop after the chip: a padded inline
              chip already carries side padding, so "…TwAA ." reads as a typo
              while "…TwAA — " reads as intended spacing. */}
          {status.configured && (
            <p className="setup__note setup__note--ok">
              Key saved, ending <code>…{status.hint}</code> — paste a new one below to
              replace it.
            </p>
          )}

          {/* A real form, so Enter submits natively and password managers stop
              warning about a bare password field. */}
          <form
            className="setup__row"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim() && !busy) handleSave();
            }}
          >
            <input
              className="setup__input"
              type="password"
              name="anthropic-api-key"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
            />
            <button type="submit" disabled={busy || !value.trim()}>
              {busy ? "Checking…" : status.configured ? "Replace key" : "Save key"}
            </button>
          </form>

          <p className="setup__hint">
            Get one at{" "}
            <a href={CONSOLE_URL} target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            . It is verified before saving, stored only on this Mac (owner-readable, in Central
            Brain’s data folder), and never leaves it except to call Anthropic.
          </p>
        </>
      )}

      {error && <p className="setup__error">{error}</p>}
      {saved && !error && <p className="setup__ok">Key verified and saved. AI features are on.</p>}

      {mode === "settings" && <HooksPanel mode="settings" />}
      {mode === "settings" && <GithubPanel status={settings.github} />}

      {/* Preferences live behind the gear only — onboarding stays a single ask. */}
      {mode === "settings" && (
        <div className="setup__prefs">
          <label className="setup__pref">
            <input
              type="checkbox"
              checked={preferences.notifications}
              onChange={(e) => applyPreferences({ notifications: e.target.checked })}
            />
            <span>
              Desktop notifications
              <span className="setup__pref-hint">
                Off = the needs-attention panel still updates, just silently.
              </span>
            </span>
          </label>
          <label className="setup__pref">
            <span>
              Editor
              <span className="setup__pref-hint">Where doc links and “Open” buttons go.</span>
            </span>
            <select
              className="setup__pref-select"
              value={preferences.editor}
              onChange={(e) => applyPreferences({ editor: e.target.value as EditorId })}
            >
              {(Object.keys(EDITORS) as EditorId[]).map((id) => (
                <option key={id} value={id}>
                  {EDITORS[id].label}
                </option>
              ))}
            </select>
          </label>
          <label className="setup__pref setup__pref--stack">
            <span>
              Phone push (ntfy)
              <span className="setup__pref-hint">
                Alerts also go to this{" "}
                <a href="https://ntfy.sh" target="_blank" rel="noreferrer">
                  ntfy
                </a>{" "}
                topic — subscribe to it in the ntfy app on your phone. Empty = off. Anyone who
                knows a public topic's name can read it, so use a long random one (or self-host).
              </span>
            </span>
            <span className="setup__pref-row">
              <input
                className="setup__input"
                type="url"
                placeholder="https://ntfy.sh/your-long-random-topic"
                value={ntfyValue}
                onChange={(e) => {
                  setNtfyValue(e.target.value);
                  setNtfySaved(false);
                }}
                spellCheck={false}
              />
              <button type="button" onClick={applyNtfy}>
                {ntfySaved ? "Saved" : "Save"}
              </button>
            </span>
          </label>
          <label className="setup__pref setup__pref--stacked">
            <span>
              Also watch these repos
              <span className="setup__pref-hint">
                One <code>owner/repo</code> per line. Repos you have checked out here are
                watched already — this is for work that only exists in the cloud, like a
                Claude session on the web that opened a PR in a repo you have never cloned.
              </span>
            </span>
            <textarea
              className="setup__pref-textarea"
              rows={3}
              spellCheck={false}
              placeholder="chrismeehan20/belfry"
              value={reposDraft}
              onChange={(e) => setReposDraft(e.target.value)}
              onBlur={() =>
                applyPreferences({
                  remoteRepos: reposDraft
                    .split(/[\s,]+/)
                    .map((r) => r.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          {prefsError && <p className="setup__error">{prefsError}</p>}
        </div>
      )}

      <div className="setup__footer">
        <span className="setup__meta">
          {ai.model} · {ai.callsRemaining}/{ai.dailyCap} calls left today
        </span>
        <div className="setup__actions">
          {status.configured && !status.managedByEnv && (
            <button className="setup__secondary" onClick={handleRemove} disabled={busy}>
              Remove key
            </button>
          )}
          {mode === "onboarding" && (
            <button className="setup__secondary" onClick={handleSkip} disabled={busy}>
              Skip for now
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
