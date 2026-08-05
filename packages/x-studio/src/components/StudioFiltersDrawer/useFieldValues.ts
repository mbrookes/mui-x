import * as React from 'react';
import { useStudioSelector, selectDataSources } from '../../context';
import type { StudioDataSource, StudioFilterState } from '../../models';
import { getDataSourceRowState } from '../../internals/dataSourceRowState';

type Row = Record<string, unknown>;

/**
 * Apply a set of selection-mode or condition-mode filters to rows inline.
 * Used exclusively for cascading-filter option narrowing; does not handle rank/cross filters.
 *
 * `ds` is the data source `rows` were drawn from. T3.4: a parent filter whose field belongs to
 * a DIFFERENT source (a cross-source "Depends on" pick) can't be resolved by the naive
 * `row[f.field]` comparisons below — the field simply doesn't exist on this source's rows, so
 * every row would read `undefined` and the predicate would always fail, silently emptying the
 * child's option list. `PageFilterRow`'s `dependencyOptions` now only offers same-source
 * parents going forward, but this guards any already-persisted or host/AI-authored
 * cross-source `dependsOn` too: skip the inapplicable parent instead of letting it zero out
 * the result. A real cross-source predicate would need to resolve through a declared join path
 * (see `dataSourceGraph.resolveRows`/`findJoinPath`) — out of scope for this inline narrowing.
 */
function applyParentFilters(
  rows: Row[],
  parentFilters: StudioFilterState[],
  ds: StudioDataSource,
): Row[] {
  let result = rows;
  for (const f of parentFilters) {
    // `f.disabled`: a disabled parent (toggled off in the drawer, not deleted) must be a no-op
    // everywhere, including as a cascading dependency — defense-in-depth alongside
    // `PageFilterRow`'s `isFilterEffective` pre-filter of `parentFilters`, since a disabled
    // filter still has a "meaningful" stored value and would otherwise keep narrowing a
    // cascading child's option list as if it were active.
    if (f.disabled || !f.field || !ds.fields.some((sf) => sf.id === f.field)) {
      continue;
    }
    const mode = f.filterMode ?? 'condition';
    if (mode === 'selection') {
      if (!Array.isArray(f.value) || f.value.length === 0) {
        continue;
      }
      const selectedSet = new Set((f.value as unknown[]).map(String));
      // 2.8: a `not_in` parent selection excludes the selected set — narrowing TO it (the
      // `in`/default behavior) computes the inverse of the surviving rows.
      result =
        f.operator === 'not_in'
          ? result.filter((row) => !selectedSet.has(String(row[f.field] ?? '')))
          : result.filter((row) => selectedSet.has(String(row[f.field] ?? '')));
    } else if (mode === 'condition') {
      if (f.value == null || f.value === '') {
        continue;
      }
      const fieldVal = f.field;
      const filterVal = f.value;
      if (f.operator === 'equals') {
        result = result.filter((row) => String(row[fieldVal] ?? '') === String(filterVal));
      } else if (f.operator === 'not_equals') {
        result = result.filter((row) => String(row[fieldVal] ?? '') !== String(filterVal));
      } else if (f.operator === 'contains') {
        const q = String(filterVal).toLowerCase();
        result = result.filter((row) =>
          String(row[fieldVal] ?? '')
            .toLowerCase()
            .includes(q),
        );
      } else if (f.operator === 'starts_with') {
        const q = String(filterVal).toLowerCase();
        result = result.filter((row) =>
          String(row[fieldVal] ?? '')
            .toLowerCase()
            .startsWith(q),
        );
      }
      // Other operators skipped — for cascading purposes the above cover the most useful cases
    }
  }
  return result;
}

/**
 * Maximum number of distinct values collected for a field. Selection-mode
 * filters render one unvirtualized checkbox row per value, and the `equals`/`not_equals`
 * autocomplete lists them all, so an unbounded high-cardinality field (e.g. an id/email
 * column) would render tens of thousands of DOM nodes and lock the drawer. Above this cap
 * the caller shows a "type to narrow" hint instead.
 */
