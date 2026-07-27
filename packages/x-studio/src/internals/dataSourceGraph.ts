import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { applyFilters } from './filterUtils';
import { collectKeySet, normalizeJoinKey } from './joinKeys';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';

type Row = Record<string, unknown>;

/**
 * Finds the relationship that directly connects `sourceA` and `sourceB` as its two
 * endpoints (in either direction), or `null` if none is declared. Note this also
 * matches a `many-to-many` relationship whose two endpoints are `sourceA`/`sourceB`
 * (callers branch on `relationship.type`); it does NOT match on a junction source.
 */
export function findDirectRelationship(
  sourceA: string,
  sourceB: string,
  relationships: StudioRelationship[],
): StudioRelationship | null {
  return (
    relationships.find(
      (relationship) =>
        (relationship.sourceId === sourceA && relationship.targetId === sourceB) ||
        (relationship.sourceId === sourceB && relationship.targetId === sourceA),
    ) ?? null
  );
}

/**
 * One direct (one-hop) join from a widget's source to a related source, with both join fields
 * already ORIENTED from the widget's point of view — so a caller never has to know which side
 * of the relationship the schema author happened to declare first.
 */
export interface RelatedSourceJoin {
  /** The declared relationship this join was derived from, unmodified. */
  relationship: StudioRelationship;
  /** Field on the WIDGET source's rows carrying the join value (the FK for a many-to-one). */
  sourceField: string;
  /** Field on the RELATED source's rows carrying the join value (the PK for a many-to-one). */
  targetField: string;
}

/**
 * Builds a `relatedSourceId → RelatedSourceJoin` index of the direct (one-hop) relationships
 * that connect `widgetSourceId` to another source, in EITHER declared direction. This is the
 * single traversal step every "cross-source display column" enrichment needs (grid columns,
 * map fields, cross-source group-by aggregation).
 *
 * Its predicate deliberately matches `enrichRowsWithRelatedFields`'s own direct-relationship
 * loop below — any non-many-to-many relationship with `widgetSourceId` at either end. It used
 * to be much narrower (`type === 'many-to-one' && sourceId === widgetSourceId`), which made
 * the display path answer a question three siblings answer more widely:
 * `enrichRowsWithRelatedFields`, `chartSupport.findDirectFieldOwner` and
 * `createBatchingAdapter.resolveField` all resolve one-to-one and reverse-declared
 * relationships. So a `{ type: 'one-to-one', sourceId: 'orders', targetId: 'order_details' }`
 * grid column, or a `many-to-one` declared as `{ sourceId: 'customers', targetId: 'orders' }`
 * with the grid on `orders`, missed the index, hit a `continue`, and rendered EMPTY on every
 * row — silently — while a chart using the identical field on the identical relationship
 * resolved it fine, and so did the adapter path. `MapSetupPanel` offers value/country fields
 * from every source `getReachableSourceIds` reaches (both directions, every type), so this was
 * directly reachable from the UI, not only from a persisted or AI-authored doc.
 *
 * Two-hop many-to-many is still out of scope here (see `findJoinPath` and
 * `enrichRowsWithRelatedFields` for that traversal); an M:N relationship's `sourceField`/
 * `targetField` are two endpoint keys, not a usable FK/PK pair.
 *
 * Note the widened predicate admits the ONE-to-many direction too (a widget on `customers`
 * reading a field from `orders`). That is deliberate — it is exactly what
 * `enrichRowsWithRelatedFields` does, and both share its display-column semantics: the lookup
 * map is first-write-wins, so such a row gets one representative related value rather than a
 * fan-out. Rendering one arbitrary related value is the documented behaviour of every sibling;
 * rendering an empty cell was not.
 *
 * First declaration wins on a duplicate related source, matching the array-order `find` in
 * `findDirectRelationship`/`findJoinPath` (the previous last-wins behaviour matched nothing).
 */
