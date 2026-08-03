import { useState } from "react";
import type { MissingProjectTriage, Project } from "@shared/types";
import { relativeTime } from "./format";
import { openInVsCode, summarizeProject } from "./api";
import { goToProject } from "./App";
import { useDocHref, useEditorName } from "./prefs";
import { EyeIcon, EyeOffIcon, PinIcon } from "./Icons";

interface Props {
  project: Project;
  onRename: (path: string, displayName: string) => void;
  onToggleHidden: (path: string, hidden: boolean) => void;
  onTogglePinned: (path: string, pinned: boolean) => void;
  onDismissNew?: (path: string) => void;
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
  onDismissNew,
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
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showCheckouts, setShowCheckouts] = useState(false);
  const counts = toolCounts(project);
  const docHref = useDocHref();
  const editorName = useEditorName();

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

  /**
   * Two channels instead of one row of pills.
   *
   * `flags` are states that should make you look — a folder that vanished, CI
   * that went red. Those keep a coloured pill, and they are the only things
   * that get one. Everything else is `meta`: true, useful, and not urgent, so
   * it reads as one quiet line. A card previously carried up to eight pills,
   * which left nothing able to stand out.
   */
  const ci = project.github?.ciStatus?.toLowerCase();
  const flags: { kind: string; label: string; title?: string }[] = [];
  if (project.missing) {
    flags.push({
      kind: "gone",
      label: "folder gone",
      title: "This folder no longer exists on disk (moved or deleted)",
    });
  }
  if (ci === "failure") {
    flags.push({
      kind: "failing",
      title: `CI is red on ${project.github?.branch ?? "the current branch"} — the code you have checked out is broken`,
      label: "CI failing",
    });
  }
  // A red sibling checkout gets its own flag only when the primary isn't
  // already flying one — one red pill per card, naming where the fire is.
  const redSibling = (project.checkouts ?? []).find(
    (c) => !c.primary && c.ciStatus?.toLowerCase() === "failure"
  );
  if (ci !== "failure" && redSibling) {
    flags.push({
      kind: "failing",
      title: `CI is red on ${redSibling.branch ?? redSibling.path} — a folded checkout of this repo`,
      label: "CI failing (checkout)",
    });
  }
  /**
   * Kept separate from the branch flag on purpose: red CI on your branch means
   * go fix the code in front of you, while a red open PR means go look at
   * something you already pushed. Same colour family, different call to action.
   */
  const prFailing = (project.github?.openPrs ?? []).some(
    (pr) => !pr.isDraft && pr.ciStatus?.toLowerCase() === "failure"
  );
  if (prFailing) {
    flags.push({
      kind: "pr-failing",
      title: "At least one open (non-draft) PR has failing checks",
      label: "PR checks failing",
    });
  }

  const prCount = project.github?.openPrs?.length ?? 0;
  const meta = [
    counts.claude > 0 ? `${counts.claude} Claude` : "",
    counts.codex > 0 ? `${counts.codex} Codex` : "",
    // "uncommitted" rather than a bare dot: a status dot makes the reader guess.
    project.github?.branch
      ? project.github.dirty
        ? `${project.github.branch}, uncommitted`
        : project.github.branch
      : "",
    prCount > 0 ? `${prCount} open PR${prCount === 1 ? "" : "s"}` : "",
    // Current-branch CI when it isn't red — "CI success" / "CI pending". Red
    // gets promoted out of this quiet line and into a flag above.
    ci && ci !== "failure" ? `CI ${ci}` : "",
  ].filter(Boolean);

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

  async function openProject() {
    setOpening(true);
    setOpenError(null);
    try {
      await openInVsCode(project.path);
    } catch (err) {
      setOpenError(String((err as Error).message ?? err));
    } finally {
      setOpening(false);
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
    <div
      className={`card${project.pinned ? " card--pinned" : ""}${project.hidden ? " card--hidden" : ""}`}
    >
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
        {project.discovered && onDismissNew && (
          <button
            className="card__new"
            title="Newly discovered — click to dismiss"
            aria-label={`Dismiss New badge for ${project.displayName}`}
            onClick={() => onDismissNew(project.path)}
          >
            New
          </button>
        )}
        <span className="card__activity">{relativeTime(project.lastActivity)}</span>
      </div>

      {flags.length > 0 && (
        <div className="card__flags">
          {flags.map((flag) => (
            <span key={flag.label} className={`flag flag--${flag.kind}`} title={flag.title}>
              {flag.label}
            </span>
          ))}
        </div>
      )}

      {meta.length > 0 && (
        <p className="card__meta" title={project.github?.lastCommitMessage}>
          {meta.join(" · ")}
        </p>
      )}

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
                    className={`relocate__confidence relocate__confidence--${chosen.confidence}`}
                    title={`${chosen.confidence} confidence — ${chosen.reason}`}
                  >
                    {chosen.confidence} confidence
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

      {/* Several on-disk checkouts of one repository fold into this card;
          the rows expand on demand so a worktree-heavy repo stays one line
          tall until you ask. Each row opens its own folder. */}
      {project.checkouts && project.checkouts.length > 1 && (
        <div className="checkouts">
          <button className="checkouts__toggle" onClick={() => setShowCheckouts((v) => !v)}>
            <span className="section__caret">{showCheckouts ? "▾" : "▸"}</span>{" "}
            {project.checkouts.length} checkouts of this repo
          </button>
          {showCheckouts && (
            <div className="checkouts__list">
              {project.checkouts.map((c) => (
                <div key={c.path} className="checkouts__row">
                  <span className="checkouts__branch" title={c.path}>
                    {c.branch ?? c.path.split("/").filter(Boolean).pop()}
                    {c.primary ? " (primary)" : ""}
                  </span>
                  <span className="checkouts__meta">
                    {c.sessionCount} session{c.sessionCount === 1 ? "" : "s"} ·{" "}
                    {relativeTime(c.lastActivity)}
                    {c.dirty ? " · uncommitted" : ""}
                    {c.ciStatus?.toLowerCase() === "failure" && (
                      <span className="checkouts__ci-red"> · CI failing</span>
                    )}
                  </span>
                  <button
                    className="checkouts__open"
                    title={`Open ${c.path} in ${editorName}`}
                    onClick={() => openInVsCode(c.path).catch((err) => setOpenError(String((err as Error).message ?? err)))}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
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

      {/* Filenames, not statuses — so they read as a list of links rather than
          a wall of tags. Still links: clicking opens the file in VS Code. */}
      {project.markdown.length > 0 && (
        <p className="card__docs">
          {docs.map((doc, i) => (
            <span key={doc.file}>
              {i > 0 && <span className="card__doc-sep">, </span>}
              <a className="card__doc" href={docHref(doc.file)} title={doc.file}>
                {doc.relativePath}
              </a>
            </span>
          ))}
          {hiddenDocCount > 0 && (
            <>
              <span className="card__doc-sep">, </span>
              <button className="card__doc-more" onClick={() => setShowAllDocs(true)}>
                +{hiddenDocCount} more
              </button>
            </>
          )}
          {showAllDocs && project.markdown.length > MAX_DOC_CHIPS && (
            <>
              <span className="card__doc-sep"> </span>
              <button className="card__doc-more" onClick={() => setShowAllDocs(false)}>
                show fewer
              </button>
            </>
          )}
        </p>
      )}

      <div className="card__summary">
        {project.summary?.text ? (
          <p title={`generated ${relativeTime(project.summary.generatedAt)}`}>{project.summary.text}</p>
        ) : project.summary?.insufficientEvidence ? (
          // The model looked and had nothing grounded to say — different from
          // never having looked, and worth distinguishing on the card.
          <p className="card__summary--empty">Not enough activity to summarize yet.</p>
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

      {project.missing ? (
        <div className="card__path" title={project.path}>
          {project.path}
        </div>
      ) : (
        <button
          className="card__path card__path--open"
          title={`Open this folder in ${editorName}`}
          onClick={openProject}
          disabled={opening}
        >
          {project.path}
        </button>
      )}
      {openError && <span className="card__summary-error">{openError}</span>}

      <div className="card__actions">
        {!project.missing && (
          <button onClick={openProject} disabled={opening} title={`Open this folder in ${editorName}`}>
            {opening ? "Opening…" : editorName}
          </button>
        )}
        <button className="card__details" onClick={() => goToProject(project.path)}>
          Details →
        </button>
        <div className="card__actions-right">
          <button
            className={`card__icon-btn${project.pinned ? " card__icon-btn--active" : ""}`}
            onClick={() => onTogglePinned(project.path, !project.pinned)}
            title={project.pinned ? "Unpin project" : "Pin project"}
            aria-label={project.pinned ? "Unpin project" : "Pin project"}
            aria-pressed={project.pinned}
          >
            <PinIcon filled={project.pinned} />
          </button>
          <button
            className="card__icon-btn"
            onClick={() => onToggleHidden(project.path, !project.hidden)}
            title={project.hidden ? "Unhide project" : "Hide project"}
            aria-label={project.hidden ? "Unhide project" : "Hide project"}
          >
            {project.hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}
