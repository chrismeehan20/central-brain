import { detailsDb, overridesDb, summariesDb } from "./db.js";

/**
 * Records that a project moved on disk, and carries its user-owned data across.
 *
 * The lowdb stores are all keyed by absolute path, so without this a relocation
 * would silently strand the things the user actually typed — the detail page's
 * notes and todo items — under a path nothing renders any more. Data already at
 * the destination always wins; a relocation must never overwrite a live project.
 */
export async function relocateProject(from: string, to: string): Promise<void> {
  const fromOverride = overridesDb.data[from] ?? {};
  const toOverride = overridesDb.data[to] ?? {};

  overridesDb.data[to] = {
    ...toOverride,
    // A renamed card and a pin are worth keeping; `hidden` is not, or the
    // relocated project would vanish the moment it is repaired.
    displayName: toOverride.displayName ?? fromOverride.displayName,
    pinned: toOverride.pinned ?? fromOverride.pinned,
  };
  overridesDb.data[from] = { movedTo: to };

  if (!summariesDb.data[to] && summariesDb.data[from]) {
    summariesDb.data[to] = summariesDb.data[from];
    delete summariesDb.data[from];
    await summariesDb.write();
  }

  if (!detailsDb.data[to] && detailsDb.data[from]) {
    detailsDb.data[to] = { ...detailsDb.data[from], path: to };
    delete detailsDb.data[from];
    await detailsDb.write();
  }

  await overridesDb.write();
}

/** Undoes a relocation, leaving the old path standing on its own again. */
export async function undoRelocation(from: string): Promise<void> {
  const override = overridesDb.data[from];
  if (!override?.movedTo) return;
  const { movedTo, ...rest } = override;
  if (Object.keys(rest).length > 0) overridesDb.data[from] = rest;
  else delete overridesDb.data[from];
  await overridesDb.write();
}
