import { resolveRows } from './dataSourceGraph';
import { isRelativeDateValue, resolveRelativeDate } from './filterUtils';
import {
  captureSourceDep,
  getLruEntry,
  getOrCreateBucket,
  setLruEntry,
  sourceDepsUnchanged,
} from './rowCacheLru';
import type { SourceDep } from './rowCacheLru';
import { stableStringify } from './stableStringify';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
  StudioExpressionField,
} from '../models';

type Row = Record<string, unknown>;

// ─── Per-widgetRows cache ─────────────────────────────────────────────────────
//
// Outer key: widgetRows (= dataSources[widgetSourceId].rows)
//   WeakMap — entries are GC'd automatically when widgetRows is no longer
//   referenced (i.e., after dataSources[widgetSourceId].rows changes).
//   An unrelated source's rows changing does NOT affect this entry.
//
// Inner key: content-based fingerprint of the effective filter set.
//   The fingerprint encodes the FULL behavioral content of each filter — not just
//   its id/value — so changing a filter's operator, second condition, mode, rank
//   direction, field type, or target source produces a different key → cache miss.
//   Two widgets sharing the same effective filters get the same key → cache hit.
//
// Per-entry deps (checked on every hit):
//   crossFilterSourceDeps  rows AND fields refs of EVERY foreign source this entry
//                          joined against — declared cross-filter sources, derived
//                          cross-filter sources (a page filter on an expression
//                          field owned by another source), and many-to-many
//                          junction sources. `resolveRows` reports these via the
//                          `collectJoinedSourceIds` out-param; if either ref of any
//                          of them changes the entry is invalidated. `fields` is
//                          tracked because the join reads the foreign source through
//                          `getCachedNormalizedDataSource`, which is keyed on both
//                          (see `SourceDep` in `rowCacheLru.ts`).
//   relationships          full array ref (rarely changes; OK to be broad here)
//   relevantExprFields     object refs of the expression fields owned by any source
//                          this result depends on (the widget source plus every joined
//                          source): every calculated column, plus any MEASURE the caller
//                          named in `usedFieldIds` (a measure is a dependency edge into
//                          the columns it reads — see `collectRelevantExprFields`).
//                          Editing a formula produces a new object ref → invalidation.
//                          Without this, a HIT here returns rows baked with the OLD
//                          formula even though enrichedRowsCache would have recomputed
//                          on a MISS.

interface ResolvedCacheEntry {
  /**
   * Rows AND fields refs of every foreign source this entry depends on (see `SourceDep`).
   * A `null` member records a source that was absent at compute time, so when it later
   * loads the equality check fails and the entry is invalidated — that is what keeps a
   * cross-filter whose foreign source loaded late from serving unfiltered rows forever.
   */
  crossFilterSourceDeps: Map<string, SourceDep>;
  relationships: StudioRelationship[];
  /** Source IDs whose expression fields this result depends on. */
  relevantExprSourceIds: Set<string>;
  /** The relevant expression-field objects at cache time (reference identity). */
  relevantExprFields: StudioExpressionField[];
  result: Row[];
}

const rowCache = new WeakMap<Row[], Map<string, ResolvedCacheEntry>>();

// The inner map is capped/evicted through the shared insertion-order LRU in
// `rowCacheLru.ts` (`MAX_ENTRIES_PER_ROWS`), which `normalizedRowsCache` and
// `enrichedRowsCache` also use: interactive / cross-filter churn produces a stream of
// value-distinct fingerprints, and without a cap the inner Map would grow unbounded for the
// lifetime of that rows array.

