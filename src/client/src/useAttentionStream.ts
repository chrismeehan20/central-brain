import { useEffect, useState } from "react";
import type { AttentionItem } from "@shared/types";

/**
 * One SSE subscription to the attention list, owned by App and shared down.
 *
 * This used to live inside AttentionPanel, which was fine when that panel was
 * the only consumer. The OS shell added three more — sidebar badges, the
 * board's live chips, the agents roster — and four EventSources for one list
 * would quadruple the server's connection load for identical frames. The
 * stream sends a full snapshot on connect, so there is no separate initial
 * fetch to race with.
 */
export function useAttentionStream(): {
  attention: AttentionItem[];
  setAttention: React.Dispatch<React.SetStateAction<AttentionItem[]>>;
} {
  const [attention, setAttention] = useState<AttentionItem[]>([]);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("attention", (e) => {
      try {
        setAttention(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore malformed frame
      }
    });
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => source.close();
  }, []);

  return { attention, setAttention };
}
