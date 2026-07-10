import { useEffect, useMemo, useState } from "react";
import type { DetailItem, DetailItemKind, Project, ProjectDetail } from "@shared/types";
import {
  addDetailItem,
  fetchProjectDetail,
  refreshProjectDetail,
  saveDetailNotes,
  updateDetailItem,
} from "./api";
import { relativeTime } from "./format";

interface Props {
  path: string;
  project?: Project;
  onBack: () => void;
}

const KIND_META: Array<{ kind: DetailItemKind; title: string; empty: string; placeholder: string }> = [
  { kind: "todo", title: "To-dos", empty: "No open to-dos.", placeholder: "Add a to-do…" },
  { kind: "decision", title: "Open decisions", empty: "No open decisions.", placeholder: "Add a decision…" },
  { kind: "pending", title: "Pending / blocked", empty: "Nothing pending.", placeholder: "Add a pending item…" },
];

interface ActivityEntry {
  at?: string;
  label: string;
  text: string;
}

function buildActivity(project?: Project): ActivityEntry[] {
  if (!project) return [];
  const entries: ActivityEntry[] = project.sessions.slice(0, 12).map((s) => ({
    at: s.lastActivity,
    label: s.tool,
    text: s.summary ?? s.firstPrompt ?? "(session)",
  }));
  const gh = project.github;
  if (gh?.lastCommitMessage) {
    entries.push({ at: gh.lastCommitDate, label: "commit", text: gh.lastCommitMessage });
  }
  return entries
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 12);
}

export default function ProjectDetailPage({ path, project, onBack }: Props) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<DetailItemKind, string>>({ todo: "", decision: "", pending: "" });
  const [showCompleted, setShowCompleted] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaved, setNotesSaved] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchProjectDetail(path)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        setNotesDraft(d.notes ?? "");
        setError(null);
      })
      .catch((err) => active && setError(String(err)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [path]);

  function apply(promise: Promise<ProjectDetail>) {
    promise.then(setDetail).catch((err) => setError(String((err as Error).message ?? err)));
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      setDetail(await refreshProjectDetail(path));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRefreshing(false);
    }
  }

  function handleAdd(kind: DetailItemKind) {
    const text = drafts[kind].trim();
    if (!text) return;
    setDrafts((d) => ({ ...d, [kind]: "" }));
    apply(addDetailItem(path, kind, text));
  }

  function commitNotes() {
    if (notesSaved) return;
    setNotesSaved(true);
    apply(saveDetailNotes(path, notesDraft));
  }

  const activity = useMemo(() => buildActivity(project), [project]);
  const items = detail?.items ?? [];
  const open = items.filter((i) => i.status === "open");
  const completed = items.filter((i) => i.status !== "open");
  const title = project?.displayName ?? path.split("/").filter(Boolean).pop() ?? path;

  return (
    <main className="shell">
      <button className="detail__back" onClick={onBack}>
        ← All projects
      </button>

      <header className="detail__header">
        <div>
          <h1>{title}</h1>
          <p className="card__path" title={path}>
            {path}
          </p>
        </div>
        <div className="detail__meta">
          {project?.github?.branch && (
            <span className="badge badge--git" title={project.github.lastCommitMessage}>
              {project.github.branch}
              {project.github.dirty ? " •" : ""}
            </span>
          )}
          <span className="scan-time">active {relativeTime(project?.lastActivity)}</span>
          <button onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh detail"}
          </button>
        </div>
      </header>

      {detail?.generatedAt && (
        <p className="detail__generated">
          AI last read this {relativeTime(detail.generatedAt)}
          {detail.model ? ` · ${detail.model}` : ""}
        </p>
      )}
      {detail?.lastError && <p className="detail__cap">{detail.lastError}</p>}
      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="subtitle">Loading detail…</p>
      ) : (
        <>
          <div className="detail__cols">
            {KIND_META.map(({ kind, title: sectionTitle, empty, placeholder }) => {
              const list = open.filter((i) => i.kind === kind);
              return (
                <section key={kind} className="detail-section">
                  <h2 className="detail-section__title">
                    {sectionTitle} <span className="section__count">{list.length}</span>
                  </h2>
                  {list.length === 0 ? (
                    <p className="detail-section__empty">{empty}</p>
                  ) : (
                    <ul className="ditem-list">
                      {list.map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          onComplete={() => apply(updateDetailItem(path, item.id, { status: "done" }))}
                          onDismiss={() => apply(updateDetailItem(path, item.id, { status: "dismissed" }))}
                        />
                      ))}
                    </ul>
                  )}
                  <div className="ditem-add">
                    <input
                      value={drafts[kind]}
                      placeholder={placeholder}
                      onChange={(e) => setDrafts((d) => ({ ...d, [kind]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && handleAdd(kind)}
                    />
                    <button onClick={() => handleAdd(kind)}>+</button>
                  </div>
                </section>
              );
            })}
          </div>

          {completed.length > 0 && (
            <section className="detail-completed">
              <button className="detail-completed__toggle" onClick={() => setShowCompleted((v) => !v)}>
                {showCompleted ? "▾" : "▸"} Completed / dismissed ({completed.length})
              </button>
              {showCompleted && (
                <ul className="ditem-list">
                  {completed.map((item) => (
                    <li key={item.id} className="ditem ditem--done">
                      <span className="ditem__text">{item.text}</span>
                      <span className="ditem__origin">
                        {item.status === "dismissed"
                          ? "dismissed"
                          : item.completedBy === "ai"
                            ? "auto ✓"
                            : "done ✓"}
                      </span>
                      <button
                        className="ditem__reopen"
                        onClick={() => apply(updateDetailItem(path, item.id, { status: "open" }))}
                      >
                        reopen
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <div className="detail__lower">
            <section className="detail-section">
              <h2 className="detail-section__title">Activity log</h2>
              {activity.length === 0 ? (
                <p className="detail-section__empty">No recent activity.</p>
              ) : (
                <ul className="activity">
                  {activity.map((a, i) => (
                    <li key={i} className="activity__row">
                      <span className={`badge badge--${a.label === "commit" ? "git" : a.label}`}>{a.label}</span>
                      <span className="activity__text">{a.text}</span>
                      <span className="activity__age">{relativeTime(a.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="detail-section">
              <h2 className="detail-section__title">
                Notes {notesSaved ? "" : <span className="detail__dirty">•</span>}
              </h2>
              <textarea
                className="detail-notes"
                value={notesDraft}
                placeholder="Anything you need to remember about this project…"
                onChange={(e) => {
                  setNotesDraft(e.target.value);
                  setNotesSaved(false);
                }}
                onBlur={commitNotes}
              />
              {project && project.markdown.length > 0 && (
                <div className="card__docs detail__docs">
                  {project.markdown.map((doc) => (
                    <a
                      key={doc.file}
                      className="doc-chip"
                      href={`vscode://file/${encodeURI(doc.file)}`}
                      title={doc.file}
                    >
                      {doc.relativePath}
                    </a>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function ItemRow({
  item,
  onComplete,
  onDismiss,
}: {
  item: DetailItem;
  onComplete: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="ditem">
      <button className="ditem__check" onClick={onComplete} title="Mark done">
        ☐
      </button>
      <span className="ditem__text">{item.text}</span>
      <span className={`ditem__origin ditem__origin--${item.origin}`}>{item.origin === "ai" ? "AI" : "you"}</span>
      <button className="ditem__dismiss" onClick={onDismiss} title="Dismiss (not relevant)">
        ×
      </button>
    </li>
  );
}