export function buildRelatedSourceJoinIndex(
  widgetSourceId: string,
  relationships: StudioRelationship[],
): Map<string, RelatedSourceJoin> {
  const relIndex = new Map<string, RelatedSourceJoin>();
  for (const r of relationships) {
    if (r.type === 'many-to-many') {
      continue;
    }
    if (r.sourceId === widgetSourceId && !relIndex.has(r.targetId)) {
      relIndex.set(r.targetId, {
        relationship: r,
        sourceField: r.sourceField,
        targetField: r.targetField,
      });
    } else if (r.targetId === widgetSourceId && !relIndex.has(r.sourceId)) {
      // Reverse-declared: the widget-side field is the relationship's `targetField` and the
      // related-side field is its `sourceField`.
      relIndex.set(r.sourceId, {
        relationship: r,
        sourceField: r.targetField,
        targetField: r.sourceField,
      });
    }
  }
  return relIndex;
}

/**
 * Compatibility alias for {@link buildRelatedSourceJoinIndex}, whose old name encoded the
 * narrowness that was the bug. Kept only so the remaining widget-level call sites
 * (`StudioGridWidget`'s `resolveCrossSourceFkFields`, `StudioMapWidget`'s `valueFkField`)
 * keep compiling; both read `.sourceField`, which the oriented result still exposes, so they
 * pick up the widened resolution unchanged. Migrate them to the new name and delete this.
 */
export const buildManyToOneRelationshipIndex = buildRelatedSourceJoinIndex;

/**
 * Returns the set of source IDs reachable from `sourceId` in one hop via declared relationships.
 * For many-to-many relationships, also includes the junction source and the remote endpoint.
 * Always includes `sourceId` itself.
 */
export function getReachableSourceIds(
  sourceId: string,
  relationships: StudioRelationship[],
): Set<string> {
  const reachable = new Set<string>([sourceId]);
  for (const rel of relationships) {
    if (rel.sourceId === sourceId) {
      reachable.add(rel.targetId);
      if (rel.type === 'many-to-many' && rel.junctionSourceId) {
        reachable.add(rel.junctionSourceId);
      }
    }
    if (rel.targetId === sourceId) {
      reachable.add(rel.sourceId);
      if (rel.type === 'many-to-many' && rel.junctionSourceId) {
        reachable.add(rel.junctionSourceId);
      }
    }
  }
  return reachable;
}

/**
 * Describes how to join widgetSource to filterSource:
 * - hops:1 — direct relationship (many-to-one or one-to-one), OR filterSource IS the junction
 *   source of an M:N relationship touching widgetSource (a genuine one-hop semi-join against the
 *   junction's own rows/fields — see the dedicated junction-source loop below, finding 3)
 * - hops:2 — many-to-many via a junction source, filtering on the REMOTE endpoint
 */
type JoinPath =
  | { hops: 1; widgetJoinField: string; filterJoinField: string }
  | {
      hops: 2;
      /** Field on widget rows to match into the junction. */
      widgetJoinField: string;
      junctionSourceId: string;
      /** Field in the junction source that references widgetSource. */
      junctionWidgetField: string;
      /** Field in the junction source that references filterSource. */
      junctionFilterField: string;
      /** Field on filter source rows that the junction references. */
      filterJoinField: string;
    };

/**
 * Returns a JoinPath describing how to link widgetSource to filterSource,
 * or null if no relationship path exists.
 * Checks direct relationships first, then many-to-many two-hop paths.
 */
