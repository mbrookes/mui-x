import { coerceAggregateValue } from '../aggregate';
import { detectAggregationType } from '../aggregators';

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

/** One aggregated funnel section (a stage label + its aggregated value). */
export interface FunnelStage {
  label: string;
  value: number;
}

/** Result of the legacy per-stage snapshot funnel aggregation. */
export interface FunnelStagesResult {
  stages: FunnelStage[];
  /** Native sort to apply in `FunnelChart` — `'none'` when `stages` is already ordered. */
  sort: 'ascending' | 'descending' | 'none';
}

/**
 * Builds the legacy (non-"reached") funnel aggregation: sums (or counts) the
 * value field per stage-field category, then orders the stages according to
 * `sortBy`.
 *
 * - `'natural'` — insertion order (first-seen category order).
 * - `'category'` (or any value when `categoryOrderOverride`/`fieldOrderedValues`
 *   is non-empty) — explicit category order, falling back to value-descending
 *   for any stage absent from that order.
 * - anything else (default: `'value'`/undefined) — delegates the
 *   value-descending sort to `FunnelChart` itself (`sort: 'descending'`) so it
 *   drives its own animation.
 *
 * @param rows - Filtered rows to aggregate.
 * @param stageField - Categorical field providing each row's stage label.
 * @param valueField - Field summed (or counted) per stage.
 * @param yAggregation - When `'count'`, rows are counted instead of summed. Also
 *   auto-detected: if `valueField` holds non-numeric values, falls back to count.
 * @param sortBy - `chartSortBy` config: `'natural' | 'category' | 'value'`.
 * @param categoryOrderOverride - Explicit `funnelCategoryOrder` config, if set.
 * @param fieldOrderedValues - The stage field's `orderedValues`, used as the
 *   category order when `sortBy === 'category'` and no explicit override is set.
 */
export function buildFunnelStages(
  rows: Row[],
  stageField: string,
  valueField: string,
  yAggregation: string | undefined,
  sortBy: string | undefined,
  categoryOrderOverride: string[] | undefined,
  fieldOrderedValues: string[] | undefined,
): FunnelStagesResult {
  // Auto-detect: fall back to counting rows only when the value field has values but NONE
  // of them is numeric. Delegated to the shared `detectAggregationType` rather than
  // hand-rolled, which fixes two divergences from the rest of the package: it sampled
  // exactly ONE row (the first non-null), so a leading "N/A"/"—" sentinel ahead of real
  // numbers downgraded a genuine sum to a row count; and its `Number(v)` test scored an
  // empty-string cell as a numeric `0` (`Number('') === 0`), where `coerceAggregateValue`
  // correctly treats `''` as non-numeric.
  const useCount = yAggregation === 'count' || detectAggregationType(rows, valueField) === 'count';
  // Aggregate: sum value (or count rows) per stage category
  const stageMap = new Map<string, number>();
  for (const row of rows) {
    const label = String(row[stageField] ?? '');
    if (!label) {
      continue;
    }
    const prev = stageMap.get(label) ?? 0;
    if (useCount) {
      stageMap.set(label, prev + 1);
    } else {
      // Coerce via the shared `coerceAggregateValue` policy rather than raw `Number(...)`:
      // an empty-string cell coerces to `null` (skipped, contributing 0) instead of `Number('')
      // === 0` inflating the sum. The label is still registered unconditionally so a stage whose
      // measures are all null/empty stays present (at 0) rather than disappearing (finding 2.17).
      stageMap.set(label, prev + (coerceAggregateValue(row[valueField]) ?? 0));
    }
  }
  // Sort: 'natural' = insertion order; 'category' = orderedValues order (pre-sort, pass
  // sort:'none'); 'value' / default = delegate to FunnelChart native sort:'descending'.
  const resolvedSortBy = sortBy ?? 'category';
  const categoryOrder =
    categoryOrderOverride ?? (resolvedSortBy === 'category' ? fieldOrderedValues : undefined);
  let stages: FunnelStage[];
  let sort: 'ascending' | 'descending' | 'none';
  if (resolvedSortBy === 'natural') {
    stages = [...stageMap.entries()].map(([label, value]) => ({ label, value }));
    sort = 'none';
  } else if (categoryOrder && categoryOrder.length > 0) {
    const orderMap = new Map(categoryOrder.map((v, i) => [v, i]));
    stages = [...stageMap.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => {
        const ia = orderMap.get(a.label) ?? Infinity;
        const ib = orderMap.get(b.label) ?? Infinity;
        return ia !== ib ? ia - ib : b.value - a.value;
      });
    sort = 'none';
  } else {
    // Delegate value-descending sort to FunnelChart so it drives its own animation.
    stages = [...stageMap.entries()].map(([label, value]) => ({ label, value }));
    sort = 'descending';
  }

  return { stages, sort };
}
