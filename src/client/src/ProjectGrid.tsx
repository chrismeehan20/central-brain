import { useState, type ReactNode } from "react";
import type { MissingProjectTriage, Project } from "@shared/types";
import ProjectCard from "./ProjectCard";

interface Props {
  title: string;
  projects: Project[];
  emptyLabel?: string;
  collapsible?: boolean; // header toggles the grid; starts collapsed
  headerAction?: ReactNode; // section-level control, e.g. bulk relocate
  onRename: (path: string, displayName: string) => void;
  onToggleHidden: (path: string, hidden: boolean) => void;
  onTogglePinned: (path: string, pinned: boolean) => void;
  onKeep?: (path: string) => void;
  onSummaryUpdated?: (path: string, summary: Project["summary"]) => void;
  triage?: Record<string, MissingProjectTriage>; // keyed by project path
  onRelocate?: (from: string, to: string) => Promise<void>;
  onUndoMove?: (oldPaths: string[]) => Promise<void>;
}

export default function ProjectGrid({
  title,
  projects,
  emptyLabel,
  collapsible = false,
  headerAction,
  onRename,
  onToggleHidden,
  onTogglePinned,
  onKeep,
  onSummaryUpdated,
  triage,
  onRelocate,
  onUndoMove,
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
      <div className="section__header">
        {collapsible ? (
          <button className="section__title section__title--toggle" onClick={() => setCollapsed((v) => !v)}>
            <span className="section__caret">{collapsed ? "▸" : "▾"}</span> {heading}
          </button>
        ) : (
          <h2 className="section__title">{heading}</h2>
        )}
        {headerAction}
      </div>
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
              triage={triage?.[p.path]}
              onRelocate={onRelocate}
              onUndoMove={onUndoMove}
            />
          ))}
        </div>
      )}
    </section>
  );
}
