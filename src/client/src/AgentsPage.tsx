import { useMemo, useState } from "react";
import type { AttentionItem, Project } from "@shared/types";
import { openInVsCode } from "./api";
import { fleetRows, type AgentRow, type AgentStatus } from "./agents";
import { goToProject } from "./App";
import { relativeTime } from "./format";
import { useEditorName } from "./prefs";

interface Props {
  projects: Project[];
  attention: AttentionItem[];
}

const GROUPS: Array<{ status: AgentStatus; title: string; blurb: string }> = [
  { status: "waiting", title: "Waiting on you", blurb: "Blocked until you answer." },
  { status: "active", title: "Active", blurb: "Moved in the last 10 minutes." },
  { status: "idle", title: "Recent", blurb: "Quiet, from the last 48 hours." },
];

/**
 * The idle tail can be long (every session for two days); cap the initial
 * render and let the user ask for the rest. Waiting/active are never capped —
 * those are exactly the rows the page exists to show.
 */
const IDLE_PREVIEW = 15;

export default function AgentsPage({ projects, attention }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [showAllIdle, setShowAllIdle] = useState(false);
  const editorName = useEditorName();

  const rows = useMemo(() => fleetRows(projects, attention, Date.now()), [projects, attention]);

  function open(row: AgentRow) {
    setError(null);
    // Claude sessions deep-link to the exact chat; Codex opens the checkout
    // the session ran in (worktree-aware via the server's open route).
    openInVsCode(row.checkoutPath ?? row.projectPath, row.tool === "claude" ? row.sessionId : undefined).catch(
      (err) => setError(String((err as Error).message ?? err)),
    );
  }

  return (
    <div className="agents">
      <header className="agents__head">
        <div>
          <h1>Agents</h1>
          <p className="subtitle">Every Claude and Codex session across your projects, live state first.</p>
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

      {rows.length === 0 && (
        <p className="agents__empty">
          No sessions in the last 48 hours — start a Claude or Codex session in a repo and it appears here.
        </p>
      )}

      {GROUPS.map((group) => {
        const groupRows = rows.filter((r) => r.status === group.status);
        if (groupRows.length === 0) return null;
        const shown =
          group.status === "idle" && !showAllIdle ? groupRows.slice(0, IDLE_PREVIEW) : groupRows;
        return (
          <section key={group.status} className="agents__group">
            <h2 className="agents__group-title">
              {group.title} <span className="agents__count">{groupRows.length}</span>
              <span className="agents__blurb">{group.blurb}</span>
            </h2>
            <div className="agents__list">
              {shown.map((row) => (
                <div key={`${row.tool}:${row.sessionId}`} className={`agent-row agent-row--${row.status}`}>
                  <span className={`status-dot status-dot--${row.status}`} aria-hidden />
                  <span className={`agent-row__tool agent-row__tool--${row.tool}`}>
                    {row.tool === "claude" ? "Claude" : "Codex"}
                  </span>
                  <button
                    className="agent-row__project"
                    onClick={() => goToProject(row.projectPath)}
                    title={`Open the project page\n${row.projectPath}`}
                  >
                    {row.projectName}
                  </button>
                  <span className="agent-row__desc" title={row.label}>
                    {row.waitingOn ?? row.label ?? "—"}
                  </span>
                  <span className="agent-row__facts">
                    {row.branch && <span className="agent-row__fact" title="Branch">⎇ {row.branch}</span>}
                    {row.model && <span className="agent-row__fact" title="Model">{row.model}</span>}
                    {row.tokensUsed !== undefined && (
                      <span className="agent-row__fact" title="Tokens used">
                        {formatTokens(row.tokensUsed)}
                      </span>
                    )}
                  </span>
                  <span className="agent-row__age">{relativeTime(row.lastActivity)}</span>
                  <button
                    className="agent-row__open"
                    onClick={() => open(row)}
                    title={
                      row.tool === "claude"
                        ? `Jump to this chat in ${editorName}`
                        : `Open this checkout in ${editorName}`
                    }
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
            {group.status === "idle" && groupRows.length > IDLE_PREVIEW && !showAllIdle && (
              <button className="agents__more" onClick={() => setShowAllIdle(true)}>
                Show {groupRows.length - IDLE_PREVIEW} more
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tok`;
  return `${n} tok`;
}
