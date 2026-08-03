import { useEffect, useMemo, useState } from "react";
import type { AttentionItem, AttentionType, Project } from "@shared/types";
import { dismissAttention, openInVsCode, snoozeAttention } from "./api";
import { relativeTime } from "./format";
import { useEditorName } from "./prefs";

const ORDER: AttentionType[] = ["permission", "waiting", "codex-maybe-waiting", "done"];
const LABEL: Record<AttentionType, string> = {
  permission: "Needs your OK",
  waiting: "Waiting / idle",
  "codex-maybe-waiting": "Codex — maybe stuck (heuristic)",
  done: "Done",
};

const SNOOZE_MINUTES = 60;
/** How often the panel re-evaluates snooze expiry, so a lapsed snooze reappears without an SSE frame. */
const TICK_MS = 30_000;

export default function AttentionPanel({ projects }: { projects: Project[] }) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const editorName = useEditorName();

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("attention", (e) => {
      try {
        setItems(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore malformed frame
      }
    });
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => source.close();
  }, []);

  // Snoozes expire on the clock, not on an event, so the panel needs its own
  // heartbeat — otherwise a row whose snooze lapsed would stay hidden until the
  // next unrelated attention update happened to arrive.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, []);

  // Display names come from the project list; a session in a folder we've never
  // scanned (or one with no cwd at all) falls back to the last path segment.
  // Sibling checkouts folded into one card resolve to that card's name too.
  const nameByPath = useMemo(() => {
    const map = new Map(projects.map((p) => [p.path, p.displayName]));
    for (const p of projects) {
      for (const c of p.checkouts ?? []) {
        if (!map.has(c.path)) map.set(c.path, p.displayName);
      }
    }
    return map;
  }, [projects]);

  function projectName(projectPath: string): string {
    return (
      nameByPath.get(projectPath) ??
      projectPath.split("/").filter(Boolean).pop() ??
      projectPath
    );
  }

  function openProject(item: AttentionItem) {
    setError(null);
    // For Claude items the server routes this to the focus-only deep link,
    // landing on the exact chat tab that's waiting (never a resume — the
    // session is live). Codex items just open the project window.
    openInVsCode(item.projectPath, item.tool === "claude" ? item.sessionId : undefined).catch(
      (err) => setError(String((err as Error).message ?? err))
    );
  }

  async function mutate(id: string, run: () => Promise<{ items: AttentionItem[] }>) {
    setError(null);
    setBusyId(id);
    try {
      const res = await run();
      // The SSE frame carries the same list a moment later; both paths converge.
      setItems(res.items);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusyId(null);
    }
  }

  const visible = items.filter(
    (i) => !i.snoozedUntil || Date.parse(i.snoozedUntil) <= now
  );
  if (visible.length === 0) return null;

  const sorted = [...visible].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));

  return (
    <section className="attention">
      <h2 className="attention__title">Needs attention {visible.length}</h2>
      <div className="attention__list">
        {sorted.map((item) => {
          const lead = (
            <>
              <span className="attention__project">{projectName(item.projectPath)}</span>
              <span className={`attention__tool attention__tool--${item.tool}`}>
                {item.tool === "claude" ? "Claude" : "Codex"}
              </span>
              <span className="attention__badge">{LABEL[item.type]}</span>
              {item.message && <span className="attention__message">{item.message}</span>}
            </>
          );
          // Hook events with no cwd land here as "unknown" — nothing to open,
          // so the leading region is inert. The controls still apply.
          const openable = item.projectPath !== "unknown";
          return (
            <div key={item.id} className={`attention__item attention__item--${item.type}`}>
              {openable ? (
                <button
                  className="attention__lead"
                  title={`${
                    item.tool === "claude"
                      ? `Jump to this chat in ${editorName} — the agent is waiting there`
                      : `Open this project in ${editorName} — the agent is waiting there`
                  }\n${item.projectPath}`}
                  onClick={() => openProject(item)}
                >
                  {lead}
                </button>
              ) : (
                <div className="attention__lead">{lead}</div>
              )}
              <button
                className="attention__control"
                title="Hide this for an hour — the underlying state keeps updating"
                disabled={busyId === item.id}
                onClick={() => mutate(item.id, () => snoozeAttention(item.id, SNOOZE_MINUTES))}
              >
                Snooze 1h
              </button>
              <button
                className="attention__control attention__control--dismiss"
                title="Dismiss this alert"
                aria-label="Dismiss"
                disabled={busyId === item.id}
                onClick={() => mutate(item.id, () => dismissAttention(item.id))}
              >
                ✕
              </button>
              <span className="attention__age">{relativeTime(item.updatedAt)}</span>
            </div>
          );
        })}
      </div>
      {error && <p className="attention__error">{error}</p>}
    </section>
  );
}