function findJoinPath(
  widgetSourceId: string,
  filterSourceId: string,
  relationships: StudioRelationship[],
): JoinPath | null {
  // Direct (one-hop) relationship
  for (const rel of relationships) {
    if (rel.type === 'many-to-many') {
      continue; // handled below
    }
    if (rel.sourceId === widgetSourceId && rel.targetId === filterSourceId) {
      return { hops: 1, widgetJoinField: rel.sourceField, filterJoinField: rel.targetField };
    }
    if (rel.targetId === widgetSourceId && rel.sourceId === filterSourceId) {
      return { hops: 1, widgetJoinField: rel.targetField, filterJoinField: rel.sourceField };
    }
  }

  // Two-hop (many-to-many) relationship
  for (const rel of relationships) {
    if (rel.type !== 'many-to-many') {
      continue;
    }
    if (!rel.junctionSourceId || !rel.junctionSourceField || !rel.junctionTargetField) {
      continue; // incomplete M:N config — skip
    }

    if (rel.sourceId === widgetSourceId && rel.targetId === filterSourceId) {
      return {
        hops: 2,
        widgetJoinField: rel.sourceField,
        junctionSourceId: rel.junctionSourceId,
        junctionWidgetField: rel.junctionSourceField,
        junctionFilterField: rel.junctionTargetField,
        filterJoinField: rel.targetField,
      };
    }
    if (rel.targetId === widgetSourceId && rel.sourceId === filterSourceId) {
      return {
        hops: 2,
        widgetJoinField: rel.targetField,
        junctionSourceId: rel.junctionSourceId,
        junctionWidgetField: rel.junctionTargetField,
        junctionFilterField: rel.junctionSourceField,
        filterJoinField: rel.sourceField,
      };
    }
  }

  // filterSource IS the JUNCTION source of an M:N relationship touching widgetSource (finding 3).
  // A junction table is never a relationship's own `sourceId`/`targetId` (only its
  // `junctionSourceId`), so neither loop above ever matches it, and a filter whose
  // `filterSourceId` names the junction directly used to fall through to `findJoinPath` returning
  // `null` — silently DROPPING the filter at L3 for every widget except a junction-anchored chart
  // (which separately re-applies the equivalent filter at L4, `grainResolution.ts`'s
  // `anchorScopedFilters`). That let two widgets on the same page disagree about which rows
  // satisfy the identical nominal filter. This is a genuine one-hop semi-join against the
  // junction's OWN rows/fields — filter the junction rows directly (native fields, handled by the
  // caller same as any other foreign source), then keep widget rows whose join field appears
  // among the matching junction rows' widget-referencing field.
  for (const rel of relationships) {
    if (rel.type !== 'many-to-many' || rel.junctionSourceId !== filterSourceId) {
      continue;
    }
    if (!rel.junctionSourceField || !rel.junctionTargetField) {
      continue; // incomplete M:N config — skip (matches the two-hop completeness check above)
    }
    if (rel.sourceId === widgetSourceId) {
      return {
        hops: 1,
        widgetJoinField: rel.sourceField,
        filterJoinField: rel.junctionSourceField,
      };
    }
    if (rel.targetId === widgetSourceId) {
      return {
        hops: 1,
        widgetJoinField: rel.targetField,
        filterJoinField: rel.junctionTargetField,
      };
    }
  }

  return null;
}

/**
 * Dedupe for `warnUnappliedCrossFilter`. Module-level (not per call) because `resolveRows` runs
 * on every render of every widget — a per-call dedupe would still emit one warning per frame.
 * Keyed by the widget-source → filter-source pair, so it is bounded by the number of source
 * pairs in the doc.
 */
const unappliedCrossFilterWarnings = new Set<string>();

