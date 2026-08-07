import type {
  StudioDataSource,
  StudioExpressionField,
  StudioGridColumn,
  StudioGridSummaryAggregation,
  StudioRelationship,
} from '../models';
import { buildRelatedSourceJoinIndex } from '../engine/dataSourceGraph';
import { getCachedEnrichedRows } from '../engine/enrichedRowsCache';
import { getCachedNormalizedDataSource } from '../engine/normalizedRowsCache';
import { indexRowsByKey, normalizeJoinKey } from '../engine/joinKeys';
import { aggregateCellValues } from '../engine/aggregate';

/**
 * Aggregates an array of already-extracted cell values for one field/aggregation combination — the
 * core reducer shared by the row-based grid-grouping path below
 * (`aggregateGridValue`/`buildGroupedGridRows`) and DataGridPremium's native per-column aggregation
 * functions (`StudioGridWidget.tsx`'s `aggregationFunctions`), which extract a `(dedupeKey, value)`
 * pair per row via `getCellValue` and dedupe fanned-out cross-source values by key before calling
 * this on the deduped value list — see `StudioGridWidget.tsx` for why the native grouping path
 * needs the same fan-out-safe dedup this module's `symmetricAggregate` already implements.
 */
export function aggregateValues(
  values: unknown[],
  aggregation: StudioGridSummaryAggregation,
): number | null {
  // Delegates wholesale to the shared `aggregateCellValues` — the single place that decides what
  // each aggregation NAME means over a row set. Every semantic this function had is preserved:
  // `count` is `COUNT(*)` (one entry per row, nulls included), `count_distinct` excludes
  // null/undefined and is measured over the RAW values, and `sum`/`avg`/`min`/`max` route through
  // the shared null-skip + boolean/ numeric-string coercion, so an empty set gives `sum` 0 and
  // `avg`/`min`/`max` `null` rather than a fabricated 0.
  return aggregateCellValues(values, aggregation);
}

function aggregateGridValue(
  rows: Record<string, unknown>[],
  fieldId: string,
  aggregation: StudioGridSummaryAggregation,
) {
  return aggregateValues(
    rows.map((row) => row[fieldId]),
    aggregation,
  );
}

/**
 * Symmetric aggregate — avoids fan-out double-counting when a cross-source field
 * is duplicated across related rows.
 *
 * For a many-to-one column (e.g. orders.total on an order-items grouping), each
 * unique FK value contributes exactly once. The FK field is read from the
 * widget-source rows and deduplicated; then the related-source row map is used
 * to look up the actual value for aggregation.
 *
 * A one-to-one or reverse-declared relationship reaches this too (the join index is
 * direction-independent). There the dedup is a no-op — each widget row already has a distinct
 * join value — and the related-row map's first-write-wins lookup yields one representative
 * related value per row, the same display-column semantics `enrichRowsWithRelatedFields` and
 * `crossSourceEnrichment` use for the identical topology.
 *
 * Falls back to `aggregateGridValue` for same-source fields.
 */
function symmetricAggregate(
  groupRows: Record<string, unknown>[],
  fkField: string,
  relatedRowMap: Map<string, Record<string, unknown>>,
  valueField: string,
  fn: StudioGridSummaryAggregation,
): number | null {
  const seenFks = new Set<string>();
  const deduped: Record<string, unknown>[] = [];

  for (const row of groupRows) {
    // Normalized join key (shared policy, internals/joinKeys.ts). A missing FK
    // (null/undefined) never joins, so an unlinked row contributes nothing.
    const fkValue = normalizeJoinKey(row[fkField]);
    if (fkValue !== null && !seenFks.has(fkValue)) {
      seenFks.add(fkValue);
      const relatedRow = relatedRowMap.get(fkValue);
      if (relatedRow) {
        deduped.push(relatedRow);
      }
    }
  }

  return aggregateGridValue(deduped, valueField, fn);
}

