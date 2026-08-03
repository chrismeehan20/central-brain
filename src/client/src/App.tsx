import { useEffect, useState } from "react";
import type {
  ApiKeyStatus,
  MissingProjectTriage,
  Preferences,
  Project,
  SettingsResponse,
} from "@shared/types";
import { DEFAULT_PREFERENCES } from "@shared/types";
import {
  fetchProjects,
  fetchRelocations,
  fetchSettings,
  relocateProject,
  triggerScan,
  updateOverride,
} from "./api";
import { PreferencesContext } from "./prefs";
import {
  ACTIVE_WINDOW_DAYS,
  CHIPS,
  type ChipId,
  compareDashboard,
  matchesChips,
  partitionDashboard,
} from "./sections";
import ProjectGrid from "./ProjectGrid";
import ProjectDetailPage from "./ProjectDetailPage";
import AttentionPanel from "./AttentionPanel";
import ApiKeyPanel from "./ApiKeyPanel";
import DigestPanel from "./DigestPanel";
import HooksPanel from "./HooksPanel";
import { relativeTime } from "./format";

const DETAIL_PREFIX = "#/project/";

function parseRoute(): string | null {
  const hash = window.location.hash;
  return hash.startsWith(DETAIL_PREFIX) ? decodeURIComponent(hash.slice(DETAIL_PREFIX.length)) : null;
}

