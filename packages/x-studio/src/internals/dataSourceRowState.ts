import type { StudioDataSource } from '../models';

/**
 * Whether a data source's rows have been measured yet, and what they said.
 *
 * - `'unavailable'` — `rows` is `undefined`: the row set was **never delivered**. Nothing has
 *   been counted, so no count, no min/max, and no aggregate over it is a real measurement.
 * - `'empty'` — `rows` is `[]`: the row set WAS delivered and it legitimately holds zero rows.
 *   "No data" / "0 rows" / an empty option list are all honest renderings of this.
 * - `'data'` — at least one row.
 */
export type StudioDataSourceRowState = 'unavailable' | 'empty' | 'data';

/**
 * Classifies a data source's `rows` into the tri-state above.
 *
 * `StudioDataSource.rows` is optional precisely because an adapter-backed source may never
 * carry it: the adapter path resolves rows per-widget into `studioRequestCache` (see
 * `useAdapterRows`) and only the host's imperative `StudioController.setDataSourceRows` ever
 * writes them back onto the source. Collapsing that `undefined` into `[]` — the `rows ?? []`
 * / `rows?.length ?? 0` shape — turns "not measured" into the positive claim "measured, and
 * the answer is zero/none". The package states the rule elsewhere already
 * (`generateInsight.ts`: *"`?? 0` would assert a measurement that was never taken"*; the
 * aggregation layer's `null` means "unmeasured", not "zero"); this is the same rule for the
 * source-level row set, so UI can render a loading/unknown affordance instead of a fabricated
 * count, empty dropdown, or `0` measure preview.
 *
 * @param source The data source to classify (may be undefined while a widget is mounting).
 * @returns The row state; `'unavailable'` when `source` itself is missing.
 */
export function getDataSourceRowState(
  source: Pick<StudioDataSource, 'rows'> | undefined | null,
): StudioDataSourceRowState {
  if (!source || source.rows === undefined) {
    return 'unavailable';
  }
  return source.rows.length === 0 ? 'empty' : 'data';
}

/**
 * True when the source's rows have not been delivered yet AND an adapter is registered to
 * deliver them — i.e. the honest UI state is "loading", not "empty".
 *
 * Without an adapter an `undefined` `rows` is still unmeasured (so callers must not print a
 * count for it either), but nothing is on its way, so a spinner would never resolve.
 *
 * @param source The data source to classify.
 * @returns Whether rows are pending an adapter fetch.
 */
export function isAwaitingDataSourceRows(
  source: Pick<StudioDataSource, 'rows' | 'adapter'> | undefined | null,
): boolean {
  return getDataSourceRowState(source) === 'unavailable' && Boolean(source?.adapter);
}
