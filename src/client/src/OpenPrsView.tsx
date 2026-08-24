import { useState } from "react";
import type { AttentionItem, AttentionType, Project } from "@shared/types";
import { openPrUrl } from "./api";
import { goToProject } from "./App";
import { flattenOpenPrs, type PrRow } from "./views";
import { relativeTime } from "./format";

const ATTENTION_LABEL: Partial<Record<AttentionType, string>> = {
  "pr-conflict": "merge conflict",
  "pr-ci-failed": "CI failing",
  "pr-review": "over to you",
};

/** Every open PR across the visible projects, flattened into one list. */
export default function OpenPrsView({
  projects,
  attentionItems,
  query,
}: {
  projects: Project[];
  attentionItems: AttentionItem[];
  query: string;
}) {
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const rows = flattenOpenPrs(projects, attentionItems, new Date()).filter(
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
    <section className="section">
      <h2 className="section__title">
        Open pull requests {rows.length > 0 && <span className="section__count">{rows.length}</span>}
      </h2>
      {rows.length === 0 ? (
        <p className="xlist__empty">
          {q ? "No open PRs match your search." : "No open PRs across your projects."}
        </p>
      ) : (
        <div className="xlist">
          {rows.map((row) => {
            const key = row.url ?? `${row.projectPath}#${row.number}`;
            const ci = row.ciStatus?.toLowerCase();
            const badge = row.attention ? ATTENTION_LABEL[row.attention.type] : undefined;
            const lead = (
              <>
                <span className="xlist__repo">
                  {row.repoSlug ?? row.projectName} #{row.number}
                </span>
                <span className="xlist__text">{row.title}</span>
                {row.isDraft && <span className="xlist__tag">draft</span>}
                {badge && <span className="xlist__tag xlist__tag--attention">{badge}</span>}
                {!badge && ci && (
                  <span className={`xlist__tag xlist__tag--ci-${ci}`}>
                    {ci === "failure" ? "checks failing" : ci === "pending" ? "checks running" : "checks green"}
                  </span>
                )}
              </>
            );
            return (
              <div key={key} className="xlist__row">
                {row.url ? (
                  <button
                    className="xlist__lead"
                    title={`Open this pull request on GitHub\n${row.url}`}
                    onClick={() => open(row)}
                  >
                    {lead}
                  </button>
                ) : (
                  // A cached entry from before the url field existed — it fills
                  // in on the next GitHub poll pass (within ~8 minutes).
                  <div className="xlist__lead" title="No link yet — refreshes with the next GitHub poll">
                    {lead}
                  </div>
                )}
                <button
                  className="xlist__project"
                  title={`Go to ${row.projectName}`}
                  onClick={() => goToProject(row.projectPath)}
                >
                  {row.projectName}
                </button>
                {/* A cached row without updatedAt would read "never" — say nothing instead. */}
                {row.updatedAt && <span className="xlist__age">{relativeTime(row.updatedAt)}</span>}
              </div>
            );
          })}
        </div>
      )}
      {error && <p className="attention__error">{error}</p>}
    </section>
  );
}
