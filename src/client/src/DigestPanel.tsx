import { useEffect, useState } from "react";
import type { DailyDigest } from "@shared/types";
import { fetchDigest, refreshDigest } from "./api";
import { relativeTime } from "./format";

/** The model is told plain-text-only, but if **bold** slips through, render it
 *  as actual bold instead of literal asterisks. */
function renderDigestText(text: string) {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

/** One-paragraph "what moved across everything in the last 24h" panel. */
export default function DigestPanel() {
  const [digest, setDigest] = useState<DailyDigest | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetchDigest()
      .then((res) => setDigest(res.digest))
      .catch(() => {
        // dashboard already surfaces server-unreachable; stay quiet here
      });
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await refreshDigest();
      setDigest(res.digest);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRefreshing(false);
    }
  }

  if (!digest?.text && !error) return null;

  return (
    <section className="digest">
      <div className="digest__header">
        <h2 className="digest__title">Last 24 hours</h2>
        <span className="scan-time">
          {digest?.generatedAt ? `generated ${relativeTime(digest.generatedAt)}` : ""}
        </span>
        <button onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {digest?.text && <p className="digest__text">{renderDigestText(digest.text)}</p>}
      {(error ?? digest?.lastError) && <p className="card__summary-error">{error ?? digest?.lastError}</p>}
    </section>
  );
}
