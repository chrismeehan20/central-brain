import { useEffect, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  AttentionItem,
  DashboardView,
  MissingProjectTriage,
  Preferences,
  Project,
  SettingsResponse,
} from "@shared/types";
import { DASHBOARD_VIEWS, DEFAULT_PREFERENCES } from "@shared/types";
import {
  fetchProjects,
  fetchRelocations,
  fetchSettings,
  relocateProject,
  triggerScan,
  updateOverride,
  updatePreferences,
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
import OpenPrsView from "./OpenPrsView";
import ActivityView from "./ActivityView";
import SessionsView from "./SessionsView";
import AttentionPanel from "./AttentionPanel";
import ApiKeyPanel from "./ApiKeyPanel";
import DigestPanel from "./DigestPanel";
import HooksPanel from "./HooksPanel";
import { relativeTime } from "./format";

const DETAIL_PREFIX = "#/project/";
const VIEW_PREFIX = "#/view/";

type Route =
  | { kind: "home" }
  | { kind: "project"; path: string }
  | { kind: "view"; view: DashboardView };

function parseRoute(): Route {
  const hash = window.location.hash;
  if (hash.startsWith(DETAIL_PREFIX)) {
    return { kind: "project", path: decodeURIComponent(hash.slice(DETAIL_PREFIX.length)) };
  }
  if (hash.startsWith(VIEW_PREFIX)) {
    const view = hash.slice(VIEW_PREFIX.length);
    if ((DASHBOARD_VIEWS as readonly string[]).includes(view)) {
      return { kind: "view", view: view as DashboardView };
    }
  }
  return { kind: "home" };
}

export function goToProject(path: string): void {
  window.location.hash = DETAIL_PREFIX + encodeURIComponent(path);
}

export function goToView(view: DashboardView): void {
  // The project grid is the app's home, so it keeps the bare hash rather than
  // getting a redundant #/view/projects.
  window.location.hash = view === "projects" ? "" : VIEW_PREFIX + view;
}

const VIEW_TABS: Array<{ id: DashboardView; label: string; title: string }> = [
  { id: "projects", label: "Projects", title: "The project grid" },
  { id: "prs", label: "Open PRs", title: "Every open pull request across your projects" },
  { id: "activity", label: "Activity", title: "Recent sessions and commits across your projects" },
  { id: "sessions", label: "Sessions", title: "Agent sessions that look live right now" },
];

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [route, setRoute] = useState<Route>(parseRoute());
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
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

  // The attention stream lives here rather than in AttentionPanel: the
  // consolidated PR and session views need the same rows for their badges and
  // "waiting on you" tier, and one EventSource beats three.
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("attention", (e) => {
      try {
        setAttentionItems(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore malformed frame
      }
    });
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => source.close();
  }, []);

  function loadSettings() {
    // Quiet on failure: a settings fetch that fails must not replace the whole
    // dashboard with an error, since nothing else depends on it.
    fetchSettings()
      .then(setSettings)
      .catch(() => {});
  }

  useEffect(loadSettings, []);

  // A fresh window with nothing in the hash lands on the preferred view, once
  // settings arrive. Only once: after that the hash is the source of truth.
  const appliedInitialView = useRef(false);
  useEffect(() => {
    if (appliedInitialView.current || !settings) return;
    appliedInitialView.current = true;
    if (!window.location.hash || window.location.hash === "#") {
      goToView(settings.preferences.dashboardView);
    }
  }, [settings]);

  /** After a save/remove the daily-call counters are stale too, so refetch the lot. */
  function handleApiKeyStatus(apiKey: ApiKeyStatus) {
    setSettings((prev) => (prev ? { ...prev, apiKey } : prev));
    loadSettings();
  }

  function handlePreferences(preferences: Preferences) {
    setSettings((prev) => (prev ? { ...prev, preferences } : prev));
  }

  function switchView(view: DashboardView) {
    goToView(view);
    // Remember where the next fresh window starts. Fire-and-forget: a failed
    // save must not interrupt navigation, and nothing else depends on it.
    if (settings && settings.preferences.dashboardView !== view) {
      handlePreferences({ ...settings.preferences, dashboardView: view });
      updatePreferences({ dashboardView: view }).catch(() => {});
    }
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

  if (route.kind === "project") {
    const detailPath = route.path;
    return (
      <PreferencesContext.Provider value={preferences}>
        <ProjectDetailPage
          path={detailPath}
          project={projects.find((p) => p.path === detailPath)}
          onBack={() => {
            window.location.hash = "";
          }}
        />
      </PreferencesContext.Provider>
    );
  }

  const view: DashboardView = route.kind === "view" ? route.view : "projects";

  const q = query.trim().toLowerCase();
  const matches = (p: Project) =>
    !q ||
    p.displayName.toLowerCase().includes(q) ||
    p.path.toLowerCase().includes(q) ||
    (p.summary?.text ?? "").toLowerCase().includes(q) ||
    (p.openItems ?? []).some((t) => t.toLowerCase().includes(q)) ||
    // Sibling checkouts folded into this card should be findable by their
    // own paths and branch names too.
    (p.checkouts ?? []).some(
      (c) => c.path.toLowerCase().includes(q) || (c.branch ?? "").toLowerCase().includes(q)
    );

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

      {/* The board's top-level lens: the project grid, or one of the
          consolidated cross-project lists. Hidden projects stay out of all of
          them (see views.ts). */}
      <div className="viewswitch" role="tablist">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`viewswitch__tab${view === tab.id ? " viewswitch__tab--on" : ""}`}
            title={tab.title}
            aria-pressed={view === tab.id}
            onClick={() => switchView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sits under the search box because it is the same gesture: narrow the
          board down to the projects you mean. AND semantics, so stacking two
          chips gets more specific, not noisier. Project-card predicates, so
          only the Projects view shows them. */}
      {view === "projects" && (
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
      )}

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
      <AttentionPanel projects={projects} items={attentionItems} onItemsChange={setAttentionItems} />
      <DigestPanel />

      {view === "prs" ? (
        <OpenPrsView projects={projects} attentionItems={attentionItems} query={query} />
      ) : view === "activity" ? (
        <ActivityView projects={projects} query={query} />
      ) : view === "sessions" ? (
        <SessionsView projects={projects} attentionItems={attentionItems} query={query} />
      ) : filtering ? (
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
      {view === "projects" && missing.length > 0 && (
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
      {view === "projects" && (
        <ProjectGrid title="Hidden" projects={hidden} collapsible {...gridProps} />
      )}
    </main>
    </PreferencesContext.Provider>
  );
}
