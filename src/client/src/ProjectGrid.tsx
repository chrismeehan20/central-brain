import type { Project } from "@shared/types";
import ProjectCard from "./ProjectCard";

interface Props {
  title: string;
  projects: Project[];
  emptyLabel?: string;
  onRename: (path: string, displayName: string) => void;
  onToggleHidden: (path: string, hidden: boolean) => void;
  onTogglePinned: (path: string, pinned: boolean) => void;
  onKeep?: (path: string) => void;
  onSummaryUpdated?: (path: string, summary: Project["summary"]) => void;
}

export default function ProjectGrid({
  title,
  projects,
  emptyLabel,
  onRename,
  onToggleHidden,
  onTogglePinned,
  onKeep,
  onSummaryUpdated,
}: Props) {
  if (projects.length === 0 && !emptyLabel) return null;

  return (
    <section className="section">
      <h2 className="section__title">
        {title} <span className="section__count">{projects.length}</span>
      </h2>
      {projects.length === 0 ? (
        <p className="section__empty">{emptyLabel}</p>
      ) : (
        <div className="grid">
          {projects.map((p) => (
            <ProjectCard
              key={p.path}
              project={p}
              onRename={onRename}
              onToggleHidden={onToggleHidden}
              onTogglePinned={onTogglePinned}
              onKeep={onKeep}
              onSummaryUpdated={onSummaryUpdated}
            />
          ))}
        </div>
      )}
    </section>
  );
}
