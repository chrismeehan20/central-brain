import fs from "node:fs";
import path from "node:path";
import { JSONFilePreset } from "lowdb/node";
import { resolveDataDir } from "../appPaths.js";
import type { Override, AttentionItem, GithubStatus, ProjectSummary, ProjectDetail, DailyDigest, SourceTool, Preferences } from "@shared/types.js";
import { DEFAULT_PREFERENCES, EDITORS } from "@shared/types.js";

/** Exported so startup can log it — inside an app bundle this is the only clue to where the data went. */
export const dataDir = resolveDataDir();
fs.mkdirSync(dataDir, { recursive: true });

export type OverridesData = Record<string, Override>;
export interface AttentionData {
  items: AttentionItem[];
}
export type GithubData = Record<string, GithubStatus>;
export type SummariesData = Record<string, ProjectSummary>;
export type DetailsData = Record<string, ProjectDetail>;
export interface AiUsageData {
  date: string; // YYYY-MM-DD; resets the daily counter when the day rolls over
  calls: number;
}

export const overridesDb = await JSONFilePreset<OverridesData>(path.join(dataDir, "overrides.json"), {});
export const attentionDb = await JSONFilePreset<AttentionData>(path.join(dataDir, "attention.json"), {
  items: [],
});
export const githubDb = await JSONFilePreset<GithubData>(path.join(dataDir, "github.json"), {});
export const summariesDb = await JSONFilePreset<SummariesData>(path.join(dataDir, "summaries.json"), {});
export const detailsDb = await JSONFilePreset<DetailsData>(path.join(dataDir, "details.json"), {});
export const aiUsageDb = await JSONFilePreset<AiUsageData>(path.join(dataDir, "ai-usage.json"), {
  date: "",
  calls: 0,
});
export interface DigestData {
  digest: DailyDigest | null;
}
export const digestDb = await JSONFilePreset<DigestData>(path.join(dataDir, "digest.json"), {
  digest: null,
});

/**
 * Last time a hook event was actually received from each tool. Codex's hooks
 * only fire after a one-off interactive trust approval, so "have we ever heard
 * from them, and how recently" is the only reliable way to know whether the
 * push signal is real — see alert/hookLiveness.ts.
 */
export interface HookLivenessData {
  lastEventAt: Partial<Record<SourceTool, string>>; // ISO timestamps; absent = never seen
}
export const hookLivenessDb = await JSONFilePreset<HookLivenessData>(
  path.join(dataDir, "hook-liveness.json"),
  { lastEventAt: {} },
);

/**
 * User-owned configuration entered through the dashboard rather than the
 * environment.
 *
 * This exists because a packaged `.app` has no `.env` to read: the sidecar is
 * spawned with cwd `/`, so `dotenv/config` finds nothing and every AI feature
 * silently no-ops with no way for the user to fix it. The key has to live in
 * the user-data dir, which survives app updates, and be settable from the UI.
 */
export interface SettingsData {
  /** Anthropic API key entered via the UI. Empty string means "not set". */
  apiKey: string;
  /** True once the user has saved a key or explicitly skipped setup, so first-run onboarding stops asking. */
  setupDismissed: boolean;
  /** True once the user has dismissed the connect-your-tools card. Absent in older files. */
  hooksSetupDismissed?: boolean;
  /** Absent in settings.json files written before preferences existed — read via getPreferences(). */
  preferences?: Partial<Preferences>;
}

export const settingsPath = path.join(dataDir, "settings.json");
export const settingsDb = await JSONFilePreset<SettingsData>(settingsPath, {
  apiKey: "",
  setupDismissed: false,
});

/**
 * Preferences with defaults merged in. lowdb only applies its defaults when the
 * file is missing entirely, so a settings.json from before a preference existed
 * simply lacks the field — every read has to fill the gaps.
 */
export function getPreferences(): Preferences {
  const stored = settingsDb.data.preferences ?? {};
  const editor = stored.editor && stored.editor in EDITORS ? stored.editor : DEFAULT_PREFERENCES.editor;
  return {
    notifications: stored.notifications ?? DEFAULT_PREFERENCES.notifications,
    editor,
  };
}

export async function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  settingsDb.data.preferences = { ...getPreferences(), ...patch };
  await writeSettings();
  return getPreferences();
}

/**
 * Persist settings, then re-assert owner-only permissions.
 *
 * lowdb writes with the default umask (usually 0644, world-readable), which is
 * wrong for a file holding an API key. chmod runs after every write because
 * lowdb writes via a temp file and rename, so the mode does not survive on its
 * own. Best-effort: a filesystem that cannot chmod must not break saving.
 */
export async function writeSettings(): Promise<void> {
  await settingsDb.write();
  try {
    fs.chmodSync(settingsPath, 0o600);
  } catch {
    // Non-POSIX filesystem or an exotic mount; the value is still saved.
  }
}

// JSONFilePreset creates the file with defaults on first run, so lock it down now.
try {
  fs.chmodSync(settingsPath, 0o600);
} catch {
  // as above
}
