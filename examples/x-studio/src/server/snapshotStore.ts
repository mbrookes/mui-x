/**
 * Durable weekly-snapshot store for the library-usage matrix.
 *
 * Persisted as a single JSON file (small dataset — a handful of KB per year at
 * one entry/week) rather than a database, since there's no querying need
 * beyond "load everything" / "upsert one week".
 *
 * IMPORTANT for Railway (or any PaaS with an ephemeral filesystem): this file
 * lives on local disk and does NOT survive a redeploy or restart unless the
 * mount path is backed by a persistent volume. Without one, history resets
 * on every deploy — attach a volume and point SNAPSHOT_STORE_PATH at a path
 * inside it. See README.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { warn, log } from './logger.js';

export interface LibraryUsageSnapshot {
  /** Monday (UTC) of the ISO week this snapshot represents, as YYYY-MM-DD. */
  weekOf: string;
  fetchedAt: number;
  rows: Record<string, unknown>[];
}

const STORE_PATH =
  process.env.SNAPSHOT_STORE_PATH ?? path.join(process.cwd(), 'data', 'library-usage-history.json');

/** Returns the Monday (UTC) of the ISO week containing `date`, as YYYY-MM-DD. */
export function getIsoWeekMonday(date: Date): string {
  const truncated = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = truncated.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  truncated.setUTCDate(truncated.getUTCDate() - daysSinceMonday);
  return truncated.toISOString().slice(0, 10);
}

export async function loadSnapshots(): Promise<LibraryUsageSnapshot[]> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as LibraryUsageSnapshot[];
    return Array.isArray(parsed) ? parsed.sort((a, b) => a.weekOf.localeCompare(b.weekOf)) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn('[snapshot-store] Failed to read snapshot store, starting empty:', err);
    }
    return [];
  }
}

/** Upserts `snapshot` by `weekOf` (replacing any existing entry for the same week) and persists to disk. */
export async function saveSnapshot(
  snapshot: LibraryUsageSnapshot,
): Promise<LibraryUsageSnapshot[]> {
  const existing = await loadSnapshots();
  const next = [...existing.filter((s) => s.weekOf !== snapshot.weekOf), snapshot].sort((a, b) =>
    a.weekOf.localeCompare(b.weekOf),
  );
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(next, null, 2), 'utf-8');
  log(
    `[snapshot-store] Saved snapshot for week of ${snapshot.weekOf} (${snapshot.rows.length} rows) to ${STORE_PATH}`,
  );
  return next;
}
