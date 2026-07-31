import { useEffect, useState } from "react";
import type { AttentionItem, AttentionType } from "@shared/types";
import { openInVsCode } from "./api";
import { relativeTime } from "./format";

const ORDER: AttentionType[] = ["permission", "waiting", "codex-maybe-waiting", "done"];
const LABEL: Record<AttentionType, string> = {
  permission: "Needs your OK",
  waiting: "Waiting / idle",
  "codex-maybe-waiting": "Codex — maybe stuck (heuristic)",
  done: "Done",
};

export default function AttentionPanel() {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);

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

  function openProject(item: AttentionItem) {
    setOpenError(null);
    // Never resume the session from here — it is live in some window already;
    // focusing its project is the safe jump. (A future refinement could use the
    // session's entrypoint to target Terminal for `cli` sessions instead.)
    openInVsCode(item.projectPath).catch((err) =>
      setOpenError(String((err as Error).message ?? err))
    );
  }

  if (items.length === 0) return null;

  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));

  return (
    <section className="attention">
      <h2 className="attention__title">Needs attention {items.length}</h2>
      <div className="attention__list">
        {sorted.map((item) => {
          const inner = (
            <>
              <span className="attention__badge">{LABEL[item.type]}</span>
              <span className="attention__path">{item.projectPath}</span>
              {item.message && <span className="attention__message">{item.message}</span>}
              <span className="attention__age">{relativeTime(item.updatedAt)}</span>
            </>
          );
          // Hook events with no cwd land here as "unknown" — nothing to open.
          if (item.projectPath === "unknown") {
            return (
              <div key={item.id} className={`attention__item attention__item--${item.type}`}>
                {inner}
              </div>
            );
          }
          return (
            <button
              key={item.id}
              className={`attention__item attention__item--${item.type}`}
              title="Open this project in VS Code — the agent is waiting there"
              onClick={() => openProject(item)}
            >
              {inner}
            </button>
          );
        })}
      </div>
      {openError && <p className="attention__error">{openError}</p>}
    </section>
  );
}
