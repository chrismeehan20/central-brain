import { useState } from "react";
import type { Project } from "@shared/types";
import ProjectCard from "./ProjectCard";

interface Props {
  title: string;
  projects: Project[];
  emptyLabel?: string;
  collapsible?: boolean; // header toggles the grid; starts collapsed
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
  collapsible = false,
  onRename,
  onToggleHidden,
  onTogglePinned,
  onKeep,
  onSummaryUpdated,
}: Props) {
  const [collapsed, setCollapsed] = useState(collapsible);
  if (projects.length === 0 && !emptyLabel) return null;

  const heading = (
    <>
      {title} <span className="section__count">{projects.length}</span>
    </>
  );

  return (
    <section className="section">
      {collapsible ? (
        <button className="section__title section__title--toggle" onClick={() => setCollapsed((v) => !v)}>
          <span className="section__caret">{collapsed ? "▸" : "▾"}</span> {heading}
        </button>
      ) : (
        <h2 className="section__title">{heading}</h2>
      )}
      {collapsed ? null : projects.length === 0 ? (
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
