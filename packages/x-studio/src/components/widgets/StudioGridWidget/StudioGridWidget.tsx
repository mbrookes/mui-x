'use client';
import * as React from 'react';
import { Alert } from '@mui/material';
import {
  DataGridPremium,
  useGridApiRef,
  type GridColDef,
  type GridCellParams,
  type GridAggregationFunction,
  type GridAggregationModel,
  type GridRowClassNameParams,
  type GridValidRowModel,
} from '@mui/x-data-grid-premium';

import type {
  StudioConditionalFormat,
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioGridSummaryAggregation,
  StudioRelationship,
  StudioWidgetConfig,
  StudioWidgetOf,
} from '../../../models';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectGlobalCrossFilterMode,
  makeSelectExpressionFieldsForSources,
} from '../../../context';
import { formatFieldValue } from '../../../internals/numberFormat';

import { computeGridSummary } from '../../../utils/gridSummary';
import { aggregateValues } from '../../../utils/gridGrouping';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { getRowIdentity } from '../../../internals/rowIdentity';
import {
  buildManyToOneRelationshipIndex,
  getReachableSourceIds,
} from '../../../internals/dataSourceGraph';
import { normalizeJoinKey } from '../../../internals/joinKeys';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import { crossFilterValueEquals } from '../StudioChartWidget/chartWidgetHelpers';

/** Maps our model's aggregation names to DataGridPremium built-in function names. */
function toGridAggFn(fn: string): string {
  return fn === 'count' ? 'size' : fn;
}

/**
 * `config.gridSummaryFields`/`config.gridAggregations` are keyed by
 * `GridSetupPanel`'s composite column key (`sourceId/fieldId` for a cross-source
 * column, bare `fieldId` for a primary one — see `GridSetupPanel.tsx`'s
 * `columnAggKey`), so that two selected columns sharing a bare field id across
 * sources get independent aggregation-menu entries instead of silently colliding
 * (architecture review: per-column aggregation collision). Aggregating an actual
 * row only ever needs the bare field id though — every row's cell lives under the
 * plain field name regardless of which source it was cross-source-enriched from,
 * and DataGridPremium's own `GridColDef.field`/pinned-summary-row keys are always
 * the bare field id too — so translate composite keys back to their bare field id
 * here, at the single point both the native `aggregationModel` and the
 * summary-row computation read from `config.gridAggregations`/
 * `config.gridSummaryFields`.
 */
export function resolveAggregationFieldKeys<T>(
  aggregations: Record<string, T> | undefined,
): Record<string, T> {
  if (!aggregations) {
    return {};
  }
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(aggregations)) {
    const slashIndex = key.indexOf('/');
    const fieldId = slashIndex === -1 ? key : key.slice(slashIndex + 1);
    result[fieldId] = value;
  }
  return result;
}

/**
 * fieldId → FK field (on the widget's own source) for every configured column that
 * is cross-source (many-to-one related) AND fanned out by row enrichment
 * (`useWidgetRows.ts`'s `enrichWithCrossSourceFields`) — i.e. the exact set of
 * columns whose value is duplicated across every row sharing the same FK. Mirrors
 * `utils/gridGrouping.ts`'s `crossSourceMeta` construction in `buildGroupedGridRows`.
 *
 * Used by `makeFanoutSafeAggregationFunction` below to dedupe by FK before reducing,
 * so grouping+aggregating a fanned-out column (e.g. summing `orders.total` on an
 * `order_items` grid grouped by category) counts each linked one-side record once,
 * not once per many-side row (architecture review finding 2.7).
 */
