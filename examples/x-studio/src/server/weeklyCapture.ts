/**
 * Drives one matrix's weekly capture cycle: load persisted snapshots, then
 * fetch-and-persist a new one whenever the current ISO week isn't covered
 * yet. Used once per matrix (data-grid, chart-library, ...) — see
 * server/index.ts — so each matrix's capture history stays independent.
 */
import type { LibraryUsageMatrixResult } from './githubLibraryUsage.js';
import {
  getIsoWeekMonday,
  type LibraryUsageSnapshot,
  type SnapshotStore,
} from './snapshotStore.js';
import { log, warn } from './logger.js';

export interface WeeklyCapture {
  /** Loads persisted snapshots into memory. Call once before serving requests. */
  init(): Promise<void>;
  /**
   * Captures a fresh snapshot for the current ISO week if one isn't already
   * stored. Safe to call concurrently — de-duplicates into a single
   * in-flight run.
   */
  refreshIfDue(): Promise<void>;
  /** Current in-memory snapshots (ascending by week), as of the last init()/refreshIfDue(). */
  getSnapshots(): LibraryUsageSnapshot[];
}

export function createWeeklyCapture(opts: {
  /** Log-line prefix, e.g. 'github-library-usage'. */
  label: string;
  store: SnapshotStore;
  fetchMatrix: (token: string | undefined) => Promise<LibraryUsageMatrixResult>;
  token: string | undefined;
}): WeeklyCapture {
  let snapshots: LibraryUsageSnapshot[] = [];
  let refreshInFlight: Promise<void> | null = null;

  async function init(): Promise<void> {
    snapshots = await opts.store.loadSnapshots();
  }

  // A run where every cell failed (no token configured, or every search errored — see
  // LibraryUsageMatrixResult.failedCount) is deliberately NOT persisted — better to keep
  // serving last week's real numbers than to overwrite them with a false all-zero snapshot.
  // Note this only catches a FULLY failed run: if some cells succeeded and others didn't, the
  // partial result still gets saved (those failed cells read as a real 0 until the next
  // capture) — the same trade-off the live endpoints already accepted before weekly history
  // existed.
  async function refreshIfDue(): Promise<void> {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      const currentWeek = getIsoWeekMonday(new Date());
      if (snapshots.some((s) => s.weekOf === currentWeek)) {
        return;
      }
      log(`[${opts.label}] Capturing snapshot for week of ${currentWeek}…`);
      const { rows, failedCount } = await opts.fetchMatrix(opts.token);
      if (rows.length === 0 || failedCount === rows.length) {
        warn(
          `[${opts.label}] Capture for week of ${currentWeek} produced no usable rows ` +
            `(${failedCount}/${rows.length} cells failed) — not persisting.`,
        );
        return;
      }
      snapshots = await opts.store.saveSnapshot({
        weekOf: currentWeek,
        fetchedAt: Date.now(),
        rows,
      });
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  function getSnapshots(): LibraryUsageSnapshot[] {
    return snapshots;
  }

  return { init, refreshIfDue, getSnapshots };
}