/**
 * Dev-only warning for a cross-source filter that could NOT be applied because the foreign
 * source is ADAPTER-BACKED and therefore has no in-memory rows.
 *
 * This is the fail-OPEN case, and fail-open on a filter is the worst possible default: the
 * widget still looks filtered (the chip/highlight state comes from the selectors, which never
 * consult row availability) while its numbers are unfiltered. `useAdapterRows` keeps fetched
 * rows in local React state and never writes them back to `dataSources[id].rows` (see
 * `widgetExport.ts`, which rebuilds the query descriptor precisely to read those rows out of
 * `studioRequestCache` instead) — so clicking a bar on an adapter-backed `customers` chart
 * wrote a cross-filter that a sibling `orders` grid silently ignored while visibly
 * participating in the interaction.
 *
 * Scoped to adapter-backed sources on purpose. A plain in-memory source with no rows yet is
 * the ordinary first-render state of every dashboard, and `collectJoinedSourceIds` has already
 * recorded the dependency, so `resolvedRowsCache` re-resolves the moment rows arrive — warning
 * there would fire on every boot for a condition that self-heals. An adapter-backed source has
 * no such later load: it is permanent.
 *
 * The behaviour is deliberately left fail-open rather than changed to fail-closed:
 *
 * - Fail-closed would empty the widget PERMANENTLY for an adapter-backed foreign source,
 *   turning a wrong-number bug into a dead-dashboard bug for an otherwise legitimate
 *   configuration.
 * - `resolveRows`'s other unresolvable-cross-filter arm (no declared join path, just below)
 *   already fails open by documented choice; flipping only one of the two would make the two
 *   answers to "this cross-filter cannot be evaluated" disagree — the exact class of bug this
 *   warning exists to surface.
 *
 * Surfacing it matches `createBatchingAdapter`'s "degrades to client-side, never silently
 * dropped" contract (`warnAdapterDivergence`). The real fix — resolving the foreign rows
 * through the same `studioRequestCache` lookup `widgetExport` uses — spans files outside this
 * module and is left as a follow-up.
 */
function warnUnappliedCrossFilter(
  widgetSourceId: string | undefined,
  filterSourceId: string,
  foreignSource: StudioDataSource | undefined,
) {
  if (process.env.NODE_ENV === 'production' || !foreignSource?.adapter) {
    return;
  }
  const key = `${widgetSourceId ?? '(none)'}→${filterSourceId}`;
  if (unappliedCrossFilterWarnings.has(key)) {
    return;
  }
  unappliedCrossFilterWarnings.add(key);
  console.warn(
    `MUI X Studio: a cross-source filter targeting the adapter-backed data source ` +
      `"${filterSourceId}" was NOT applied to a widget on "${widgetSourceId ?? '(no source)'}" ` +
      `because "${filterSourceId}" has no in-memory rows, so the semi-join could not be ` +
      `evaluated. The widget renders UNFILTERED rows while still appearing to participate in ` +
      `the filter. An adapter-backed source keeps its fetched rows in the requesting widget's ` +
      `local state, not in \`dataSources["${filterSourceId}"].rows\`. Provide rows for ` +
      `"${filterSourceId}" (\`setDataSourceRows\`) or avoid cross-filtering from an ` +
      `adapter-backed source.`,
  );
}

/**
 * Apply filters to widget rows, resolving cross-source filters via the declared
 * relationships. Cross-source filters (filterSourceId != widgetSourceId) are
 * applied to the foreign source first; the result semi-joins back to the widget's
 * rows using the join fields discovered from the relationship graph.
 *
 * Expression fields are evaluated and merged into rows before filtering, so that
 * filters can target computed columns.
 */
