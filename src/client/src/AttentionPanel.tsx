import { useEffect, useState } from "react";
import type { AttentionItem, AttentionType } from "@shared/types";
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

  if (items.length === 0) return null;

  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));

  return (
    <section className="attention">
      <h2 className="attention__title">Needs attention {items.length}</h2>
      <div className="attention__list">
        {sorted.map((item) => (
          <div key={item.id} className={`attention__item attention__item--${item.type}`}>
            <span className="attention__badge">{LABEL[item.type]}</span>
            <span className="attention__path">{item.projectPath}</span>
            {item.message && <span className="attention__message">{item.message}</span>}
            <span className="attention__age">{relativeTime(item.updatedAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
