import { createContext, useContext } from "react";
import { DEFAULT_PREFERENCES, EDITORS, type Preferences } from "@shared/types";

/**
 * Preferences flow down from App (which owns the /api/settings fetch) via
 * context rather than props, because the consumers are leaves — doc links on
 * every ProjectCard and the detail page — and threading one string through
 * ProjectGrid's prop list would touch every layer in between.
 */
export const PreferencesContext = createContext<Preferences>(DEFAULT_PREFERENCES);

/** `<scheme>://file/<absolute path>` — the URL shape every VS Code fork accepts. */
export function useDocHref(): (file: string) => string {
  const { editor } = useContext(PreferencesContext);
  return (file) => `${EDITORS[editor].scheme}://file/${encodeURI(file)}`;
}

/** The selected editor's display name, for labels and tooltips ("Open in Cursor"). */
export function useEditorName(): string {
  const { editor } = useContext(PreferencesContext);
  return EDITORS[editor].shortLabel;
}