export function resolveCrossSourceFkFields(
  configColumns: StudioWidgetConfig['columns'],
  widgetSourceId: string | undefined,
  relationships: StudioRelationship[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (!widgetSourceId) {
    return map;
  }
  const relIndex = buildManyToOneRelationshipIndex(widgetSourceId, relationships);
  for (const c of configColumns ?? []) {
    if (!c.sourceId || c.sourceId === widgetSourceId) {
      continue;
    }
    const rel = relIndex.get(c.sourceId);
    if (rel) {
      map.set(c.fieldId, rel.sourceField);
    }
  }
  return map;
}

/**
 * A `GridAggregationFunction` that dedupes fanned-out cross-source values before
 * reducing, so the native DataGridPremium `rowGroupingModel`/`aggregationModel`
 * path no longer double-counts a many-to-one joined column the way a naive per-row
 * sum would (architecture review finding 2.7). Also used for the widget's OWN
 * (non-cross-source) fields — for those, `crossSourceFkFields` has no entry, so the
 * dedupe key falls back to the row's own (always-unique, see the `rows` memo
 * below) id, making the dedupe pass a no-op and preserving prior behaviour exactly.
 *
 * `getCellValue` extracts a `(dedupeKey, value)` pair per row instead of the raw
 * cell value (DataGridPremium's supported extensibility point for aggregating from
 * more than one row field — see `GridAggregationFunction.getCellValue`); `apply`
 * dedupes by that key using the same join-key coercion policy as the rest of the
 * pipeline (`normalizeJoinKey`) before delegating to the shared reducer
 * (`utils/gridGrouping.ts`'s `aggregateValues`, the same one `symmetricAggregate`
 * uses) — a missing FK contributes nothing, matching `symmetricAggregate`.
 */
export function makeFanoutSafeAggregationFunction(
  fn: StudioGridSummaryAggregation,
  crossSourceFkFields: Map<string, string>,
  columnTypes?: string[],
): GridAggregationFunction<{ dedupeKey: unknown; value: unknown }, number | null> {
  return {
    getCellValue: ({ row, field }) => {
      const fkField = crossSourceFkFields.get(field);
      const record = row as Record<string, unknown>;
      return {
        dedupeKey: fkField ? record[fkField] : record.id,
        value: record[field],
      };
    },
    apply: ({ values }) => {
      const seen = new Set<string>();
      const deduped: unknown[] = [];
      for (const entry of values) {
        if (!entry) {
          continue;
        }
        // A missing/unlinked FK never joins (matches `symmetricAggregate`'s
        // null-FK-drops-nothing policy) — contribute nothing rather than guess.
        const key = normalizeJoinKey(entry.dedupeKey);
        if (key === null || seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(entry.value);
      }
      return aggregateValues(deduped, fn);
    },
    columnTypes,
    // Aggregated count/distinct-count values aren't in the same unit as the
    // underlying field (e.g. a currency column's count is a plain integer), so
    // the column's own value formatter must not apply — mirrors DataGridPremium's
    // native `size` function.
    hasCellUnit: fn !== 'count' && fn !== 'count_distinct',
  };
}

/**
 * Column render order follows the user-configured order (`configColumns`, as
 * authored via drag-and-drop / keyboard reorder in `GridSetupPanel`), not the
 * data-source field order — configured fields first (in their stored order),
 * then any remaining fields not yet added to `config.columns`. (Finding 1.2:
 * `config.columns` used to drive only visibility, never order.)
 */
export function computeOrderedFieldIds(
  configColumns: StudioWidgetConfig['columns'],
  allFieldIds: string[],
): string[] {
  const configuredIds = (configColumns ?? [])
    .map((c) => c.fieldId)
    .filter((id) => allFieldIds.includes(id));
  const configuredSet = new Set(configuredIds);
  const remaining = allFieldIds.filter((id) => !configuredSet.has(id));
  return [...configuredIds, ...remaining];
}

/**
 * Resolves the field definition for every CROSS-SOURCE configured column (a
 * `config.columns` entry whose `sourceId` differs from the widget's own source) by
 * looking it up on `dataSources[c.sourceId]` — the exact same resolution
 * `useWidgetRows.ts`'s row enrichment already performs for the VALUES of these
 * columns (see `enrichWithCrossSourceFields`).
 *
 * Before this, `computeOrderedFieldIds` only ever saw the widget's own source's
 * field ids plus expression-field ids (`allFieldIds`), so a configured cross-source
 * column's id never appeared there and was silently filtered out — the column had
 * a real, enriched value on every row, but no `GridColDef` was ever built for it and
 * it never rendered (architecture review finding 1.1). Exported so both the
 * component and its tests exercise the identical resolution.
 *
 * A related source's **calculated column** (an expression field owned by `c.sourceId`)
 * is also offered by `GridSetupPanel`, but has no physical field def — it is resolved
 * here by falling back to the related source's non-measure `expressionFields`, normalized
 * to the `StudioDataField` shape (so its label/format/type feed the column def and CSV
 * export the same way a physical cross-source column does). Without this the calculated
 * cross-source column was selectable but produced no column def, so it never rendered
 * (architecture review finding 2.3).
 */
export function resolveCrossSourceFieldDefs(
  configColumns: StudioWidgetConfig['columns'],
  ownSourceId: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  expressionFields: StudioExpressionField[] = [],
): Map<string, StudioDataField> {
  const map = new Map<string, StudioDataField>();
  for (const c of configColumns ?? []) {
    if (!c.sourceId || c.sourceId === ownSourceId) {
      continue;
    }
    const field = dataSources[c.sourceId]?.fields.find((f) => f.id === c.fieldId);
    if (field) {
      map.set(c.fieldId, field);
      continue;
    }
    // Related-source calculated column (finding 2.3) — resolve from the related source's
    // own non-measure expression fields.
    const ef = expressionFields.find(
      (candidate) =>
        candidate.id === c.fieldId && candidate.sourceId === c.sourceId && !candidate.isMeasure,
    );
    if (ef) {
      map.set(c.fieldId, {
        id: ef.id,
        label: ef.label,
        type: ef.type ?? 'number',
        format: ef.format,
        precision: ef.precision,
        currencyCode: ef.currencyCode,
      });
    }
  }
  return map;
}

/**
 * Builds the grid's `GridColDef[]` for the given (already-ordered) field ids,
 * resolving each field's definition from — in priority order — the widget's own
 * data source, its (own-source) expression fields, and finally
 * `crossSourceFieldDefs` (see {@link resolveCrossSourceFieldDefs}).
 *
 * Exported so a test can assert the production column-def path actually produces a
 * `GridColDef` for a configured cross-source column, without bypassing it via a
 * `slotProps.dataGrid.columns` override (architecture review finding 1.1's
 * regression-test gap).
 */
export function buildGridColumnDefs(
  orderedFieldIds: string[],
  dataSource: StudioDataSource | undefined,
  expressionFields: StudioExpressionField[],
  crossSourceFieldDefs: Map<string, StudioDataField>,
  isEditable: boolean,
  pkField: string | undefined,
): GridColDef[] {
  return orderedFieldIds.map((fieldName) => {
    const field = dataSource?.fields.find((candidate) => candidate.id === fieldName);
    const expressionField = expressionFields.find((candidate) => candidate.id === fieldName);
    const crossSourceField =
      !field && !expressionField ? crossSourceFieldDefs.get(fieldName) : undefined;
    const fieldType = field?.type ?? expressionField?.type ?? crossSourceField?.type;
    const fieldFormat = field?.format ?? expressionField?.format ?? crossSourceField?.format;
    const fieldPrecision =
      field?.precision ?? expressionField?.precision ?? crossSourceField?.precision;

    return {
      field: fieldName,
      flex: 1,
      headerName: field?.label ?? expressionField?.label ?? crossSourceField?.label ?? fieldName,
      minWidth: 140,
      type: fieldType === 'number' ? 'number' : 'string',
      // Enable editing for non-PK columns when write-back is configured. Cross-source
      // display columns are never editable — write-back only targets the widget's own
      // (primary) table via `gridPkField`, and a cross-source column's value lives on a
      // different table entirely.
      editable: isEditable && fieldName !== pkField && !crossSourceField,
      valueFormatter:
        fieldType === 'number' && fieldFormat
          ? (value: unknown) => {
              // Summary row cells contain pre-formatted strings (e.g. "Total: $1,234").
              // Pass them through as-is; only apply numeric formatting to actual numbers.
              if (typeof value === 'string') {
                return value;
              }
              return formatFieldValue(value, {
                type: 'number',
                format: fieldFormat,
                precision: fieldPrecision,
                currencyCode:
                  field?.currencyCode ??
                  expressionField?.currencyCode ??
                  crossSourceField?.currencyCode,
              });
            }
          : undefined,
    };
  });
}

type EnrichedMutationError = Error & { gridRowId: string; gridField: string };

/**
 * Tags a write-back failure with the row/field being edited so
 * `onProcessRowUpdateError` can revert the stuck cell. Used both for adapter
 * rejections (thrown/rejected `submitMutation` calls) and graceful `{ ok: false }`
 * results, so both failure shapes revert identically.
 */
function toEnrichedMutationError(
  err: unknown,
  rowId: string,
  field: string,
): EnrichedMutationError {
  const error = (err instanceof Error ? err : new Error(String(err))) as EnrichedMutationError;
  error.gridRowId = rowId;
  error.gridField = field;
  return error;
}

export function evalConditionalFormat(rule: StudioConditionalFormat, cellValue: unknown): boolean {
  const { operator, value } = rule;
  if (operator === 'is_empty') {
    return cellValue === null || cellValue === undefined || cellValue === '';
  }
  if (operator === 'is_not_empty') {
    return cellValue !== null && cellValue !== undefined && cellValue !== '';
  }
  if (value === undefined || value === null) {
    return false;
  }
  switch (operator) {
    case 'equals':
      // eslint-disable-next-line eqeqeq
      return cellValue == value;
    case 'not_equals':
      // eslint-disable-next-line eqeqeq
      return cellValue != value;
    case 'greater_than':
    case 'less_than':
    case 'greater_than_or_equal':
    case 'less_than_or_equal': {
      // A numeric comparison must never match an empty cell: `Number(null)`/`Number('')`
      // coerce to 0, so a `less_than 5` rule would spuriously highlight genuinely empty
      // cells as if they held 0 (finding 3.5). Empty cells are matched only by `is_empty`.
      if (cellValue === null || cellValue === undefined || cellValue === '') {
        return false;
      }
      const cell = Number(cellValue);
      const bound = Number(value);
      if (operator === 'greater_than') {
        return cell > bound;
      }
      if (operator === 'less_than') {
        return cell < bound;
      }
      if (operator === 'greater_than_or_equal') {
        return cell >= bound;
      }
      return cell <= bound;
    }
    case 'contains':
      return String(cellValue ?? '')
        .toLowerCase()
        .includes(String(value).toLowerCase());
    default:
      return false;
  }
}

export interface StudioGridWidgetProps {
  widget: StudioWidgetOf<'grid'>;
  dataSource?: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope cross-filters to the correct page. */
  pageId: string;
  /** Props forwarded to the underlying `DataGridPremium`. */
  slotProps?: {
    dataGrid?: Partial<import('@mui/x-data-grid-premium').DataGridPremiumProps>;
  };
}

export const StudioGridWidget = React.memo(function StudioGridWidget(props: StudioGridWidgetProps) {
  const { dataSource, widget, pageId, slotProps } = props;
  const controller = useStudioController();
  const filters = useStudioSelector(selectFilters);
  const localeText = useStudioLocaleText();
  // Full data-source map — needed to resolve cross-source configured columns'
  // field definitions (finding 1.1), the same way `useWidgetRows.ts`'s row
  // enrichment resolves their VALUES.
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  // Expression fields for the widget's own source AND every one-hop related source.
  // The related-source subset is needed so a cross-source column that is a related
  // source's calculated column (`GridSetupPanel` offers these) can be resolved to a
  // column def and enriched with a real value (finding 2.3); mirrors the own+related
  // scoping `useWidgetRows` already subscribes to.
  const relevantSourceIds = React.useMemo(
    () =>
      widget.sourceId ? getReachableSourceIds(widget.sourceId, relationships) : new Set<string>(),
    [widget.sourceId, relationships],
  );
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSources(relevantSourceIds),
    [relevantSourceIds],
  );
  const allExpressionFields = useStudioSelector(selectExpressionFields);
  // Own-source expression fields only — these are the widget's own calculated columns,
  // resolved/rendered as native columns. Related-source expression fields must NOT leak
  // into this list, or `buildGridColumnDefs`/`allFieldIds` would treat them as own columns.
  const expressionFields = React.useMemo(
    () => allExpressionFields.filter((ef) => ef.sourceId === widget.sourceId),
    [allExpressionFields, widget.sourceId],
  );
  const visibleFields = React.useMemo(
    () =>
      widget.config.columns?.length
        ? widget.config.columns.map((c) => c.fieldId)
        : (dataSource?.fields.map((f) => f.id) ?? []),
    [widget.config.columns, dataSource?.fields],
  );

  // Check if this widget has an active cross-filter (on its own page)
  const activeCrossFilter = React.useMemo(
    () =>
      filters.find(
        (f) =>
          f.scope.kind === 'cross-filter' &&
          f.scope.sourceWidgetId === widget.id &&
          f.scope.pageId === pageId,
      ) ?? null,
    [filters, widget.id, pageId],
  );

  // Write-back: enabled when the adapter implements submitMutation and gridPkField is set.
  const pkField = widget.config.gridPkField;
  const isEditable = Boolean(dataSource?.adapter?.submitMutation && pkField);

  // Surfaces failures from `processRowUpdate` (write-back mutation errors) since
  // there is no snackbar/toast in x-studio — see `onProcessRowUpdateError` below.
  const [mutationError, setMutationError] = React.useState<string | null>(null);
  const apiRef = useGridApiRef();

  const crossSourceFieldDefs = React.useMemo(
    () =>
      resolveCrossSourceFieldDefs(
        widget.config.columns,
        widget.sourceId,
        dataSources,
        allExpressionFields,
      ),
    [widget.config.columns, widget.sourceId, dataSources, allExpressionFields],
  );

  // fieldId → FK field, for every configured cross-source column that is fanned out
  // by row enrichment — used to dedupe fan-out double-counting in the native
  // grouping aggregation below (finding 2.7) and the footer summary (finding 1.2).
  const crossSourceFkFields = React.useMemo(
    () => resolveCrossSourceFkFields(widget.config.columns, widget.sourceId, relationships),
    [widget.config.columns, widget.sourceId, relationships],
  );

  // Related-source EXPRESSION columns (finding 1.1): the shared `useWidgetRows` cross-source
  // enrichment now threads `expressionFields`, so a related-source *calculated* column is
  // L2-enriched and joined onto the widget rows on the shared path — no widget-local
  // supplemental pass is needed here. (This module previously carried its own
  // `enrichRelatedExpressionColumns` pass to patch the gap the shared call left; it was
  // removed once the shared path covered it, to avoid redundant sibling-drift.)

  const aggregationFunctions = React.useMemo<Record<string, GridAggregationFunction>>(
    () => ({
      sum: makeFanoutSafeAggregationFunction('sum', crossSourceFkFields, ['number']),
      avg: makeFanoutSafeAggregationFunction('avg', crossSourceFkFields, ['number']),
      min: makeFanoutSafeAggregationFunction('min', crossSourceFkFields, [
        'number',
        'date',
        'dateTime',
      ]),
      max: makeFanoutSafeAggregationFunction('max', crossSourceFkFields, [
        'number',
        'date',
        'dateTime',
      ]),
      // `toGridAggFn` maps our 'count' to the DataGridPremium built-in name 'size'.
      size: makeFanoutSafeAggregationFunction('count', crossSourceFkFields),
      // Not a DataGridPremium built-in — registering it here also fixes the
      // separate (previously silent) gap where `count_distinct` passed through
      // `toGridAggFn` unchanged but had no matching aggregation function, so a
      // `count_distinct` group aggregation rendered nothing.
      count_distinct: {
        ...makeFanoutSafeAggregationFunction('count_distinct', crossSourceFkFields),
        label: localeText.gridSummaryLabelCountDistinct,
      },
    }),
    [crossSourceFkFields, localeText.gridSummaryLabelCountDistinct],
  );

  // Build column defs for ALL data source fields (own source + expression fields +
  // resolvable cross-source configured columns) so any field can be used for
  // grouping without dynamically adding/removing column definitions (which causes
  // DataGridPremium to pollute its internal column visibility state).
  const allFieldIds = React.useMemo(() => {
    const ids = [
      ...(dataSource?.fields.map((f) => f.id) ?? []),
      ...expressionFields.map((f) => f.id),
    ];
    const seen = new Set(ids);
    for (const id of crossSourceFieldDefs.keys()) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }, [dataSource?.fields, expressionFields, crossSourceFieldDefs]);

  const orderedFieldIds = React.useMemo(
    () => computeOrderedFieldIds(widget.config.columns, allFieldIds),
    [widget.config.columns, allFieldIds],
  );

  const columns = React.useMemo<GridColDef[]>(
    () =>
      buildGridColumnDefs(
        orderedFieldIds,
        dataSource,
        expressionFields,
        crossSourceFieldDefs,
        isEditable,
        pkField,
      ),
    [dataSource, expressionFields, orderedFieldIds, crossSourceFieldDefs, isEditable, pkField],
  );

  const {
    filteredRows,
    filteredRowsNoCross,
    filteredRowsNoChartCross,
    hasChartCrossFilters,
    isLoading,
    isError,
    errorMessage,
  } = useWidgetRows(widget, dataSource, pageId);

  // `crossFilterMode` is a cross-kind key (declared on the chart config but honored
  // by grids too), so it is read via the flat cross-kind `StudioWidgetConfig`. The
  // dashboard-wide `globalCrossFilterMode` override takes precedence over the
  // widget's own config, mirroring the exact precedence `useWidgetRows` already
  // applies internally to compute `effectiveRows` (finding 1.6) — every other
  // widget kind (chart/KPI/map/pivot) is global-mode-aware; the grid used to
  // resolve its mode locally and ignore both the 'none' setting and the
  // dashboard-wide toggle.
  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  const crossFilterMode =
    globalCrossFilterMode ??
    (widget.config as StudioWidgetConfig).crossFilterMode ??
    'cross-highlight';

  // In 'none' mode, cross-filters (chart-click and dashboard-wide) must be fully
  // ignored — use the baseline with no cross-filters applied at all, matching
  // `useWidgetRows`'s `effectiveRows` resolution. In cross-highlight mode, show all
  // baseline rows (hard-filtered by page/widget/interactive) and dim the
  // non-matching ones. In cross-filter mode, use the fully filtered rows.
  let baseRows: typeof filteredRows;
  if (crossFilterMode === 'none') {
    baseRows = filteredRowsNoCross;
  } else if (hasChartCrossFilters && crossFilterMode === 'cross-highlight') {
    baseRows = filteredRowsNoChartCross;
  } else {
    baseRows = filteredRows;
  }

  // Per-row match keys for the chart cross-filter — used to decide which rows to highlight.
  //
  // We can't key on `row.id`: it is `undefined` for id-less data sources (an explicitly
  // supported case — see the synthetic-id fallback in `rows` below), which would make every
  // row appear "unmatched" and get dimmed regardless of whether it actually passed the filter.
  //
  // `filteredRows` and `baseRows` (`filteredRowsNoChartCross` in cross-highlight mode) are
  // both filtered from the *same* underlying pipeline-cached row array (see
  // `useWidgetRows`/`resolveRowsCached`). For a widget with NO cross-source display column
  // that means a row in `filteredRows` is the exact same JS object as its counterpart in
  // `baseRows`, so raw reference identity is a valid match key. But when a cross-source column
  // IS configured, `enrichWithCrossSourceFields` clones (`{ ...row }`) each row that receives a
  // cross-source value, and it does so in a *separate* pass per baseline — so the two baselines
  // hold different instances for the same logical row and raw reference matching silently fails
  // (everything dimmed, nothing highlighted). To survive that clone we key on the stable
  // identity token that cross-source enrichment stamps onto every row (see rowIdentity.ts),
  // falling back to the row object itself when no token is present (the no-cross-source case).
  const rowMatchKey = React.useCallback(
    (row: Record<string, unknown>): number | Record<string, unknown> => getRowIdentity(row) ?? row,
    [],
  );

  const highlightedRowKeys = React.useMemo((): Set<number | Record<string, unknown>> | null => {
    if (!hasChartCrossFilters || crossFilterMode !== 'cross-highlight') {
      return null;
    }
    return new Set(filteredRows.map(rowMatchKey));
  }, [hasChartCrossFilters, crossFilterMode, filteredRows, rowMatchKey]);

  const rows = React.useMemo(() => {
    // `baseRows` already carries related-source calculated columns — the shared `useWidgetRows`
    // enrichment now L2-enriches and joins them (finding 1.1), so no local pass is needed here.
    return baseRows.map((row, index) => ({
      ...row,
      // Spread `row` FIRST, then set `id`, so the synthetic-id fallback always wins when the
      // row carries an `id` property that is null/undefined (a nullable database id column).
      // With the fallback placed before `...row`, `...row` overwrote the computed id back to
      // nullish and every such row collided on the same DataGrid id (finding 1.9).
      id: row.id ?? `${widget.id}-${index}`,
      // Stashed during this same pass (while `row` still has its original identity) so
      // `getRowClassName` below never needs to re-derive matching from `row.id`.
      __highlighted: highlightedRowKeys ? highlightedRowKeys.has(rowMatchKey(row)) : undefined,
    }));
  }, [baseRows, widget.id, highlightedRowKeys, rowMatchKey]);

  // Native DataGridPremium row grouping
  const rowGroupingModel = React.useMemo(
    () => (widget.config.gridGroupByField ? [widget.config.gridGroupByField] : []),
    [widget.config.gridGroupByField],
  );

  const aggregationModel = React.useMemo<GridAggregationModel>(() => {
    const resolved = resolveAggregationFieldKeys(widget.config.gridAggregations);
    return Object.fromEntries(
      Object.entries(resolved).map(([field, fn]) => [field, toGridAggFn(fn)]),
    );
  }, [widget.config.gridAggregations]);

  // Drive column visibility externally so toggling always reflects widget config,
  // even when a field has previously been used as a group-by column.
  // Grouped columns must be hidden from the data view (DataGridPremium renders them
  // as the group cell instead); we enforce that here since we own the model.
  const columnVisibilityModel = React.useMemo(
    () =>
      Object.fromEntries(
        allFieldIds.map((id) => [id, visibleFields.includes(id) && !rowGroupingModel.includes(id)]),
      ),
    [allFieldIds, visibleFields, rowGroupingModel],
  );

  const processRowUpdate = React.useCallback(
    async (newRow: GridValidRowModel, oldRow: GridValidRowModel): Promise<GridValidRowModel> => {
      if (!dataSource?.adapter?.submitMutation || !pkField) {
        return oldRow;
      }
      const changedValues: Record<string, unknown> = {};
      for (const key of Object.keys(newRow)) {
        if (newRow[key] !== oldRow[key]) {
          changedValues[key] = newRow[key];
        }
      }
      if (Object.keys(changedValues).length === 0) {
        return newRow;
      }
      const rowId = String(newRow.id);
      const [changedField] = Object.keys(changedValues);
      let result;
      try {
        result = await dataSource.adapter.submitMutation({
          operation: 'update',
          table: dataSource.tableName ?? dataSource.id,
          values: changedValues,
          where: [{ column: pkField, operator: 'eq', value: newRow[pkField] }],
        });
      } catch (err) {
        // Adapter rejected/threw — enrich with the row/field being edited so
        // `onProcessRowUpdateError` can revert the stuck cell (same as the
        // graceful `{ ok: false }` branch below).
        throw toEnrichedMutationError(err, rowId, changedField);
      }
      if (!result.ok) {
        throw toEnrichedMutationError(
          new Error(result.error ?? 'Mutation failed'),
          rowId,
          changedField,
        );
      }
      setMutationError(null);
      return newRow;
    },
    [dataSource, pkField],
  );

  const handleProcessRowUpdateError = React.useCallback(
    (error: unknown) => {
      const enrichedError = error as Partial<EnrichedMutationError> | null | undefined;
      setMutationError(enrichedError?.message || localeText.gridMutationError);

      const rowId = enrichedError?.gridRowId;
      const field = enrichedError?.gridField;
      if (
        rowId !== undefined &&
        field !== undefined &&
        apiRef.current?.getCellMode(rowId, field) === 'edit'
      ) {
        apiRef.current.stopCellEditMode({ id: rowId, field, ignoreModifications: true });
      }
    },
    [apiRef, localeText],
  );

  const handleCellClick = React.useCallback(
    (params: GridCellParams) => {
      // Don't cross-filter from the summary pinned row
      if (params.id === '__summary__') {
        return;
      }

      const cfField = widget.config.crossFilterField;
      const fieldId = cfField ?? params.field;
      // When a cross-filter field is configured, the emitted value must be that
      // field's value on the clicked ROW — not the clicked cell's own value —
      // otherwise clicking any non-configured column emits nonsense filter values.
      const value = cfField ? (params.row as Record<string, unknown>)[cfField] : params.value;

      // Toggle: clicking the same field+value clears the filter
      if (
        activeCrossFilter &&
        activeCrossFilter.field === fieldId &&
        crossFilterValueEquals(activeCrossFilter.value, value)
      ) {
        controller.clearCrossFilter(widget.id);
      } else {
        controller.applyCrossFilter(widget.id, fieldId, value, widget.sourceId);
      }
    },
    [controller, widget.id, widget.sourceId, activeCrossFilter, widget.config.crossFilterField],
  );

  // Conditional formatting: build an index of CSS class name → style for injection.
  // Each rule gets a deterministic CSS class name based on its index.
  const conditionalFormats = React.useMemo(
    () => widget.config.gridConditionalFormats ?? [],
    [widget.config.gridConditionalFormats],
  );
  const conditionalFormatSx = React.useMemo(() => {
    const sx: Record<string, Record<string, unknown>> = {};
    conditionalFormats.forEach((rule, i) => {
      const cls = `.StudioGrid-cf-${widget.id}-${i}`;
      sx[`& ${cls}`] = {
        ...(rule.style.backgroundColor ? { bgcolor: rule.style.backgroundColor } : {}),
        ...(rule.style.color ? { color: rule.style.color } : {}),
        ...(rule.style.fontWeight ? { fontWeight: rule.style.fontWeight } : {}),
      };
    });
    return sx;
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- widget.id is a stable primitive
  }, [conditionalFormats, widget.id]);

  const getCellClassName = React.useCallback(
    (params: GridCellParams) => {
      if (params.id === '__summary__' || conditionalFormats.length === 0) {
        return '';
      }
      const classes: string[] = [];
      conditionalFormats.forEach((rule, i) => {
        if (rule.fieldId !== params.field) {
          return;
        }
        if (evalConditionalFormat(rule, params.value)) {
          classes.push(`StudioGrid-cf-${widget.id}-${i}`);
        }
      });
      return classes.join(' ');
    },
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- widget.id is a stable primitive
    [conditionalFormats, widget.id],
  );

  // Only shown when grouping is not active (DataGridPremium aggregation handles it otherwise).
  //
  // In cross-highlight mode the grid body shows ALL baseline rows but dims non-matching ones.
  // The summary should reflect only the highlighted (cross-filter-inclusive) subset so the
  // totals agree with what the user is focusing on. In all other modes use `rows` directly.
  const summaryConfig = widget.config.gridGroupByField
    ? undefined
    : resolveAggregationFieldKeys(widget.config.gridSummaryFields);
  const summaryBasisRows = React.useMemo(
    () =>
      hasChartCrossFilters && crossFilterMode === 'cross-highlight'
        ? // `filteredRows` already carries related-source calculated columns via the shared
          // `useWidgetRows` enrichment (finding 1.1) — no local pass needed.
          filteredRows
        : rows,
    [hasChartCrossFilters, crossFilterMode, filteredRows, rows],
  );

  // Field defs the footer summary resolves against — the widget's own physical fields,
  // its own calculated columns, AND resolvable cross-source columns (finding 1.2). Without
  // the last two a configured `sum`/`avg`/`min`/`max` on a cross-source or expression-field
  // column found no def, resolved as non-numeric, and silently degraded to a `count`.
  const summaryFieldDefs = React.useMemo<StudioDataField[]>(() => {
    const defs: StudioDataField[] = [...(dataSource?.fields ?? [])];
    for (const ef of expressionFields) {
      defs.push({
        id: ef.id,
        label: ef.label,
        type: ef.type ?? 'number',
        format: ef.format,
        precision: ef.precision,
        currencyCode: ef.currencyCode,
      });
    }
    for (const def of crossSourceFieldDefs.values()) {
      defs.push(def);
    }
    return defs;
  }, [dataSource?.fields, expressionFields, crossSourceFieldDefs]);

  const summaryValues = React.useMemo(() => {
    if (!summaryConfig || Object.keys(summaryConfig).length === 0 || !dataSource) {
      return null;
    }
    return computeGridSummary(
      summaryBasisRows,
      summaryFieldDefs,
      { fields: summaryConfig },
      localeText,
      // FK-dedup a fanned-out cross-source footer sum the same way the group totals do.
      crossSourceFkFields,
    );
  }, [
    summaryBasisRows,
    dataSource,
    summaryFieldDefs,
    summaryConfig,
    localeText,
    crossSourceFkFields,
  ]);

  // Build a pinned bottom row for DataGridPremium using the summary values.
  // We use a separate `__rowId` field for the row identity so that the `id`
  // data column still shows the summary count (e.g. "Count: 460,000").
  const pinnedRows = React.useMemo(() => {
    if (!summaryValues) {
      return undefined;
    }
    return { bottom: [{ ...summaryValues, __rowId: '__summary__' }] };
  }, [summaryValues]);

  return (
    <div>
      {isError && <StudioWidgetErrorOverlay message={errorMessage} sx={{ py: 1 }} />}
      {mutationError && (
        <Alert severity="error" onClose={() => setMutationError(null)} sx={{ mb: 1 }}>
          {mutationError}
        </Alert>
      )}
      <DataGridPremium
        density="compact"
        columns={columns}
        disableColumnMenu
        rows={rows}
        pinnedRows={pinnedRows}
        getRowId={(row: GridValidRowModel) => {
          return String(
            // eslint-disable-next-line no-underscore-dangle -- summary rows use an internal synthetic identifier
            (row as Record<string, unknown>).__rowId ?? (row as Record<string, unknown>).id,
          );
        }}
        hideFooter
        loading={isLoading}
        disableRowSelectionOnClick
        slots={{ noRowsOverlay: StudioNoDataOverlay }}
        rowGroupingModel={rowGroupingModel}
        onRowGroupingModelChange={() => {}}
        aggregationModel={aggregationModel}
        onAggregationModelChange={() => {}}
        aggregationFunctions={aggregationFunctions}
        columnVisibilityModel={columnVisibilityModel}
        onColumnVisibilityModelChange={() => {}}
        sx={{
          height: widget.config.gridHeight ?? 400,
          '& .MuiDataGrid-cell': { cursor: 'default' },
          '& .StudioGrid-crossFilterMatch': {
            bgcolor: 'action.selected',
          },
          '& .StudioGrid-dimmed': {
            opacity: 0.3,
          },
          // Pinned rows (summary) must never be dimmed — they are always visible.
          '& .MuiDataGrid-pinnedRows .StudioGrid-dimmed': {
            opacity: 1,
          },
          ...conditionalFormatSx,
        }}
        getCellClassName={getCellClassName}
        getRowClassName={(params: GridRowClassNameParams) => {
          if (params.id === '__summary__') {
            return '';
          }
          // Incoming chart cross-highlight: dim rows that don't match the cross-filter.
          if (highlightedRowKeys !== null) {
            // eslint-disable-next-line no-underscore-dangle -- internal synthetic flag stashed in `rows` above
            return (params.row as Record<string, unknown>).__highlighted ? '' : 'StudioGrid-dimmed';
          }
          // Outgoing cross-filter: highlight the row this table is filtering on.
          if (activeCrossFilter) {
            const rowValue = (params.row as Record<string, unknown>)[activeCrossFilter.field];
            return crossFilterValueEquals(rowValue, activeCrossFilter.value)
              ? 'StudioGrid-crossFilterMatch'
              : '';
          }
          return '';
        }}
        initialState={{
          ...(widget.config.gridSortField && {
            sorting: {
              sortModel: [
                {
                  field: widget.config.gridSortField,
                  sort: widget.config.gridSortDirection ?? 'asc',
                },
              ],
            },
          }),
        }}
        // Use controlled layout mode so the pinned summary row uses `position: absolute`
        // rather than `position: sticky`. At very large row counts (~470k+), the total
        // content height can exceed CSS height limits in some browsers, causing sticky
        // positioning to fail and the summary row to disappear.
        experimentalFeatures={{ virtualizerLayoutMode: 'controlled' }}
        onCellClick={handleCellClick}
        processRowUpdate={isEditable ? processRowUpdate : undefined}
        onProcessRowUpdateError={isEditable ? handleProcessRowUpdateError : undefined}
        {...slotProps?.dataGrid}
        // Forced after the spread so a host-supplied `slotProps.dataGrid.apiRef`
        // cannot silently disconnect `onProcessRowUpdateError`'s revert handler.
        apiRef={apiRef}
      />
    </div>
  );
});
