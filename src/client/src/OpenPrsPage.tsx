import { useMemo, useState } from "react";
import type { AttentionItem, AttentionType, Project } from "@shared/types";
import { openPrUrl } from "./api";
import { goToProject } from "./App";
import { flattenOpenPrs, prNeedsAttention, type PrRow } from "./views";
import { relativeTime } from "./format";

interface Props {
  projects: Project[];
  attention: AttentionItem[];
}

const ATTENTION_LABEL: Partial<Record<AttentionType, string>> = {
  "pr-conflict": "merge conflict",
  "pr-ci-failed": "CI failing",
  "pr-review": "over to you",
};

/** Every open PR across the visible projects, flattened into one list, problems first. */
export default function OpenPrsPage({ projects, attention }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const allRows = useMemo(
    () => flattenOpenPrs(projects, attention, new Date()),
    [projects, attention],
  );
  const q = query.trim().toLowerCase();
  const rows = allRows.filter(
    (r) =>
      !q ||
      r.title.toLowerCase().includes(q) ||
      (r.repoSlug ?? "").toLowerCase().includes(q) ||
      r.projectName.toLowerCase().includes(q) ||
      (r.headRefName ?? "").toLowerCase().includes(q) ||
      (r.author ?? "").toLowerCase().includes(q)
  );

  function open(row: PrRow) {
    if (!row.url) return;
    setError(null);
    openPrUrl(row.url).catch((err) => setError(String((err as Error).message ?? err)));
  }

  return (
    <div className="prs">
      <header className="prs__head">
        <div>
          <h1>Open PRs</h1>
          <p className="subtitle">Every open pull request across your projects, problems first.</p>
        </div>
        <input
          className="topbar__search"
          type="search"
          placeholder="Search title, repo, branch, author…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      {error && (
        <div className="error-banner">
          <p className="error-banner__text">{error}</p>
          <button className="error-banner__dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="prs__empty">
          {q ? "No open PRs match your search." : "No open PRs across your projects."}
        </p>
      ) : (
        <div className="prs__list">
          {rows.map((row) => {
            const key = row.url ?? `${row.projectPath}#${row.number}`;
            const ci = row.ciStatus?.toLowerCase();
            const badge = row.attention ? ATTENTION_LABEL[row.attention.type] : undefined;
            const lead = (
              <>
                <span className="pr-row__repo">
                  {row.repoSlug ?? row.projectName} #{row.number}
                </span>
                <span className="pr-row__title">{row.title}</span>
                {row.isDraft && <span className="pr-row__tag">draft</span>}
                {badge && <span className="pr-row__tag pr-row__tag--attention">{badge}</span>}
                {!badge && ci && (
                  <span className={`pr-row__tag pr-row__tag--ci-${ci}`}>
                    {ci === "failure" ? "checks failing" : ci === "pending" ? "checks running" : "checks green"}
                  </span>
                )}
              </>
            );
            return (
              <div key={key} className={`pr-row${prNeedsAttention(row) ? " pr-row--attention" : ""}`}>
                {row.url ? (
                  <button
                    className="pr-row__lead"
                    title={`Open this pull request on GitHub\n${row.url}`}
                    onClick={() => open(row)}
                  >
                    {lead}
                  </button>
                ) : (
                  // A cached entry from before the url field existed — it fills
                  // in on the next GitHub poll pass (within ~8 minutes).
                  <div className="pr-row__lead" title="No link yet — refreshes with the next GitHub poll">
                    {lead}
                  </div>
                )}
                <button
                  className="pr-row__project"
                  title={`Go to ${row.projectName}`}
                  onClick={() => goToProject(row.projectPath)}
                >
                  {row.projectName}
                </button>
                {/* A cached row without updatedAt would read "never" — say nothing instead. */}
                {row.updatedAt && <span className="pr-row__age">{relativeTime(row.updatedAt)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
