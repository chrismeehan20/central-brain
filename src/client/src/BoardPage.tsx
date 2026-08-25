import { useEffect, useMemo, useState } from "react";
import type { AttentionItem, BoardCard, BoardColumnId, Project } from "@shared/types";
import { BOARD_COLUMNS } from "@shared/types";
import {
  createBoardCard,
  deleteBoardCard,
  dispatchBoardCard,
  fetchBoard,
  moveBoardCard,
  openInVsCode,
  updateBoardCard,
} from "./api";
import { fleetRows, projectAgentStatus, type AgentRow, type AgentStatus } from "./agents";
import { goToProject } from "./App";
import { relativeTime } from "./format";
import { PlusIcon, TrashIcon } from "./Icons";

/** Multi-tab convergence only; every mutation already returns the fresh list. */
const REFRESH_MS = 60_000;

const STATUS_COPY: Record<AgentStatus, string> = {
  waiting: "waiting on you",
  active: "agent active",
  idle: "idle",
};

interface Props {
  projects: Project[];
  attention: AttentionItem[];
}

interface DropTarget {
  column: BoardColumnId;
  /** Insertion rank among the column's rendered cards (dragged card included). */
  index: number;
}

export default function BoardPage({ projects, attention }: Props) {
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [composing, setComposing] = useState<BoardColumnId | null>(null);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  function load() {
    fetchBoard()
      .then((res) => {
        setCards(res.cards);
        setError(null);
      })
      .catch((err) => setError(String((err as Error).message ?? err)));
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  // Live agent state, recomputed per render tick: cards never store status,
  // they borrow it from the fleet at paint time.
  const rows = useMemo(() => fleetRows(projects, attention, Date.now()), [projects, attention]);
  const live = rows.filter((r) => r.status !== "idle");

  const nameByPath = useMemo(
    () => new Map(projects.map((p) => [p.path, p.displayName])),
    [projects],
  );
  // Link targets: anything on disk. Hidden projects stay linkable — hiding
  // curates the Overview grid, it doesn't unmake the project.
  const linkable = useMemo(
    () =>
      projects
        .filter((p) => !p.missing)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [projects],
  );

  const byColumn = useMemo(() => {
    const map = new Map<BoardColumnId, BoardCard[]>(BOARD_COLUMNS.map((c) => [c.id, []]));
    for (const card of cards ?? []) map.get(card.column)?.push(card);
    return map;
  }, [cards]);

  async function mutate(run: () => Promise<{ cards: BoardCard[] }>) {
    setError(null);
    try {
      const res = await run();
      setCards(res.cards);
    } catch (err) {
      setError(String((err as Error).message ?? err));
      // The optimistic state may now be wrong; the server's list is the truth.
      load();
    }
  }

  async function submitDraft(column: BoardColumnId) {
    const title = draft.trim();
    if (!title) {
      setComposing(null);
      return;
    }
    setDraft("");
    await mutate(() => createBoardCard({ title, column }));
  }

  function handleDrop() {
    if (!dragId || !dropTarget || !cards) return;
    const card = cards.find((c) => c.id === dragId);
    setDragId(null);
    const target = dropTarget;
    setDropTarget(null);
    if (!card) return;

    // The server ranks against the column WITHOUT the moving card; the drop
    // index was computed against the rendered column, which still shows it.
    let index = target.index;
    if (card.column === target.column) {
      const columnIds = (byColumn.get(target.column) ?? []).map((c) => c.id);
      const from = columnIds.indexOf(card.id);
      if (from >= 0 && from < index) index -= 1;
      if (from === index) return; // dropped where it already was
    }

    // Optimistic splice so the card doesn't snap back while the save runs.
    setCards((prev) => {
      if (!prev) return prev;
      const rest = prev.filter((c) => c.id !== card.id);
      const siblings = rest.map((c, i) => ({ c, i })).filter(({ c }) => c.column === target.column);
      const clamped = Math.min(index, siblings.length);
      const insertAt =
        clamped < siblings.length
          ? siblings[clamped].i
          : siblings.length > 0
            ? siblings[siblings.length - 1].i + 1
            : rest.length;
      const moved = { ...card, column: target.column };
      return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
    });
    void mutate(() => moveBoardCard(card.id, target.column, index));
  }

  function openAgent(row: AgentRow) {
    setError(null);
    openInVsCode(row.projectPath, row.tool === "claude" ? row.sessionId : undefined).catch((err) =>
      setError(String((err as Error).message ?? err)),
    );
  }

  return (
    <div className="board">
      <header className="board__head">
        <div>
          <h1>Mission Control</h1>
          <p className="subtitle">One card per piece of work; live lanes light up as your agents move.</p>
        </div>
      </header>

      {/* The fleet strip: every non-idle agent, one chip each. This is the
          "monitor many agents at a glance" surface — click lands you in the
          exact chat that's moving (or stuck). */}
      {live.length > 0 && (
        <div className="board__fleet">
          {live.map((row) => (
            <button
              key={`${row.tool}:${row.sessionId}`}
              className={`fleet-chip fleet-chip--${row.status}`}
              title={`${row.waitingOn ?? STATUS_COPY[row.status]} — ${row.checkoutPath ?? row.projectPath}`}
              onClick={() => openAgent(row)}
            >
              <span className={`status-dot status-dot--${row.status}`} aria-hidden />
              <span className="fleet-chip__project">{row.projectName}</span>
              <span className={`fleet-chip__tool fleet-chip__tool--${row.tool}`}>
                {row.tool === "claude" ? "Claude" : "Codex"}
              </span>
              {row.branch && <span className="fleet-chip__branch">{row.branch}</span>}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="error-banner">
          <p className="error-banner__text">{error}</p>
          <button className="error-banner__dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="board__columns">
        {BOARD_COLUMNS.map((column) => {
          const columnCards = byColumn.get(column.id) ?? [];
          return (
            <section
              key={column.id}
              className={`board-col${
                dropTarget?.column === column.id ? " board-col--drop" : ""
              }`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                // Hovering the column's empty space means "append".
                if (dropTarget?.column !== column.id || dropTarget.index !== columnCards.length) {
                  setDropTarget({ column: column.id, index: columnCards.length });
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop();
              }}
            >
              <header className="board-col__head" title={column.hint}>
                <h2>{column.label}</h2>
                <span className="board-col__count">{columnCards.length}</span>
                <button
                  className="board-col__add"
                  title={`Add a card to ${column.label}`}
                  aria-label={`Add a card to ${column.label}`}
                  onClick={() => {
                    setComposing(column.id);
                    setDraft("");
                  }}
                >
                  <PlusIcon />
                </button>
              </header>

              {composing === column.id && (
                <form
                  className="board-compose"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitDraft(column.id);
                  }}
                >
                  <input
                    autoFocus
                    className="board-compose__input"
                    placeholder="What needs doing?"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                      // A click elsewhere with text typed still saves — losing
                      // a captured thought to a misclick is the worse failure.
                      // Enter, by contrast, keeps the composer open for the
                      // next card; leaving it does not.
                      void submitDraft(column.id);
                      setComposing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setDraft("");
                        setComposing(null);
                      }
                    }}
                  />
                </form>
              )}

              <div className="board-col__cards">
                {cards === null && <p className="board-col__empty">Loading…</p>}
                {cards !== null && columnCards.length === 0 && composing !== column.id && (
                  <p className="board-col__empty">{column.hint}</p>
                )}
                {columnCards.map((card, i) => (
                  <CardView
                    key={card.id}
                    card={card}
                    index={i}
                    status={card.projectPath ? projectAgentStatus(card.projectPath, rows) : undefined}
                    projectName={card.projectPath ? nameByPath.get(card.projectPath) : undefined}
                    linkable={linkable}
                    dragging={dragId === card.id}
                    dropBefore={dropTarget?.column === column.id && dropTarget.index === i}
                    editing={editingId === card.id}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", card.id);
                      setDragId(card.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTarget(null);
                    }}
                    onDragOver={(e) => {
                      if (!dragId || dragId === card.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const before = e.clientY < rect.top + rect.height / 2;
                      const index = before ? i : i + 1;
                      if (dropTarget?.column !== column.id || dropTarget.index !== index) {
                        setDropTarget({ column: column.id, index });
                      }
                    }}
                    onToggleEdit={() => setEditingId((id) => (id === card.id ? null : card.id))}
                    onSave={(patch) => {
                      setEditingId(null);
                      void mutate(() => updateBoardCard(card.id, patch));
                    }}
                    onDelete={() => {
                      setEditingId(null);
                      void mutate(() => deleteBoardCard(card.id));
                    }}
                    onDispatch={(freshWorktree) => {
                      setEditingId(null);
                      void mutate(() => dispatchBoardCard(card.id, freshWorktree));
                    }}
                  />
                ))}
                {/* Insertion line for an append at the end of the column. */}
                {dropTarget?.column === column.id && dropTarget.index === columnCards.length && dragId && (
                  <div className="board-card__dropline" aria-hidden />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface CardViewProps {
  card: BoardCard;
  index: number;
  status?: AgentStatus;
  projectName?: string;
  linkable: Project[];
  dragging: boolean;
  dropBefore: boolean;
  editing: boolean;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onToggleEdit: () => void;
  onSave: (patch: { title?: string; note?: string; projectPath?: string | null }) => void;
  onDelete: () => void;
  onDispatch: (freshWorktree: boolean) => void;
}

function CardView({
  card,
  status,
  projectName,
  linkable,
  dragging,
  dropBefore,
  editing,
  onDragStart,
  onDragEnd,
  onDragOver,
  onToggleEdit,
  onSave,
  onDelete,
  onDispatch,
}: CardViewProps) {
  const [title, setTitle] = useState(card.title);
  const [note, setNote] = useState(card.note ?? "");
  const [projectPath, setProjectPath] = useState(card.projectPath ?? "");
  const [freshWorktree, setFreshWorktree] = useState(false);

  // Re-arm the form whenever a different card opens for editing (or the same
  // card's server state changes underneath a closed form).
  useEffect(() => {
    setTitle(card.title);
    setNote(card.note ?? "");
    setProjectPath(card.projectPath ?? "");
  }, [editing, card]);

  return (
    <article
      className={`board-card${dragging ? " board-card--dragging" : ""}${
        dropBefore ? " board-card--dropbefore" : ""
      }`}
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
    >
      {!editing ? (
        <button className="board-card__body" onClick={onToggleEdit} title="Edit this card">
          <span className="board-card__title">{card.title}</span>
          {card.note && <span className="board-card__note">{card.note}</span>}
          {card.dispatch && (
            <span
              className="board-card__dispatched"
              title={`An agent was started in ${card.dispatch.path}`}
            >
              agent started {relativeTime(card.dispatch.at)}
              {card.dispatch.branch ? ` on ${card.dispatch.branch}` : ""}
            </span>
          )}
          <span className="board-card__meta">
            {card.projectPath && (
              <span className="board-card__project">
                {status && <span className={`status-dot status-dot--${status}`} aria-hidden />}
                <span className="board-card__project-name">
                  {projectName ?? card.projectPath.split("/").filter(Boolean).pop()}
                </span>
                {/* Idle earns only the gray dot — spelling it out on every
                    card would make the two states that matter read as noise. */}
                {status && status !== "idle" && (
                  <span className={`board-card__status board-card__status--${status}`}>
                    {STATUS_COPY[status]}
                  </span>
                )}
              </span>
            )}
            <span className="board-card__age">
              {card.column === "done" && card.doneAt
                ? `done ${relativeTime(card.doneAt)}`
                : relativeTime(card.updatedAt)}
            </span>
          </span>
        </button>
      ) : (
        <form
          className="board-card__form"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = title.trim();
            if (!trimmed) return;
            onSave({
              title: trimmed,
              note,
              projectPath: projectPath || null,
            });
          }}
        >
          <input
            autoFocus
            className="board-card__input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Card title"
          />
          <textarea
            className="board-card__textarea"
            placeholder="Notes (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
          />
          <select
            className="board-card__select"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            aria-label="Linked project"
          >
            <option value="">No project</option>
            {linkable.map((p) => (
              <option key={p.path} value={p.path}>
                {p.displayName}
              </option>
            ))}
            {/* A link to a project that has since vanished from the scanner
                must stay selectable, or opening the editor would silently drop it. */}
            {projectPath && !linkable.some((p) => p.path === projectPath) && (
              <option value={projectPath}>{projectPath}</option>
            )}
          </select>
          {/* Dispatch: the card becomes a running agent. Only offered when the
              card is linked to a project the server can trust, and never from
              "done" — restarting finished work is a decision, not a misclick. */}
          {card.projectPath && card.column !== "done" && (
            <div className="board-card__dispatch">
              <button
                type="button"
                className="board-card__dispatch-btn"
                onClick={() => onDispatch(freshWorktree)}
                title="Open a Terminal running Claude Code, seeded with this card"
              >
                Start agent
              </button>
              <label className="board-card__dispatch-opt">
                <input
                  type="checkbox"
                  checked={freshWorktree}
                  onChange={(e) => setFreshWorktree(e.target.checked)}
                />
                in a fresh worktree
              </label>
            </div>
          )}
          <div className="board-card__actions">
            <button type="submit" className="board-card__save" disabled={!title.trim()}>
              Save
            </button>
            <button type="button" onClick={onToggleEdit}>
              Cancel
            </button>
            {card.projectPath && (
              <button
                type="button"
                onClick={() => goToProject(card.projectPath!)}
                title="Open this card's project page"
              >
                Project page
              </button>
            )}
            <button
              type="button"
              className="board-card__delete"
              onClick={onDelete}
              title="Delete this card"
              aria-label="Delete this card"
            >
              <TrashIcon />
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