export const FIELD_VALUES_CAP = 1000;

/**
 * Build sorted unique string values for a field.
 *
 * Values are collected for EVERY field type, not just strings. Selection mode ("Select") is
 * offered for any field, and the engine's `in`/`not_in` compare `String(row[field] ?? '')`
 * against the stored candidates — so a numeric or boolean field yields a perfectly usable
 * value list, exactly as `StudioFilterWidget`'s own `distinctValues` already computes it.
 * Because the declared type no longer changes what is collected, this hook does not take one:
 * `filterSourceId` is what disambiguates two sources sharing a field id, and a `fieldType`
 * parameter only added a memo dependency that recomputed an identical list.
 *
 * When `filterSourceId` is provided, the lookup is scoped to that source only (finding
 * 2.15) — a bare field-id scan across every source pollutes the list when two sources share
 * a field id (e.g. both have `status`). When omitted, falls back to the all-sources scan for
 * callers that don't know the owning source.
 *
 * The result is capped at `FIELD_VALUES_CAP` distinct values; a length equal to the cap
 * signals the caller (`SelectionFilterInput`) that the field is high-cardinality.
 *
 * ## Adapter-backed sources yield no values (H1)
 *
 * `StudioDataSource.rows` is `undefined` — not `[]` — for a source whose data comes from an
 * `adapter`: rows are resolved per-widget into `studioRequestCache` (`useAdapterRows`) and only
 * the host's imperative `StudioController.setDataSourceRows` ever writes them onto the source.
 * Such a source is SKIPPED here rather than scanned as an empty array, because a distinct-value
 * list built from rows nobody read is not a measurement of anything.
 *
 * The empty array this hook then returns is, unavoidably, indistinguishable from "this field
 * genuinely has no values" at the call site: the return type is `string[]`, and both
 * `PageFilterRow` and `WidgetFilterRow` render it straight into `SelectionFilterInput`. Fixing
 * that display honestly (a loading affordance instead of an empty checkbox list) requires
 * widening this signature to carry the row state and updating those three components — all
 * outside the scope of this change. Until then the skip below at least keeps a HALF-delivered
 * multi-source scan (one in-memory source, one adapter-backed) from being reported as complete.
 */
export function useFieldValues(
  fieldId: string,
  filterSourceId?: string,
  parentFilters?: StudioFilterState[],
): string[] {
  const dataSources = useStudioSelector(selectDataSources);
  return React.useMemo(() => {
    // Scope to the filter's own source when known, else scan every source.
    // `filterSourceId` is doc-authored: guard the record index against inherited prototype keys
    // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
    // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
    const scopedSource =
      filterSourceId && Object.hasOwn(dataSources, filterSourceId)
        ? dataSources[filterSourceId]
        : undefined;
    const sources = scopedSource
      ? [scopedSource]
      : (Object.values(dataSources) as StudioDataSource[]);
    const seen = new Set<string>();
    for (const ds of sources) {
      if (!ds || !ds.fields.some((f) => f.id === fieldId)) {
        continue;
      }
      // H1: `rows === undefined` means the row set was never delivered (see this hook's doc
      // comment). `ds.rows ?? []` treated that as a scan that found nothing; skip it explicitly
      // so the intent is legible and a future signature widening has one place to hook into.
      if (getDataSourceRowState(ds) === 'unavailable') {
        continue;
      }
      const sourceRows = ds.rows as Row[];
      const rows =
        parentFilters && parentFilters.length > 0
          ? applyParentFilters(sourceRows, parentFilters, ds)
          : sourceRows;
      for (const row of rows) {
        const val = row[fieldId];
        if (val != null && val !== '') {
          seen.add(String(val));
        }
      }
      if (seen.size >= FIELD_VALUES_CAP) {
        break;
      }
    }
    const sorted = Array.from(seen).sort();
    return sorted.length > FIELD_VALUES_CAP ? sorted.slice(0, FIELD_VALUES_CAP) : sorted;
  }, [dataSources, fieldId, filterSourceId, parentFilters]);
}
