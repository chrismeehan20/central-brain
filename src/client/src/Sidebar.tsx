import { useEffect, useState } from "react";
import type { FleetCounts } from "./agents";
import { BotIcon, GridIcon, KanbanIcon, PanelIcon, PulseIcon } from "./Icons";

export type OsView = "overview" | "board" | "agents" | "activity";

/** Hash for each view. Overview keeps the bare hash so existing bookmarks and the tray popover land unchanged. */
export const VIEW_HASH: Record<OsView, string> = {
  overview: "",
  board: "#/board",
  agents: "#/agents",
  activity: "#/activity",
};

const COLLAPSED_KEY = "cb:sidebar-collapsed";

interface Props {
  /** The active view; "project" (the detail page) highlights Overview, which is where its back button lands. */
  view: OsView | "project";
  counts: FleetCounts;
}

interface NavItem {
  view: OsView;
  label: string;
  icon: () => React.JSX.Element;
}

const NAV: NavItem[] = [
  { view: "overview", label: "Overview", icon: GridIcon },
  { view: "board", label: "Mission Control", icon: KanbanIcon },
  { view: "agents", label: "Agents", icon: BotIcon },
  { view: "activity", label: "Activity", icon: PulseIcon },
];

export default function Sidebar({ view, counts }: Props) {
  // Collapse survives reloads but is per-browser, not a server preference:
  // it's about this window's width, not about how you use the product.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // private mode; the toggle still works for this page's lifetime
    }
  }, [collapsed]);

  const active = view === "project" ? "overview" : view;

  return (
    <nav className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`} aria-label="Views">
      <a className="sidebar__brand" href="#" title="Central Brain">
        <span className="sidebar__mark" aria-hidden>
          ◉
        </span>
        {!collapsed && (
          <span className="sidebar__name">
            Central Brain
            <span className="sidebar__tagline">agentic mission control</span>
          </span>
        )}
      </a>

      <div className="sidebar__nav">
        {NAV.map((item) => {
          const Icon = item.icon;
          // The fleet badges live on Agents: that's the view that answers them.
          const badges = item.view === "agents" && (
            <>
              {counts.waiting > 0 && (
                <span className="sidebar__badge sidebar__badge--waiting" title={`${counts.waiting} waiting on you`}>
                  {counts.waiting}
                </span>
              )}
              {counts.active > 0 && (
                <span className="sidebar__badge sidebar__badge--active" title={`${counts.active} active in the last 10 minutes`}>
                  {counts.active}
                </span>
              )}
            </>
          );
          return (
            <a
              key={item.view}
              className={`sidebar__item${active === item.view ? " sidebar__item--active" : ""}`}
              href={VIEW_HASH[item.view] || "#"}
              title={collapsed ? item.label : undefined}
              aria-current={active === item.view ? "page" : undefined}
            >
              <Icon />
              {!collapsed && <span className="sidebar__label">{item.label}</span>}
              {badges}
            </a>
          );
        })}
      </div>

      <button
        className="sidebar__collapse"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <PanelIcon />
        {!collapsed && <span className="sidebar__label">Collapse</span>}
      </button>
    </nav>
  );
}