/**
 * Resolves the bound a relative date currently denotes, so the cache key changes when the
 * resolved window would change — whether the relative value sits at the TOP level of a filter
 * condition (e.g. `field >= "7 days ago"`) or NESTED inside a `between` bound's `{ from, to }`
 * object (e.g. `field between { from: "30 days ago", to: today }`).
 *
 * A `between` filter's `f.value` is itself a plain `{ from, to }` object — never a
 * `RelativeDateValue` — so `isRelativeDateValue(f.value)` alone never detects a relative bound
 * nested inside it. That left the cache key computed from the raw (stable) `{from,to}` object
 * unchanged across a midnight crossing even though the resolved window shifted, serving a STALE
 * date window for the remainder of a long-lived session (finding 5).
 *
 * The key is built from `resolveRelativeDate` itself — the SAME function `compileRowTest`
 * compiles its comparison bound from — so the key and the predicate cannot disagree. Stability
 * comes from `resolveRelativeDate` anchoring to a cadence-floored "now"
 * (`RELATIVE_DATE_REFRESH_CADENCE_MS`): the value is byte-stable for one cadence tick, then
 * changes, and the rows the cache serves always match the predicate that produced them. An
 * earlier version truncated the key to the FILTER'S OWN unit while the predicate kept
 * millisecond precision, so within one unit tick the key stayed constant while the correct
 * predicate moved, and a "last 1 hour" widget served rows computed up to 59 minutes earlier.
 *
 * Returns `null` when `value` carries no relative date anywhere.
 */
