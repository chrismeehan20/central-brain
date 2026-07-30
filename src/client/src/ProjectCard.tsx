import { useState } from "react";
import type { MissingProjectTriage, Project } from "@shared/types";
import { relativeTime } from "./format";
import { summarizeProject } from "./api";
import { goToProject } from "./App";

interface Props {
  project: Project;
  onRename: (path: string, displayName: string) => void;
  onToggleHidden: (path: string, hidden: boolean) => void;
  onTogglePinned: (path: string, pinned: boolean) => void;
  onKeep?: (path: string) => void;
  onSummaryUpdated?: (path: string, summary: Project["summary"]) => void;
  /** Present only for missing projects, once the search for a new home has run. */
  triage?: MissingProjectTriage;
  onRelocate?: (from: string, to: string) => Promise<void>;
  onUndoMove?: (oldPaths: string[]) => Promise<void>;
}

function toolCounts(project: Project) {
  const counts = { claude: 0, codex: 0 };
  for (const s of project.sessions) counts[s.tool]++;
  return counts;
}

export default function ProjectCard({
  project,
  onRename,
  onToggleHidden,
  onTogglePinned,
  onKeep,
  onSummaryUpdated,
  triage,
  onRelocate,
  onUndoMove,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.displayName);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [showAllDocs, setShowAllDocs] = useState(false);
  const [chosenTarget, setChosenTarget] = useState<string | null>(null);
  const [relocating, setRelocating] = useState(false);
  const [relocateError, setRelocateError] = useState<string | null>(null);
  const counts = toolCounts(project);

  const candidates = triage?.candidates ?? [];
  const target = chosenTarget ?? candidates[0]?.path ?? null;
  const chosen = candidates.find((c) => c.path === target);

  async function runRelocate() {
    if (!target || !onRelocate) return;
    setRelocating(true);
    setRelocateError(null);
    try {
      await onRelocate(project.path, target);
    } catch (err) {
      setRelocateError(String((err as Error).message ?? err));
    } finally {
      setRelocating(false);
    }
  }

  const MAX_DOC_CHIPS = 4;
  const docs = showAllDocs ? project.markdown : project.markdown.slice(0, MAX_DOC_CHIPS);
  const hiddenDocCount = project.markdown.length - docs.length;

  async function refreshSummary() {
    setSummarizing(true);
    setSummaryError(null);
    try {
      const { summary } = await summarizeProject(project.path);
      onSummaryUpdated?.(project.path, summary);
    } catch (err) {
      setSummaryError(String((err as Error).message ?? err));
    } finally {
      setSummarizing(false);
    }
  }

  function commitRename() {
    setEditing(false);
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== project.displayName) {
      onRename(project.path, trimmed);
    } else {
      setNameDraft(project.displayName);
    }
  }

  return (
    <div className={`card${project.pinned ? " card--pinned" : ""}`}>
      <div className="card__header">
        {editing ? (
          <input
            autoFocus
            className="card__name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setNameDraft(project.displayName);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button className="card__name" onClick={() => setEditing(true)} title="Click to rename">
            {project.displayName}
          </button>
        )}
        <span className="card__activity">{relativeTime(project.lastActivity)}</span>
      </div>

      <div className="card__badges">
        {project.missing && (
          <span className="badge badge--missing" title="This folder no longer exists on disk (moved or deleted)">
            folder gone
          </span>
        )}
        {counts.claude > 0 && <span className="badge badge--claude">Claude ×{counts.claude}</span>}
        {counts.codex > 0 && <span className="badge badge--codex">Codex ×{counts.codex}</span>}
        {project.github?.branch && (
          <span className="badge badge--git" title={project.github.lastCommitMessage}>
            {project.github.branch}
            {project.github.dirty ? " •" : ""}
          </span>
        )}
        {!!project.github?.openPrs?.length && (
          <span className="badge badge--pr">PR ×{project.github.openPrs.length}</span>
        )}
        {project.github?.ciStatus && (
          <span className={`badge badge--ci badge--ci-${project.github.ciStatus.toLowerCase()}`}>
            {project.github.ciStatus}
          </span>
        )}
      </div>

      {project.missing && onRelocate && (
        <div className="relocate">
          {!triage ? (
            <p className="relocate__status">Looking for where this folder went…</p>
          ) : candidates.length === 0 ? (
            <p className="relocate__status">
              No folder with this name found in your code directories. It was probably deleted —
              Hide it to clear it out.
            </p>
          ) : (
            <>
              <div className="relocate__header">
                <span>Looks like it moved to</span>
                {chosen && (
                  <span
                    className={`badge badge--confidence-${chosen.confidence}`}
                    title={`${chosen.confidence} confidence — ${chosen.reason}`}
                  >
                    {chosen.confidence}
                  </span>
                )}
              </div>
              {candidates.length === 1 ? (
                <div className="relocate__path" title={candidates[0].path}>
                  {candidates[0].path}
                </div>
              ) : (
                <select
                  className="relocate__select"
                  value={target ?? ""}
                  onChange={(e) => setChosenTarget(e.target.value)}
                >
                  {candidates.map((c) => (
                    <option key={c.path} value={c.path}>
                      {c.path}
                    </option>
                  ))}
                </select>
              )}
              <div className="relocate__actions">
                <button className="relocate__confirm" onClick={runRelocate} disabled={relocating}>
                  {relocating ? "Relocating…" : "Relocate here"}
                </button>
                {chosen && <span className="relocate__reason">{chosen.reason}</span>}
              </div>
              {relocateError && <span className="card__summary-error">{relocateError}</span>}
            </>
          )}
        </div>
      )}

      {project.mergedFrom && project.mergedFrom.length > 0 && onUndoMove && (
        <div className="relocate relocate--merged">
          <span title={project.mergedFrom.join("\n")}>
            History merged from {project.mergedFrom.length} old path
            {project.mergedFrom.length === 1 ? "" : "s"}
          </span>
          <button className="relocate__undo" onClick={() => onUndoMove(project.mergedFrom ?? [])}>
            Undo move
          </button>
        </div>
      )}

      {project.markdown.length > 0 && (
        <div className="card__docs">
          {docs.map((doc) => (
            <a
              key={doc.file}
              className="doc-chip"
              href={`vscode://file/${encodeURI(doc.file)}`}
              title={doc.file}
            >
              {doc.relativePath}
            </a>
          ))}
          {hiddenDocCount > 0 && (
            <button className="doc-chip doc-chip--more" onClick={() => setShowAllDocs(true)}>
              +{hiddenDocCount} more
            </button>
          )}
          {showAllDocs && project.markdown.length > MAX_DOC_CHIPS && (
            <button className="doc-chip doc-chip--more" onClick={() => setShowAllDocs(false)}>
              show fewer
            </button>
          )}
        </div>
      )}

      <div className="card__summary">
        {project.summary?.text ? (
          <p title={`generated ${relativeTime(project.summary.generatedAt)}`}>{project.summary.text}</p>
        ) : (
          <p className="card__summary--empty">No AI summary yet.</p>
        )}
        <button className="card__summary-refresh" onClick={refreshSummary} disabled={summarizing}>
          {summarizing ? "Summarizing…" : "Refresh"}
        </button>
        {(summaryError ?? project.summary?.lastError) && (
          <span className="card__summary-error">{summaryError ?? project.summary?.lastError}</span>
        )}
      </div>

      <div className="card__path" title={project.path}>
        {project.path}
      </div>

      <div className="card__actions">
        {project.discovered && onKeep && (
          <button className="card__keep" onClick={() => onKeep(project.path)}>
            Keep
          </button>
        )}
        <button className="card__details" onClick={() => goToProject(project.path)}>
          Details →
        </button>
        <button onClick={() => onTogglePinned(project.path, !project.pinned)}>
          {project.pinned ? "Unpin" : "Pin"}
        </button>
        <button onClick={() => onToggleHidden(project.path, !project.hidden)}>
          {project.hidden ? "Unhide" : "Hide"}
        </button>
      </div>
    </div>
  );
}
