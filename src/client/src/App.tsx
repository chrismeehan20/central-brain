import { useEffect, useState } from "react";
import type { Project } from "@shared/types";
import { fetchProjects, triggerScan, updateOverride } from "./api";
import ProjectGrid from "./ProjectGrid";
import ProjectDetailPage from "./ProjectDetailPage";
import AttentionPanel from "./AttentionPanel";
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

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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

  if (error) {
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

  if (route) {
    return (
      <ProjectDetailPage
        path={route}
        project={projects.find((p) => p.path === route)}
        onBack={() => {
          window.location.hash = "";
        }}
      />
    );
  }

  const visible = projects.filter((p) => !p.hidden && !p.discovered);
  const discovered = projects.filter((p) => !p.hidden && p.discovered);
  const hidden = projects.filter((p) => p.hidden);

  function handleSummaryUpdated(path: string, summary: Project["summary"]) {
    setProjects((prev) => prev?.map((p) => (p.path === path ? { ...p, summary } : p)) ?? prev);
  }

  const gridProps = {
    onRename: (path: string, displayName: string) => applyOverride(path, { displayName }),
    onToggleHidden: (path: string, hidden: boolean) => applyOverride(path, { hidden }),
    onTogglePinned: (path: string, pinned: boolean) => applyOverride(path, { pinned }),
    onKeep: (path: string) => applyOverride(path, {}),
    onSummaryUpdated: handleSummaryUpdated,
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Central Brain</h1>
          <p className="subtitle">Mission control for every project you're building.</p>
        </div>
        <div className="topbar__meta">
          <span className="scan-time">last scan {relativeTime(lastScanAt ?? undefined)}</span>
          <button onClick={handleRescan} disabled={scanning}>
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      <AttentionPanel />

      <ProjectGrid title="Projects" projects={visible} {...gridProps} />
      <ProjectGrid
        title="Discovered — needs triage"
        projects={discovered}
        emptyLabel="Nothing new to triage."
        {...gridProps}
      />
      <ProjectGrid title="Hidden" projects={hidden} {...gridProps} />
    </main>
  );
}