export function goToProject(path: string): void {
  window.location.hash = DETAIL_PREFIX + encodeURIComponent(path);
}

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [route, setRoute] = useState<string | null>(parseRoute());
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<Set<ChipId>>(new Set());
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [triage, setTriage] = useState<Record<string, MissingProjectTriage> | null>(null);
  const [bulkRelocating, setBulkRelocating] = useState(false);
  // Starts true so the key card never flashes above the hooks card before
  // the first hooks-status fetch lands (see HooksPanel's onOnboardingActionable).
  const [hooksOnboardingActive, setHooksOnboardingActive] = useState(true);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function loadSettings() {
    // Quiet on failure: a settings fetch that fails must not replace the whole
    // dashboard with an error, since nothing else depends on it.
    fetchSettings()
      .then(setSettings)
      .catch(() => {});
  }

  useEffect(loadSettings, []);

  /** After a save/remove the daily-call counters are stale too, so refetch the lot. */
  function handleApiKeyStatus(apiKey: ApiKeyStatus) {
    setSettings((prev) => (prev ? { ...prev, apiKey } : prev));
    loadSettings();
  }

  function handlePreferences(preferences: Preferences) {
    setSettings((prev) => (prev ? { ...prev, preferences } : prev));
  }

  function load() {
    fetchProjects()
      .then((res) => {
        setProjects(res.projects);
        setLastScanAt(res.lastScanAt);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function handleRescan() {
    setScanning(true);
    try {
      const res = await triggerScan();
      setProjects(res.projects);
      setLastScanAt(new Date().toISOString());
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }

  async function applyOverride(path: string, override: Parameters<typeof updateOverride>[1]) {
    try {
      const res = await updateOverride(path, override);
      setProjects(res.projects);
    } catch (err) {
      setError(String(err));
    }
  }

  // Which folders are missing, as a stable key. The relocation search walks the
  // filesystem, so it must fire only when that set changes — not on every 30s
  // project poll.
  const missingKey = (projects ?? [])
    .filter((p) => p.missing && !p.hidden)
    .map((p) => p.path)
    .join("|");

  useEffect(() => {
    if (!missingKey) {
      setTriage(null);
      return;
    }
    let cancelled = false;
    fetchRelocations()
      .then((res) => {
        if (!cancelled) setTriage(Object.fromEntries(res.missing.map((m) => [m.path, m])));
      })
      // Quiet: a failed search leaves the cards saying "looking…" rather than
      // replacing the whole dashboard with an error.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [missingKey]);

  async function handleRelocate(from: string, to: string) {
    // Errors propagate to the card, which shows them inline next to the button.
    const res = await relocateProject(from, to);
    setProjects(res.projects);
    setLastScanAt(res.lastScanAt);
  }

  async function handleUndoMove(oldPaths: string[]) {
    try {
      for (const oldPath of oldPaths) {
        const res = await relocateProject(oldPath, null);
        setProjects(res.projects);
        setLastScanAt(res.lastScanAt);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  if (error && !projects) {
    return (
      <main className="shell">
        <h1>Central Brain</h1>
        <p className="error">Server not reachable: {error}</p>
      </main>
    );
  }

  if (!projects) {
    return (
      <main className="shell">
        <h1>Central Brain</h1>
        <p className="subtitle">Loading projects…</p>
      </main>
    );
  }

  const preferences = settings?.preferences ?? DEFAULT_PREFERENCES;

  if (route) {
    return (
      <PreferencesContext.Provider value={preferences}>
        <ProjectDetailPage
          path={route}
          project={projects.find((p) => p.path === route)}
          onBack={() => {
            window.location.hash = "";
          }}
        />
      </PreferencesContext.Provider>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (p: Project) =>
    !q ||
    p.displayName.toLowerCase().includes(q) ||
    p.path.toLowerCase().includes(q) ||
    (p.summary?.text ?? "").toLowerCase().includes(q) ||
    (p.openItems ?? []).some((t) => t.toLowerCase().includes(q));

  // Onboarding shows until a key exists or the user skips — never for a key
  // that came from the environment, which needs no setup. It's also step 2:
  // held back while hooks onboarding (step 1, the "agent needs you" moment)
  // still has something actionable, so the optional key card never outranks
  // the core hook setup.
  const showOnboarding =
    Boolean(settings && !settings.apiKey.configured && !settings.apiKey.setupDismissed) &&
    !hooksOnboardingActive;

  // Four buckets, each already sorted. `missing` and `hidden` deliberately
  // ignore the search box and the chips — they are triage lists, and a filter
  // silently emptying them would hide work that still needs doing.
  const { active, dormant, missing, hidden } = partitionDashboard(projects, new Date());

  const keep = (p: Project) => matches(p) && matchesChips(p, chips);
  // Any chip on, or anything typed, and the Active/dormant split stops helping:
  // you are hunting for a specific project, so the two buckets collapse into
  // one flat result list rather than burying half the hits in a closed drawer.
  const filtering = chips.size > 0 || q.length > 0;
  const matching = filtering ? [...active, ...dormant].filter(keep).sort(compareDashboard) : [];

  function toggleChip(id: ChipId) {
    setChips((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function handleSummaryUpdated(path: string, summary: Project["summary"]) {
    setProjects((prev) => prev?.map((p) => (p.path === path ? { ...p, summary } : p)) ?? prev);
  }

  const gridProps = {
    onRename: (path: string, displayName: string) => applyOverride(path, { displayName }),
    onToggleHidden: (path: string, hidden: boolean) => applyOverride(path, { hidden }),
    onTogglePinned: (path: string, pinned: boolean) => applyOverride(path, { pinned }),
    onDismissNew: (path: string) => applyOverride(path, {}),
    onSummaryUpdated: handleSummaryUpdated,
    onUndoMove: handleUndoMove,
  };

  // Only the top candidate counts: a "high" runner-up would mean the guess is
  // ambiguous, and the server already refuses to call anything high-confidence
  // unless it is clearly ahead of the alternatives.
  const confidentMoves = Object.values(triage ?? {})
    .map((t) => ({ from: t.path, to: t.candidates[0] }))
    .filter((m) => m.to?.confidence === "high");

  async function relocateAllConfident() {
    setBulkRelocating(true);
    try {
      // Sequential: each relocation re-keys sessions and triggers a rescan.
      for (const move of confidentMoves) {
        const res = await relocateProject(move.from, move.to.path);
        setProjects(res.projects);
        setLastScanAt(res.lastScanAt);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBulkRelocating(false);
    }
  }

  return (
    <PreferencesContext.Provider value={preferences}>
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Central Brain</h1>
          <p className="subtitle">Mission control for every project you're building.</p>
        </div>
        <div className="topbar__meta">
          <input
            className="topbar__search"
            type="search"
            placeholder="Search projects, summaries, todos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="scan-time">last scan {relativeTime(lastScanAt ?? undefined)}</span>
          <button onClick={handleRescan} disabled={scanning}>
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <button
            onClick={() => setSettingsOpen((open) => !open)}
            title="Settings"
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Sits under the search box because it is the same gesture: narrow the
          board down to the projects you mean. AND semantics, so stacking two
          chips gets more specific, not noisier. */}
      <div className="chips">
        {CHIPS.map((chip) => (
          <button
            key={chip.id}
            className={`chip${chips.has(chip.id) ? " chip--on" : ""}`}
            title={chip.title}
            aria-pressed={chips.has(chip.id)}
            onClick={() => toggleChip(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* A transient poll/save failure while good data is already on screen —
          degrade to a strip, not a full wipe. The 30s poll clears `error` on
          its next success, so this self-heals without the ✕. */}
      {error && (
        <div className="error-banner">
          <p className="error-banner__text">Server not reachable — showing the last good data. {error}</p>
          <button className="error-banner__dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* Step 1 of first-run onboarding, and the product's core "agent needs
          me" moment — shown before the key card. Self-hiding: renders only
          while a detected tool still needs its hooks installed or approved,
          and never alongside the settings panel, which embeds the same rows.
          Reports actionability up so the key card below knows to wait. */}
      {!settingsOpen && (
        <HooksPanel mode="onboarding" onOnboardingActionable={setHooksOnboardingActive} />
      )}

      {/* Step 2: the optional Anthropic-API-key card. First run with no key
          asks once, up top, where it cannot be missed — but only once hooks
          onboarding is out of the way (installed or dismissed), so the
          nice-to-have never outranks the core hook setup. Afterwards the
          same panel lives behind the topbar gear. */}
      {settings &&
        (settingsOpen ? (
          <ApiKeyPanel
            mode="settings"
            settings={settings}
            onStatusChange={handleApiKeyStatus}
            onPreferencesChange={handlePreferences}
            onClose={() => setSettingsOpen(false)}
          />
        ) : (
          showOnboarding && (
            <ApiKeyPanel mode="onboarding" settings={settings} onStatusChange={handleApiKeyStatus} />
          )
        ))}

      {/* Every project, not just the shown sections: an attention row must
          resolve its project's display name even when that project is hidden,
          dormant, or filtered out by the search box and chips. */}
      <AttentionPanel projects={projects} />
      <DigestPanel />

      {filtering ? (
        <ProjectGrid
          title="Matching projects"
          projects={matching}
          emptyLabel={
            chips.size > 0 ? "Nothing matches these filters." : "Nothing matches your search."
          }
          {...gridProps}
        />
      ) : (
        <>
          <ProjectGrid
            title="Active"
            projects={active}
            emptyLabel={
              // First run has nothing at all — say what to do about it rather
              // than reporting an empty window.
              projects.length === 0
                ? "No projects yet — start a Claude or Codex session in a repo."
                : `Nothing active in the last ${ACTIVE_WINDOW_DAYS} days.`
            }
            {...gridProps}
          />
          {/* The long tail, collapsed. Still one click from everything you own,
              so nothing is lost — it just stops competing with today's work. */}
          <ProjectGrid title="All projects" projects={dormant} collapsible {...gridProps} />
        </>
      )}
      {missing.length > 0 && (
        <ProjectGrid
          title="Missing from disk"
          projects={missing}
          collapsible
          headerAction={
            confidentMoves.length > 0 ? (
              <button className="section__action" onClick={relocateAllConfident} disabled={bulkRelocating}>
                {bulkRelocating
                  ? "Relocating…"
                  : `Relocate ${confidentMoves.length} confident match${
                      confidentMoves.length === 1 ? "" : "es"
                    }`}
              </button>
            ) : undefined
          }
          triage={triage ?? undefined}
          onRelocate={handleRelocate}
          {...gridProps}
        />
      )}
      <ProjectGrid title="Hidden" projects={hidden} collapsible {...gridProps} />
    </main>
    </PreferencesContext.Provider>
  );
}
