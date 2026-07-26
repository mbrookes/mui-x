'use client';
import * as React from 'react';
import {
  DataGridPremium,
  type GridColDef,
  type GridCellParams,
  type GridAggregationModel,
  type GridRowClassNameParams,
  type GridValidRowModel,
} from '@mui/x-data-grid-premium';

import type { StudioConditionalFormat, StudioDataSource, StudioWidget } from '../../../models';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectFilters,
  makeSelectExpressionFieldsForSource,
} from '../../../context';
import { formatFieldValue } from '../../../internals/numberFormat';

import { computeGridSummary } from '../../../utils/gridSummary';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { getRowIdentity } from '../../../internals/rowIdentity';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import { useStudioFeatures } from '../../../internals/StudioUIConfigContext';
import { crossFilterValueEquals } from '../StudioChartWidget/chartWidgetHelpers';

/** Maps our model's aggregation names to DataGridPremium built-in function names. */
function toGridAggFn(fn: string): string {
  return fn === 'count' ? 'size' : fn;
}

function evalConditionalFormat(rule: StudioConditionalFormat, cellValue: unknown): boolean {
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
      return Number(cellValue) > Number(value);
    case 'less_than':
      return Number(cellValue) < Number(value);
    case 'greater_than_or_equal':
      return Number(cellValue) >= Number(value);
    case 'less_than_or_equal':
      return Number(cellValue) <= Number(value);
    case 'contains':
      return String(cellValue ?? '')
        .toLowerCase()
        .includes(String(value).toLowerCase());
    default:
      return false;
  }
}

export interface StudioGridWidgetProps {
  widget: StudioWidget;
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
  const features = useStudioFeatures();
  const filters = useStudioSelector(selectFilters);
  const localeText = useStudioLocaleText();
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
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

  // Build column defs for ALL data source fields so any field can be used for
  // grouping without dynamically adding/removing column definitions (which causes
  // DataGridPremium to pollute its internal column visibility state).
  const allFieldIds = React.useMemo(
    () => [...(dataSource?.fields.map((f) => f.id) ?? []), ...expressionFields.map((f) => f.id)],
    [dataSource?.fields, expressionFields],
  );

  const columns = React.useMemo<GridColDef[]>(() => {
    return allFieldIds.map((fieldName) => {
      const field = dataSource?.fields.find((candidate) => candidate.id === fieldName);
      const expressionField = expressionFields.find((candidate) => candidate.id === fieldName);
      const fieldType = field?.type ?? expressionField?.type;
      const fieldFormat = field?.format ?? expressionField?.format;
      const fieldPrecision = field?.precision ?? expressionField?.precision;

      return {
        field: fieldName,
        flex: 1,
        headerName: field?.label ?? expressionField?.label ?? fieldName,
        minWidth: 140,
        type: fieldType === 'number' ? 'number' : 'string',
        // Enable editing for non-PK columns when write-back is configured
        editable: isEditable && fieldName !== pkField,
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
                  currencyCode: field?.currencyCode ?? expressionField?.currencyCode,
                });
              }
            : undefined,
      };
    });
  }, [dataSource, expressionFields, allFieldIds, isEditable, pkField]);

  const {
    filteredRows,
    filteredRowsNoChartCross,
    hasChartCrossFilters,
    isLoading,
    isError,
    errorMessage,
  } = useWidgetRows(widget, dataSource, pageId);

  const crossFilterMode = widget.config?.crossFilterMode ?? 'cross-highlight';

  // In cross-highlight mode, show all baseline rows (hard-filtered by page/widget/interactive)
  // and dim the non-matching ones. In cross-filter or none mode, use the appropriate row set.
  const baseRows =
    hasChartCrossFilters && crossFilterMode === 'cross-highlight'
      ? filteredRowsNoChartCross
      : filteredRows;

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
    return baseRows.map((row, index) => ({
      id: row.id ?? `${widget.id}-${index}`,
      ...row,
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
    if (!widget.config.gridAggregations) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(widget.config.gridAggregations).map(([field, fn]) => [field, toGridAggFn(fn)]),
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
      const result = await dataSource.adapter.submitMutation({
        operation: 'update',
        table: dataSource.tableName ?? dataSource.id,
        values: changedValues,
        where: [{ column: pkField, operator: 'eq', value: newRow[pkField] }],
      });
      if (!result.ok) {
        throw new Error(result.error ?? 'Mutation failed');
      }
      return newRow;
    },
    [dataSource, pkField],
  );

  const handleCellClick = React.useCallback(
    (params: GridCellParams) => {
      if (!features.crossFilter) {
        return;
      }
      // Don't cross-filter from the summary pinned row
      if (params.id === '__summary__') {
        return;
      }

      const fieldId = widget.config.crossFilterField ?? params.field;
      const value = params.value;

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
    [
      controller,
      widget.id,
      widget.sourceId,
      activeCrossFilter,
      widget.config.crossFilterField,
      features.crossFilter,
    ],
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
    : widget.config.gridSummaryFields;
  const summaryBasisRows =
    hasChartCrossFilters && crossFilterMode === 'cross-highlight' ? filteredRows : rows;
  const summaryValues = React.useMemo(() => {
    if (!summaryConfig || Object.keys(summaryConfig).length === 0 || !dataSource) {
      return null;
    }
    return computeGridSummary(
      summaryBasisRows,
      dataSource.fields,
      { fields: summaryConfig },
      localeText,
    );
  }, [summaryBasisRows, dataSource, summaryConfig, localeText]);

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
        {...slotProps?.dataGrid}
      />
    </div>
  );
});
