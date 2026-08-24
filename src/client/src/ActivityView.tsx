import type { Project } from "@shared/types";
import { goToProject } from "./App";
import { buildGlobalActivity } from "./views";
import { relativeTime } from "./format";

/**
 * Recent sessions and commits across every visible project, one feed. Rows
 * navigate to the project's detail page — opening a specific chat stays on
 * that page, where the action can be labelled honestly per tool.
 */
export default function ActivityView({ projects, query }: { projects: Project[]; query: string }) {
  const q = query.trim().toLowerCase();
  const entries = buildGlobalActivity(projects).filter(
    (e) => !q || e.text.toLowerCase().includes(q) || e.projectName.toLowerCase().includes(q)
  );

  return (
    <section className="section">
      <h2 className="section__title">Recent activity</h2>
      {entries.length === 0 ? (
        <p className="xlist__empty">
          {q ? "No activity matches your search." : "No recorded activity yet."}
        </p>
      ) : (
        <div className="xlist">
          {entries.map((e, i) => (
            <div key={`${e.projectPath}:${e.at ?? i}:${i}`} className="xlist__row">
              <button
                className="xlist__project xlist__project--lead"
                title={`Go to ${e.projectName}`}
                onClick={() => goToProject(e.projectPath)}
              >
                {e.projectName}
              </button>
              <span className={`activity__label activity__label--${e.label}`}>{e.label}</span>
              <span className="xlist__text">{e.text}</span>
              <span className="xlist__age">{relativeTime(e.at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
