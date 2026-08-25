import { useEffect, useMemo, useState } from "react";
import type { ActivityEvent, Project, SourceTool } from "@shared/types";
import { fetchActivity } from "./api";
import { goToProject } from "./App";
import { relativeTime } from "./format";

interface Props {
  projects: Project[];
}

type ToolFilter = "all" | SourceTool;

/** Render cap. The server keeps 500; past a couple hundred rows the feed is archaeology, not observability. */
const MAX_ROWS = 250;

export default function ActivityPage({ projects }: Props) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ToolFilter>("all");

  // Backlog over REST, then deltas over this page's own SSE subscription.
  // Opened here rather than shared with App's attention stream because the
  // feed only matters while this view is mounted — an always-on subscription
  // would stream every hook event to a tab showing the Overview grid.
  useEffect(() => {
    let cancelled = false;
    fetchActivity()
      .then((res) => {
        if (!cancelled) {
          setEvents(res.events);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String((err as Error).message ?? err));
      });

    const source = new EventSource("/api/stream");
    source.addEventListener("activity", (e) => {
      try {
        const event: ActivityEvent = JSON.parse((e as MessageEvent).data);
        setEvents((prev) => (prev ? [...prev, event] : [event]));
      } catch {
        // ignore malformed frame
      }
    });
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  const nameByPath = useMemo(() => {
    const map = new Map(projects.map((p) => [p.path, p.displayName]));
    for (const p of projects) {
      for (const c of p.checkouts ?? []) {
        if (!map.has(c.path)) map.set(c.path, p.displayName);
      }
    }
    return map;
  }, [projects]);

  const shown = useMemo(() => {
    const filtered = (events ?? []).filter((e) => filter === "all" || e.tool === filter);
    return filtered.slice(-MAX_ROWS).reverse(); // newest first
  }, [events, filter]);

  return (
    <div className="activity-page">
      <header className="activity-page__head">
        <div>
          <h1>Activity</h1>
          <p className="subtitle">The live hook-event stream — what your fleet has been doing, newest first.</p>
        </div>
        <div className="chips">
          {(["all", "claude", "codex"] as const).map((id) => (
            <button
              key={id}
              className={`chip${filter === id ? " chip--on" : ""}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {id === "all" ? "All" : id === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <p className="error-banner__text">{error}</p>
          <button className="error-banner__dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {events !== null && shown.length === 0 && (
        <p className="activity-page__empty">
          Nothing yet. Events appear here as your hooks fire — install them from the ⚙ settings panel if this
          stays empty while agents are running.
        </p>
      )}

      <ol className="feed">
        {shown.map((event) => {
          const projectName = event.projectPath
            ? nameByPath.get(event.projectPath) ??
              event.projectPath.split("/").filter(Boolean).pop()
            : undefined;
          return (
            <li key={event.id} className={`feed__row feed__row--${event.event}`}>
              <span className={`feed__tool feed__tool--${event.tool}`} aria-hidden />
              <span className="feed__body">
                {event.projectPath && projectName ? (
                  <button
                    className="feed__project"
                    onClick={() => goToProject(event.projectPath!)}
                    title={event.projectPath}
                  >
                    {projectName}
                  </button>
                ) : (
                  <span className="feed__project feed__project--unknown">unknown project</span>
                )}
                <span className="feed__message">{event.message}</span>
              </span>
              <span className="feed__age" title={event.at}>
                {relativeTime(event.at)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