export function buildGroupedGridRows(
  rows: Record<string, unknown>[],
  groupByField: string,
  visibleFields: string[],
  aggregations: Record<string, StudioGridSummaryAggregation>,
  widgetId: string,
  /** Optional: full column definitions for cross-source aggregation. */
  columns?: StudioGridColumn[],
  /** Optional: all data sources keyed by ID (needed for cross-source columns). */
  dataSources?: Record<string, StudioDataSource>,
  /** Optional: declared relationships for fan-out detection. */
  relationships?: StudioRelationship[],
  /** Optional: the widget's primary source ID. */
  widgetSourceId?: string,
  /**
   * Optional: expression fields — used to L2-enrich a related source's rows when a
   * cross-source column is that source's calculated column, so its value
   * is present before the per-PK lookup map is built. Physical cross-source columns are
   * unaffected.
   */
  expressionFields?: StudioExpressionField[],
) {
  // Build per-column cross-source context once (before grouping loop)
  const crossSourceMeta = new Map<
    string,
    { fkField: string; relatedRowMap: Map<string, Record<string, unknown>> }
  >();

  if (columns && dataSources && relationships && widgetSourceId) {
    // relatedSourceId → oriented one-hop join — shared traversal step, see
    // dataSourceGraph.buildRelatedSourceJoinIndex. Direction-independent and not limited to
    // `many-to-one`, matching the display path (`crossSourceEnrichment`) it must agree with.
    const relIndex = buildRelatedSourceJoinIndex(widgetSourceId, relationships);

    for (const col of columns) {
      if (!col.sourceId || col.sourceId === widgetSourceId) {
        continue;
      }
      // Find the direct relationship between widgetSourceId and col.sourceId (either direction)
      const rel = relIndex.get(col.sourceId);
      if (!rel) {
        continue;
      }
      const relatedSource = dataSources[col.sourceId];
      if (!relatedSource?.rows) {
        continue;
      }
      // L1-normalize the related source's rows before anything reads them, exactly as
      // `crossSourceEnrichment.enrichWithCrossSourceFields` does for the display path. Raw
      // rows carry `Date` objects and non-canonical date strings, so a `count_distinct` over
      // a related `date` column built a Set of distinct OBJECT references — two customers who
      // signed up on the same day counted as two — while the cells rendered beside that total
      // came through the normalized path as `'2024-01-15'` strings and collapsed correctly.
      //
      // Passing NO `usedFieldIds` is deliberate: it selects the same ('*') cache slot as the
      // enrichment path, so both hand the identical rows array to `getCachedEnrichedRows` and
      // therefore share one `enrichedRowsCache` entry. Keying a different slot let a related
      // source's calculated column evaluate against un-normalized dates in the group aggregate
      // and normalized dates in the display — two values for one column.
      const normalizedRelatedRows = (getCachedNormalizedDataSource(relatedSource).rows ??
        []) as Record<string, unknown>[];
      // A cross-source column that is the related source's calculated column has no value
      // on the raw related rows — route them through the shared L2 cache (scoped to just
      // this field id) first, matching the display/export enrichment path.
      const isRelatedExpression = (expressionFields ?? []).some(
        (ef) => ef.id === col.fieldId && ef.sourceId === col.sourceId && !ef.isMeasure,
      );
      const relatedRows =
        isRelatedExpression && expressionFields
          ? (getCachedEnrichedRows(
              normalizedRelatedRows,
              col.sourceId,
              expressionFields,
              dataSources,
              relationships,
              new Set([col.fieldId]),
            ) as Record<string, unknown>[])
          : normalizedRelatedRows;
      // Index related rows by their PK for fast look-up, using the shared join-key
      // policy (internals/joinKeys.ts) so a numeric PK matches a string FK etc.
      const relatedRowMap = indexRowsByKey(relatedRows, rel.targetField);
      crossSourceMeta.set(col.fieldId, { fkField: rel.sourceField, relatedRowMap });
    }
  }

  const groups = new Map<string, Record<string, unknown>[]>();

  rows.forEach((row) => {
    const key = String(row[groupByField] ?? '');
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  });

  return Array.from(groups.entries()).map(([groupKey, groupRows], index) => {
    const firstRow = groupRows[0] ?? {};
    const groupedRow: Record<string, unknown> = {
      __rowId: `group-${widgetId}-${index}`,
      [groupByField]: firstRow[groupByField] ?? groupKey,
    };

    visibleFields.forEach((fieldId) => {
      if (fieldId === groupByField) {
        groupedRow[fieldId] = firstRow[fieldId] ?? groupKey;
        return;
      }

      const aggregation = aggregations[fieldId];

      const crossSource = crossSourceMeta.get(fieldId);
      if (crossSource && aggregation) {
        groupedRow[fieldId] = symmetricAggregate(
          groupRows,
          crossSource.fkField,
          crossSource.relatedRowMap,
          fieldId,
          aggregation,
        );
        return;
      }

      if (aggregation) {
        groupedRow[fieldId] = aggregateGridValue(groupRows, fieldId, aggregation);
        return;
      }

      groupedRow[fieldId] = firstRow[fieldId] ?? null;
    });

    return groupedRow;
  });
}
