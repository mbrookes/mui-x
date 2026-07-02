type Row = Record<string, unknown>;

/** One stage of a cumulative ("reached") funnel. */
interface FunnelReachedStage {
  /** Stage label (e.g. `Prospecting`). */
  label: string;
  /**
   * Cumulative count of deals that *reached at least* this stage. Non-increasing
   * along the sequence by construction (`{reached ≥ i+1} ⊆ {reached ≥ i}`), so
   * the funnel can never exceed 100% of its top stage.
   */
  value: number;
  /**
   * Snapshot count of deals *currently sitting in* this stage (`stage === label`).
   * Used for the "currently in stage: N" tooltip; this is NOT the funnel width.
   */
  snapshotValue: number;
  /**
   * Step-conversion vs. the previous stage as a fraction 0..1
   * (`value / prevValue`). `null` for the first stage.
   */
  stepConversion: number | null;
}

interface FunnelReachedData {
  /** Sequential stages with cumulative + snapshot counts (Closed Lost excluded). */
  stages: FunnelReachedStage[];
  /**
   * Deals whose final outcome is the terminal exit stage (e.g. `Closed Lost`).
   * Rendered as a separate exit stat, not as a funnel step. A lost deal also
   * counts toward the upper stages it passed through — that is the honest
   * passed-through view, not double counting.
   */
  exitLabel: string | null;
  exitValue: number;
}

/**
 * Builds a cumulative "reached stage" funnel from per-deal depth data.
 *
 * For each stage `i` in `sequence`, counts deals whose numeric reached-depth
 * (`reachedField`) is `>= i`. Because `{reached ≥ i+1} ⊆ {reached ≥ i}`, the
 * resulting counts are monotonically non-increasing **by construction** — the
 * funnel is honest and can never produce retention > 100%.
 *
 * The terminal exit stage (`exitStage`, e.g. `Closed Lost`) is excluded from the
 * sequential math and reported separately as `exitValue`. Lost deals keep their
 * reached depth and still count toward the upper stages they passed through.
 *
 * @param rows - Deal rows.
 * @param stageField - Field holding the snapshot stage label (for the tooltip).
 * @param reachedField - Numeric field holding the furthest-reached depth index.
 * @param sequence - Ordered sequential stage labels (Closed Lost excluded).
 * @param exitStage - Terminal exit label reported as a side stat.
 */
export function aggregateFunnelReached(
  rows: Row[],
  stageField: string,
  reachedField: string,
  sequence: readonly string[],
  exitStage?: string,
): FunnelReachedData {
  const reachedCounts = sequence.map(() => 0);
  const snapshotCounts = new Map<string, number>();
  let exitValue = 0;

  for (const row of rows) {
    const stageLabel = String(row[stageField] ?? '');
    snapshotCounts.set(stageLabel, (snapshotCounts.get(stageLabel) ?? 0) + 1);

    if (exitStage && stageLabel === exitStage) {
      exitValue += 1;
    }

    const depth = Number(row[reachedField]);
    if (!Number.isFinite(depth)) {
      continue;
    }
    // A deal that reached depth `d` counts toward every stage 0..d.
    const cap = Math.min(depth, sequence.length - 1);
    for (let i = 0; i <= cap; i += 1) {
      reachedCounts[i] += 1;
    }
  }

  const stages: FunnelReachedStage[] = sequence.map((label, i) => {
    const value = reachedCounts[i];
    const prev = i > 0 ? reachedCounts[i - 1] : null;
    return {
      label,
      value,
      snapshotValue: snapshotCounts.get(label) ?? 0,
      stepConversion: prev && prev > 0 ? value / prev : null,
    };
  });

  return {
    stages,
    exitLabel: exitStage ?? null,
    exitValue,
  };
}

/**
 * Clamps a funnel bar width fraction to the `[0, 1]` range so a bar can never
 * overflow its track regardless of the source data (a presentation guard that
 * also neutralises any non-monotonic snapshot input).
 */
export function clampWidthPct(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}