export function resolveRows(
  widgetRows: Row[],
  widgetSourceId: string | undefined,
  filters: StudioFilterState[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[] = [],
  expressionFields: StudioExpressionField[] = [],
  options?: {
    skipEnrichment?: boolean;
    usedFieldIds?: ReadonlySet<string>;
    /**
     * Out-param: when provided, every foreign source ID whose `rows` this call
     * actually read for a semi-join is added to this set. Callers (e.g.
     * `resolvedRowsCache`) use it to record the full set of foreign-row
     * dependencies — including derived cross-filter sources (a page filter on an
     * expression field owned by another source) and many-to-many junction
     * sources — which the incoming filter objects do not themselves declare.
     */
    collectJoinedSourceIds?: Set<string>;
  },
): Row[] {
  // Enrich rows with computed (non-measure) expression field values first so they
  // can be referenced in filters and downstream aggregations.
  // Uses enrichedRowsCache so filter changes don't force re-enrichment (L2 is
  // independent of filters — only dataSources/expressionFields/relationships matter).
  // Pass skipEnrichment: true when the caller has already enriched the rows (e.g.
  // KPI widget pre-enriches once and calls resolveRows twice for current/prev period).
  // Pass usedFieldIds to restrict enrichment to only the fields this widget uses
  // (lazy-by-widget mode — avoids recomputing on unused-expression additions).
  const enrichedRows = options?.skipEnrichment
    ? widgetRows
    : getCachedEnrichedRows(
        widgetRows,
        widgetSourceId,
        expressionFields,
        dataSources,
        relationships,
        options?.usedFieldIds,
        // Thread L2's join-source dependencies into the L3 caller's tracking. A widget-source
        // expression column that JOINs a foreign source (e.g. `customer_name =
        // join(customers.name)`) makes that foreign source's rows a real dependency of this
        // resolved result even with NO cross-filter present. Without recording it,
        // `resolvedRowsCache` keeps serving stale joined values — and filters ON that expression
        // column keep matching stale values — after the foreign source's rows refresh (finding 1.2).
        options?.collectJoinedSourceIds,
      );

  const nativeFilters: StudioFilterState[] = [];
  const crossFilters: (StudioFilterState & { filterSourceId: string })[] = [];

  // Pre-build index for O(1) expression field lookups (avoid repeated .find() in loop)
  const exprFieldIndex = new Map<string, (typeof expressionFields)[number]>();
  for (const ef of expressionFields) {
    if (ef.sourceId !== widgetSourceId && !ef.isMeasure) {
      exprFieldIndex.set(ef.id, ef);
    }
  }

  for (const f of filters) {
    // Dashboard date-range filters are scoped to their own source. A filter created
    // for source A must not be treated as a cross-filter against source B — it would
    // trigger a semi-join that returns zero rows when no relationship is declared.
    // selectFiltersForWidget (filterScoping.ts) applies this guard before callers reach
    // here; this check is a defensive invariant that should never fire in practice.
    if (
      f.scope.kind === 'dashboard-date-range' &&
      f.filterSourceId &&
      f.filterSourceId !== widgetSourceId
    ) {
      continue;
    }
    if (f.filterSourceId && f.filterSourceId !== widgetSourceId) {
      crossFilters.push(f as StudioFilterState & { filterSourceId: string });
    } else if (!f.filterSourceId && f.field) {
      // No filterSourceId set (e.g. page filters added via the Filters Drawer).
      // If the field is an expression owned by a different source, route it as a
      // cross-filter so the semi-join path enriches the foreign source correctly.
      // Without this, the field is undefined on the widget's own rows and every
      // row is silently filtered out.
      const exprOwner = f.field ? exprFieldIndex.get(f.field) : undefined;
      if (exprOwner) {
        crossFilters.push({ ...f, filterSourceId: exprOwner.sourceId } as StudioFilterState & {
          filterSourceId: string;
        });
      } else {
        nativeFilters.push(f);
      }
    } else {
      nativeFilters.push(f);
    }
  }

  let rows = enrichedRows;

  // Pre-enrich each distinct foreign source once, regardless of how many cross-filters
  // target it. Without this cache, each cross-filter re-runs enrichRowsWithExpressions
  // over the same foreign rows — O(crossFilters × foreignRows) instead of O(foreignRows).
  const foreignEnrichedCache = new Map<string, Row[]>();

  for (const f of crossFilters) {
    const foreignSource = dataSources[f.filterSourceId];
    // Record the foreign source this cross-filter depends on BEFORE any early-out
    // (covers derived filterSourceId from expression-owned page filters — f may not
    // be the same object the caller passed in). Recording here — even when the source
    // has no rows yet or no join path exists — lets `resolvedRowsCache` invalidate its
    // entry once that source later gains rows, instead of serving a stale unfiltered
    // result forever.
    options?.collectJoinedSourceIds?.add(f.filterSourceId);
    if (!foreignSource?.rows) {
      // Fail-open, but no longer silent for the case that can never self-heal — see
      // `warnUnappliedCrossFilter` for why fail-open is kept and what the real fix is.
      warnUnappliedCrossFilter(widgetSourceId, f.filterSourceId, foreignSource);
      continue;
    }

    const joinPath = findJoinPath(widgetSourceId ?? '', f.filterSourceId, relationships);
    if (!joinPath) {
      continue; // no declared relationship — skip rather than produce incorrect results
    }

    // Destructure filterSourceId out so baseFilter is a plain StudioFilterState for applyFilters
    const { filterSourceId: removedField, ...baseFilter } = f;
    void removedField;
    // Enrich the foreign source rows via enrichedRowsCache so filter changes don't
    // force re-enrichment of foreign sources (the enrich result is filter-independent).
    // The local foreignEnrichedCache is kept as a guard against duplicate lookups
    // within a single resolveRows call (multiple cross-filters on the same source).
    if (!foreignEnrichedCache.has(f.filterSourceId)) {
      foreignEnrichedCache.set(
        f.filterSourceId,
        getCachedEnrichedRows(
          foreignSource.rows,
          f.filterSourceId,
          expressionFields,
          dataSources,
          relationships,
          undefined,
          // The foreign source's own expression columns may JOIN yet another source; record
          // those targets so a later refresh of that transitive source also invalidates the L3
          // entry (finding 1.2).
          options?.collectJoinedSourceIds,
        ),
      );
    }

    const enrichedForeignRows = foreignEnrichedCache.get(f.filterSourceId)!;
    const matchingForeignRows = applyFilters(enrichedForeignRows, [baseFilter]);

    if (joinPath.hops === 1) {
      // One-hop (direct) semi-join: keep widget rows whose join field is in the allowed set.
      // Keys are normalized (normalizeJoinKey) so a numeric FK matches a string PK etc.
      const allowedValues = collectKeySet(matchingForeignRows, joinPath.filterJoinField);
      rows = rows.filter((r) => {
        const key = normalizeJoinKey(r[joinPath.widgetJoinField]);
        return key !== null && allowedValues.has(key);
      });
    } else {
      // Two-hop (M:N) semi-join via junction source:
      // 1. Collect the filter-side join values from matching foreign rows
      // 2. Walk the junction to find widget-side join values that link to those
      // 3. Keep widget rows in the resulting allowed set
      const matchingFilterValues = collectKeySet(matchingForeignRows, joinPath.filterJoinField);
      // Record the junction source whose rows we read for the two-hop semi-join.
      options?.collectJoinedSourceIds?.add(joinPath.junctionSourceId);
      const junctionRows = dataSources[joinPath.junctionSourceId]?.rows ?? [];
      const allowedWidgetValues = new Set<string>();
      for (const r of junctionRows) {
        const filterKey = normalizeJoinKey(r[joinPath.junctionFilterField]);
        if (filterKey !== null && matchingFilterValues.has(filterKey)) {
          const widgetKey = normalizeJoinKey(r[joinPath.junctionWidgetField]);
          if (widgetKey !== null) {
            allowedWidgetValues.add(widgetKey);
          }
        }
      }
      rows = rows.filter((r) => {
        const key = normalizeJoinKey(r[joinPath.widgetJoinField]);
        return key !== null && allowedWidgetValues.has(key);
      });
    }
  }

  return applyFilters(rows, nativeFilters);
}

/**
 * Enriches widget rows with fields from directly related sources (one-hop) or
 * many-to-many related sources (two-hop via junction).
 *
 * For one-hop joins: builds a lookup map (relatedJoinValue → fieldValue) and
 * copies the value onto each widget row.
 *
 * For many-to-many two-hop joins: builds a lookup
 * (widgetJoinValue → firstMatchingTargetFieldValue) via the junction table.
 * Uses the **first** matching junction row per widget row — this is DISPLAY-column
 * semantics only (one representative related value per widget row). It is deliberately
 * lossy for aggregation: an order linked to tags A+B collapses to a single arbitrary tag.
 * Aggregate/chart queries whose grouping dimension is owned by an M:N remote endpoint must
 * NOT rely on this path for the number — `analyzeChartSupport` either junction-anchors that
 * topology (so `resolveRowsAtGrain` fans each widget row out to one row per matching junction
 * entry, when the measure is widget-owned) or fails the chart closed as
 * `mixed_cross_source_fields` (when the measure anchors on a DIFFERENT many side and there is no
 * single combined grain — finding 1.1). This lookup is therefore reached for aggregation only in
 * the no-re-anchor (`anchorSourceId === widgetSourceId`) branch, where each widget row IS its own
 * group and a single representative related value per row is exactly right; every fan-out-unsafe
 * topology is anchored or rejected upstream before it can get here. (Earlier revisions of this
 * comment claimed "display columns only", which the M:1-anchor topology falsified before the
 * finding 1.1 guard was added — see review note D.2.)
 */
export function enrichRowsWithRelatedFields(
  rows: Row[],
  widgetSourceId: string | undefined,
  fieldIds: string[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  /**
   * Out-param: every foreign source id whose rows this enrichment actually reads (a related
   * source for a one-hop display column, or the remote endpoint + junction source for a
   * two-hop many-to-many column) is added to it. Lets a caller building its own dependency
   * cache (the L4 `rcfaCache`) invalidate when those foreign rows change (finding 1.5).
   */
  collectReadSourceIds?: Set<string>,
): Row[] {
  if (!widgetSourceId || rows.length === 0 || fieldIds.length === 0) {
    return rows;
  }

  const widgetSource = dataSources[widgetSourceId];
  const nativeFieldIds = new Set(widgetSource?.fields.map((f) => f.id) ?? []);

  type DirectNeed = {
    kind: 'direct';
    fieldId: string;
    widgetJoinField: string;
    relatedJoinField: string;
    relatedRows: Row[];
  };
  type ManyToManyNeed = {
    kind: 'many-to-many';
    fieldId: string;
    widgetJoinField: string;
    junctionSourceId: string;
    junctionWidgetField: string;
    junctionTargetField: string;
    targetJoinField: string;
    targetRows: Row[];
  };

  const foreignFieldNeeds: Array<DirectNeed | ManyToManyNeed> = [];

  for (const fieldId of fieldIds) {
    if (nativeFieldIds.has(fieldId)) {
      continue;
    }

    let resolved = false;

    // Try direct (one-hop) relationships first
    for (const rel of relationships) {
      if (rel.type === 'many-to-many') {
        continue;
      }
      let relatedSourceId: string | null = null;
      let widgetJoinField: string | null = null;
      let relatedJoinField: string | null = null;

      if (rel.sourceId === widgetSourceId) {
        relatedSourceId = rel.targetId;
        widgetJoinField = rel.sourceField;
        relatedJoinField = rel.targetField;
      } else if (rel.targetId === widgetSourceId) {
        relatedSourceId = rel.sourceId;
        widgetJoinField = rel.targetField;
        relatedJoinField = rel.sourceField;
      } else {
        continue;
      }

      const relatedSource = dataSources[relatedSourceId];
      if (!relatedSource?.fields.some((f) => f.id === fieldId)) {
        continue;
      }

      collectReadSourceIds?.add(relatedSourceId);
      foreignFieldNeeds.push({
        kind: 'direct',
        fieldId,
        widgetJoinField,
        relatedJoinField,
        // Route through the same L1 date normalization the widget's own source rows get
        // (`getCachedNormalizedDataSource`) rather than reading raw rows — otherwise a date/
        // datetime dimension pulled in from a one-hop related source stays a raw `Date`/non-
        // canonical string here, and the filter engine's local-calendar-day policy and the chart-
        // grouping engine's UTC-component policy can bucket the identical value into different
        // days for a non-UTC viewer (finding 4).
        relatedRows: getCachedNormalizedDataSource(relatedSource).rows ?? [],
      });
      resolved = true;
      break;
    }

    if (resolved) {
      continue;
    }

    // Try many-to-many two-hop relationships
    for (const rel of relationships) {
      if (rel.type !== 'many-to-many') {
        continue;
      }
      if (!rel.junctionSourceId || !rel.junctionSourceField || !rel.junctionTargetField) {
        continue;
      }

      let targetSourceId: string | null = null;
      let widgetJoinField: string | null = null;
      let junctionWidgetField: string | null = null;
      let junctionTargetField: string | null = null;
      let targetJoinField: string | null = null;

      if (rel.sourceId === widgetSourceId) {
        targetSourceId = rel.targetId;
        widgetJoinField = rel.sourceField;
        junctionWidgetField = rel.junctionSourceField;
        junctionTargetField = rel.junctionTargetField;
        targetJoinField = rel.targetField;
      } else if (rel.targetId === widgetSourceId) {
        targetSourceId = rel.sourceId;
        widgetJoinField = rel.targetField;
        junctionWidgetField = rel.junctionTargetField;
        junctionTargetField = rel.junctionSourceField;
        targetJoinField = rel.sourceField;
      } else {
        continue;
      }

      const targetSource = dataSources[targetSourceId];
      if (!targetSource?.fields.some((f) => f.id === fieldId)) {
        continue;
      }

      collectReadSourceIds?.add(targetSourceId);
      collectReadSourceIds?.add(rel.junctionSourceId);
      foreignFieldNeeds.push({
        kind: 'many-to-many',
        fieldId,
        widgetJoinField,
        junctionSourceId: rel.junctionSourceId,
        junctionWidgetField,
        junctionTargetField,
        targetJoinField,
        // Same L1 date normalization as the direct one-hop case above (finding 4).
        targetRows: getCachedNormalizedDataSource(targetSource).rows ?? [],
      });
      break;
    }
  }

  if (foreignFieldNeeds.length === 0) {
    return rows;
  }

  // Build lookup maps. Keys are normalized (normalizeJoinKey) so a numeric FK
  // matches a string PK etc. — the single join-key policy shared with the chart,
  // filter and grid paths.
  const lookups: Array<{
    fieldId: string;
    widgetJoinField: string;
    map: Map<string, unknown>;
  }> = [];

  for (const need of foreignFieldNeeds) {
    if (need.kind === 'direct') {
      const map = new Map<string, unknown>();
      for (const row of need.relatedRows) {
        const key = normalizeJoinKey(row[need.relatedJoinField]);
        if (key !== null && !map.has(key)) {
          map.set(key, row[need.fieldId]);
        }
      }
      lookups.push({ fieldId: need.fieldId, widgetJoinField: need.widgetJoinField, map });
    } else {
      // Build: widgetJoinValue → first matching target field value via junction. Same L1 date
      // normalization as the target/related rows above — a junction-owned date/datetime column
      // read as a display field must canonicalize identically (finding 4).
      const junctionDataSource = dataSources[need.junctionSourceId];
      const junctionRows = junctionDataSource
        ? (getCachedNormalizedDataSource(junctionDataSource).rows ?? [])
        : [];
      // targetJoinValue → fieldValue
      const targetLookup = new Map<string, unknown>();
      for (const row of need.targetRows) {
        const key = normalizeJoinKey(row[need.targetJoinField]);
        if (key !== null && !targetLookup.has(key)) {
          targetLookup.set(key, row[need.fieldId]);
        }
      }
      // widgetJoinValue → first target field value
      const map = new Map<string, unknown>();
      for (const jRow of junctionRows) {
        const widgetKey = normalizeJoinKey(jRow[need.junctionWidgetField]);
        if (widgetKey === null || map.has(widgetKey)) {
          continue;
        }
        const targetKey = normalizeJoinKey(jRow[need.junctionTargetField]);
        map.set(widgetKey, targetKey === null ? undefined : targetLookup.get(targetKey));
      }
      lookups.push({ fieldId: need.fieldId, widgetJoinField: need.widgetJoinField, map });
    }
  }

  // Enrich rows (non-mutating)
  return rows.map((row) => {
    const extras: Row = {};
    for (const { fieldId, widgetJoinField, map } of lookups) {
      if (!(fieldId in row)) {
        const key = normalizeJoinKey(row[widgetJoinField]);
        extras[fieldId] = key === null ? undefined : map.get(key);
      }
    }
    return Object.keys(extras).length > 0 ? { ...row, ...extras } : row;
  });
}
