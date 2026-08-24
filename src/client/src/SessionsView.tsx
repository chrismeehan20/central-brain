import { useState } from "react";
import type { AttentionItem, Project } from "@shared/types";
import { openInVsCode } from "./api";
import { goToProject } from "./App";
import { partitionLiveSessions, type LiveSessionRow } from "./views";
import { relativeTime } from "./format";
import { useEditorName } from "./prefs";

/**
 * Sessions that look live, in two honest tiers: blocked on you (a hook
 * attention row proves the agent is waiting) and recently active. There is no
 * "running" flag anywhere in the data, so the headers never claim one.
 */
export default function SessionsView({
  projects,
  attentionItems,
  query,
}: {
  projects: Project[];
  attentionItems: AttentionItem[];
  query: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const editorName = useEditorName();

  const q = query.trim().toLowerCase();
  const matches = (r: LiveSessionRow) =>
    !q ||
    r.projectName.toLowerCase().includes(q) ||
    (r.session.summary ?? r.session.firstPrompt ?? "").toLowerCase().includes(q) ||
    (r.session.gitBranch ?? "").toLowerCase().includes(q);

  const { waiting, recent } = partitionLiveSessions(projects, attentionItems, new Date());
  const waitingRows = waiting.filter(matches);
  const recentRows = recent.filter(matches);

  function jump(row: LiveSessionRow) {
    setError(null);
    // Same routing as the attention panel: Claude gets the chat deep link,
    // Codex just gets the project window. A folded-in worktree session must
    // open at the checkout it actually ran in.
    const path = row.session.checkoutPath ?? row.projectPath;
    openInVsCode(path, row.session.tool === "claude" ? row.session.sessionId : undefined).catch(
      (err) => setError(String((err as Error).message ?? err))
    );
  }

  function renderRows(rows: LiveSessionRow[], openable: boolean) {
    return (
      <div className="xlist">
        {rows.map((row) => {
          const text = row.session.summary ?? row.session.firstPrompt ?? "(session)";
          const lead = (
            <>
              <span className={`activity__label activity__label--${row.session.tool}`}>
                {row.session.tool}
              </span>
              <span className="xlist__text">{text}</span>
              {row.attention?.message && (
                <span className="xlist__tag xlist__tag--attention">{row.attention.message}</span>
              )}
            </>
          );
          return (
            <div key={`${row.projectPath}:${row.session.sessionId}`} className="xlist__row">
              {openable ? (
                <button
                  className="xlist__lead"
                  title={
                    row.session.tool === "claude"
                      ? `Jump to this chat in ${editorName} — the agent is waiting there`
                      : `Open this project in ${editorName} — the agent is waiting there`
                  }
                  onClick={() => jump(row)}
                >
                  {lead}
                </button>
              ) : (
                <div className="xlist__lead">{lead}</div>
              )}
              <button
                className="xlist__project"
                title={`Go to ${row.projectName}`}
                onClick={() => goToProject(row.projectPath)}
              >
                {row.projectName}
              </button>
              <span className="xlist__age">{relativeTime(row.session.lastActivity)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <section className="section">
      <h2 className="section__title">
        Waiting on you {waitingRows.length > 0 && <span className="section__count">{waitingRows.length}</span>}
      </h2>
      {waitingRows.length === 0 ? (
        <p className="xlist__empty">No agent is blocked on you right now.</p>
      ) : (
        renderRows(waitingRows, true)
      )}
      <h2 className="section__title">Active in the last hour</h2>
      {recentRows.length === 0 ? (
        <p className="xlist__empty">
          {q ? "No sessions match your search." : "No sessions look live right now."}
        </p>
      ) : (
        renderRows(recentRows, false)
      )}
      {error && <p className="attention__error">{error}</p>}
    </section>
  );
}