function resolvedRelativeBound(value: unknown): string | null {
  if (isRelativeDateValue(value)) {
    return resolveRelativeDate(value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const range = value as { from?: unknown; to?: unknown };
    const fromBound = isRelativeDateValue(range.from) ? resolveRelativeDate(range.from) : null;
    const toBound = isRelativeDateValue(range.to) ? resolveRelativeDate(range.to) : null;
    if (fromBound !== null || toBound !== null) {
      return `${fromBound ?? ''}..${toBound ?? ''}`;
    }
  }
  return null;
}

/**
 * Fingerprints every field that affects how a filter selects rows. `compileRowTest`
 * (filterUtils) reads operator/field/fieldType/conjunction/operator2/value2/
 * filterMode/rank*, so all of them must be part of the cache key — omitting them
 * lets an operator edit (same id, same value) silently serve stale rows.
 *
 * `f.id` is deliberately NOT included: it does not affect which rows a filter selects,
 * so two filters identical in every behavioral field should share one cache entry.
 * Including it would guarantee a miss every time an interactive/cross-filter is
 * re-applied, since those ids carry a `Date.now()` suffix.
 */
export function filterFingerprint(f: StudioFilterState): string {
  return stableStringify([
    f.field,
    f.fieldType ?? null,
    f.filterMode ?? null,
    f.operator,
    f.value ?? null,
    // A relative-date value (e.g. "7 days ago") is a stable object, so `f.value` alone never
    // changes across a midnight crossing — the entry would serve a stale window forever while
    // preset filters self-heal (their resolved `{from,to}` changes daily). Fold the resolved
    // bound into the fingerprint so a relative-valued filter re-computes when its window moves
    // (finding 2.21) — including a relative bound nested inside a `between` filter's `{from,to}`
    // value, not just a top-level relative value (finding 5). Preset (`dateRangePreset`) filters
    // are already resolved to concrete bounds in `f.value` before reaching here, so they need no
    // equivalent treatment.
    resolvedRelativeBound(f.value),
    f.conjunction ?? null,
    f.operator2 ?? null,
    f.value2 ?? null,
    resolvedRelativeBound(f.value2),
    f.rankDirection ?? null,
    f.rankByField ?? null,
    f.rankMultiSeriesBy ?? null,
    f.filterSourceId ?? null,
    f.disabled ?? null,
  ]);
}

/**
 * Expression fields owned by any of `sourceIds` that this result depends on, in declaration
 * order: every non-measure (calculated column) field, PLUS any measure the caller explicitly
 * requested via `usedFieldIds`.
 *
 * A measure has no per-row value, so it looks irrelevant to a row set — but it is a dependency
 * EDGE: `getCachedEnrichedRows` expands a requested measure to the calculated columns it reads,
 * so re-pointing `sum(profit)` at `sum(margin)` changes which columns the enriched rows carry
 * while leaving the measure's ID (and therefore this entry's cache key) untouched. Ignoring
 * requested measures here served the previously-enriched array by reference, so the re-pointed
 * measure aggregated a column that was never computed and read 0 — the same class of bug as the
 * measure-free dependency expansion in `enrichedRowsCache`. Measures NOT in `usedFieldIds` stay
 * excluded so authoring an unrelated measure never invalidates anything.
 */
function collectRelevantExprFields(
  expressionFields: StudioExpressionField[],
  sourceIds: ReadonlySet<string>,
  usedFieldIds?: ReadonlySet<string>,
): StudioExpressionField[] {
  return expressionFields.filter(
    (ef) => sourceIds.has(ef.sourceId) && (!ef.isMeasure || (usedFieldIds?.has(ef.id) ?? false)),
  );
}

function isEntryValid(
  entry: ResolvedCacheEntry,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
  usedFieldIds?: ReadonlySet<string>,
): boolean {
  if (entry.relationships !== relationships) {
    return false;
  }
  // Every foreign source this result depends on must still have the same rows AND fields
  // refs. `fields` is load-bearing: the semi-join reads the foreign source through
  // `getCachedNormalizedDataSource`, which is keyed on both, so retyping a foreign field
  // (`updateDataSourceField` keeps the rows ref) changes the joined values. Tracking rows
  // alone made the retype appear to do nothing — the grid kept rows filtered against
  // un-normalized values with no recovery short of replacing the source's rows.
  if (!sourceDepsUnchanged(entry.crossFilterSourceDeps, dataSources)) {
    return false;
  }
  // Expression fields relevant to this result must be the same objects (formula edits
  // replace the object). Recompute the relevant set from the stored source IDs so an
  // added/removed field on a relevant source is caught too. `usedFieldIds` is safe to take
  // from the CURRENT call rather than the entry: its sorted contents are part of the cache
  // key, so an entry is only ever looked up with an equal set.
  const currentExprFields = collectRelevantExprFields(
    expressionFields,
    entry.relevantExprSourceIds,
    usedFieldIds,
  );
  if (currentExprFields.length !== entry.relevantExprFields.length) {
    return false;
  }
  for (let i = 0; i < currentExprFields.length; i += 1) {
    if (currentExprFields[i] !== entry.relevantExprFields[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Wraps `resolveRows` with a per-widgetRows WeakMap cache keyed on
 * `(sourceId, resolvedFiltersFingerprint)`.
 *
 * Widgets sharing the same data source **and** the same effective filter set
 * receive the **same Row[] reference** after the first widget computes it —
 * saving N-1 full pipeline passes per shared source per render cycle.
 *
 * Invalidation triggers:
 * - own-rows changes (outer WeakMap key),
 * - any joined foreign source's rows OR fields changing (declared/derived cross-filter
 *   or many-to-many junction — tracked via resolveRows' collectJoinedSourceIds),
 * - any behavioral filter-field change (inner key fingerprint),
 * - relationships changes (array ref),
 * - a relevant expression-field formula change (object ref).
 *
 * Unrelated sources, unrelated filters, and unrelated expression fields do NOT
 * invalidate this entry.
 *
 * KPI widgets that use `skipEnrichment: true` should continue to call
 * `resolveRows` directly — they pre-enrich once and call twice with different
 * period filters, which are rarely shared across widgets.
 */
export function resolveRowsCached(
  widgetRows: Row[],
  widgetSourceId: string | undefined,
  resolvedFilters: StudioFilterState[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
  usedFieldIds?: ReadonlySet<string>,
): Row[] {
  if (!widgetSourceId) {
    return resolveRows(
      widgetRows,
      widgetSourceId,
      resolvedFilters,
      dataSources,
      relationships,
      expressionFields,
      { usedFieldIds },
    );
  }

  // Non-rank filters are AND-ed row predicates, so their order is immaterial and sorting
  // their fingerprints lets two widgets that received the same filter set in different
  // orders share one entry. Rank filters are NOT commutative — `applyFilters` runs them
  // SEQUENTIALLY as dataset-level reductions, so "top 5 by revenue then top 3 by units" and
  // its reverse generally select different rows. Sorting them together collapsed both
  // orderings onto a single cache entry, serving whichever computed first for both. Keep the
  // rank fingerprints in application order, in their own key segment.
  const nonRankFingerprints: string[] = [];
  const rankFingerprints: string[] = [];
  for (const f of resolvedFilters) {
    const fingerprint = filterFingerprint(f);
    if ((f.filterMode ?? 'condition') === 'rank') {
      rankFingerprints.push(fingerprint);
    } else {
      nonRankFingerprints.push(fingerprint);
    }
  }
  const filterKey = `${nonRankFingerprints.sort().join('|')}#${rankFingerprints.join('|')}`;
  // `'*'` (not `''`) for "no field set given", mirroring `normalizedRowsCache`: an ABSENT
  // `usedFieldIds` means "enrich every field for the source" while an EMPTY set means "enrich
  // none" (`enrichedRowsCache`), and both used to join to `''` — so whichever of
  // `createStudioPipeline` (always undefined) and `useWidgetRows` (can pass an empty set)
  // computed first won the shared slot for both.
  const fieldSetSegment = usedFieldIds ? [...usedFieldIds].toSorted().join(',') : '*';
  const cacheKey = `${widgetSourceId}::${filterKey}::${fieldSetSegment}`;

  const byKey = getOrCreateBucket(rowCache, widgetRows);

  // `getLruEntry` refreshes recency on read (delete + re-insert moves the key to the newest
  // position).
  const existing = getLruEntry(byKey, cacheKey);
  if (
    existing &&
    isEntryValid(existing, dataSources, relationships, expressionFields, usedFieldIds)
  ) {
    return existing.result;
  }

  // Capture the full set of foreign sources actually joined against (declared +
  // derived cross-filter sources + M:N junction sources).
  const joinedSourceIds = new Set<string>();
  const result = resolveRows(
    widgetRows,
    widgetSourceId,
    resolvedFilters,
    dataSources,
    relationships,
    expressionFields,
    { usedFieldIds, collectJoinedSourceIds: joinedSourceIds },
  );

  const crossFilterSourceDeps = new Map<string, SourceDep>();
  for (const sourceId of joinedSourceIds) {
    // Record an absent source as `{ rows: null, fields: null }` (not skip) so a later data
    // load invalidates the entry.
    crossFilterSourceDeps.set(sourceId, captureSourceDep(dataSources[sourceId]));
  }
  // Also record any declared filterSourceId even if the join was skipped (e.g. the
  // foreign source had no rows yet) so a later data load invalidates the entry.
  for (const f of resolvedFilters) {
    if (f.filterSourceId && !crossFilterSourceDeps.has(f.filterSourceId)) {
      crossFilterSourceDeps.set(f.filterSourceId, captureSourceDep(dataSources[f.filterSourceId]));
    }
  }

  // Expression fields whose formulas this result depends on: the widget source's
  // own, plus every joined source (foreign enrichment is baked into the semi-join).
  const relevantExprSourceIds = new Set<string>([widgetSourceId]);
  for (const sourceId of joinedSourceIds) {
    relevantExprSourceIds.add(sourceId);
  }
  for (const f of resolvedFilters) {
    if (f.filterSourceId) {
      relevantExprSourceIds.add(f.filterSourceId);
    }
  }
  const relevantExprFields = collectRelevantExprFields(
    expressionFields,
    relevantExprSourceIds,
    usedFieldIds,
  );

  // `setLruEntry` evicts the least-recently-used entries before inserting when at capacity.
  setLruEntry(byKey, cacheKey, {
    crossFilterSourceDeps,
    relationships,
    relevantExprSourceIds,
    relevantExprFields,
    result,
  });
  return result;
}
