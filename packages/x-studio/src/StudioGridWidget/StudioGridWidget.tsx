'use client';
import * as React from 'react';
import {
  DataGridPremium,
  type GridColDef,
  type GridCellParams,
  type GridAggregationModel,
} from '@mui/x-data-grid-premium';

import type { StudioConditionalFormat, StudioDataSource, StudioWidget } from '../models';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectFilters,
  makeSelectExpressionFieldsForSource,
  selectActivePageId,
} from '../context';
import { formatFieldValue } from '../internals/numberFormat';
import { Box, Typography } from '@mui/material';

import { computeGridSummary } from '../utils/gridSummary';
import { useWidgetRows } from '../internals/useWidgetRows';
import { StudioNoDataOverlay } from '../internals/StudioNoDataOverlay';

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
      return String(cellValue ?? '').toLowerCase().includes(String(value).toLowerCase());
    default:
      return false;
  }
}

export interface StudioGridWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  /** Props forwarded to the underlying `DataGridPremium`. */
  slotProps?: {
    dataGrid?: Partial<import('@mui/x-data-grid-premium').DataGridPremiumProps>;
  };
}

export const StudioGridWidget = React.memo(function StudioGridWidget(props: StudioGridWidgetProps) {
  const { dataSource, widget, slotProps } = props;
  const controller = useStudioController();
  const filters = useStudioSelector(selectFilters);
  const localeText = useStudioLocaleText();
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
  const activePageId = useStudioSelector(selectActivePageId);
  const visibleFields = React.useMemo(
    () =>
      widget.config.columns?.length
        ? widget.config.columns.map((c) => c.fieldId)
        : (dataSource?.fields.map((f) => f.id) ?? []),
    [widget.config.columns, dataSource?.fields],
  );

  // Check if this widget has an active cross-filter (on the current page)
  const activeCrossFilter = React.useMemo(
    () =>
      filters.find(
        (f) =>
          f.scope === 'cross-filter' && f.sourceWidgetId === widget.id && f.pageId === activePageId,
      ) ?? null,
    [filters, widget.id, activePageId],
  );

  // Build column defs for ALL data source fields so any field can be used for
  // grouping without dynamically adding/removing column definitions (which causes
  // DataGridPremium to pollute its internal column visibility state).
  const allFieldIds = React.useMemo(
    () => [
      ...(dataSource?.fields.map((f) => f.id) ?? []),
      ...expressionFields.map((f) => f.id),
    ],
    [dataSource?.fields, expressionFields],
  );

  const columns = React.useMemo<GridColDef[]>(() => {
    return allFieldIds.map((fieldName) => {
      const field = dataSource?.fields.find((candidate) => candidate.id === fieldName);
      const expressionField = expressionFields.find((candidate) => candidate.id === fieldName);
      const fieldType = field?.type ?? expressionField?.type;
      const fieldFormat = field?.format ?? expressionField?.format;

      return {
        field: fieldName,
        flex: 1,
        headerName: field?.label ?? expressionField?.label ?? fieldName,
        minWidth: 140,
        type: fieldType === 'number' ? 'number' : 'string',
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
                  currencyCode: field?.currencyCode,
                });
              }
            : undefined,
      };
    });
  }, [dataSource, expressionFields, allFieldIds]);

  const { filteredRows, filteredRowsNoChartCross, hasChartCrossFilters, isLoading, isError, errorMessage } =
    useWidgetRows(widget, dataSource);

  const crossFilterMode = widget.config?.crossFilterMode ?? 'cross-highlight';

  // In cross-highlight mode, show all baseline rows (hard-filtered by page/widget/interactive)
  // and dim the non-matching ones. In cross-filter or none mode, use the appropriate row set.
  const baseRows =
    hasChartCrossFilters && crossFilterMode === 'cross-highlight'
      ? filteredRowsNoChartCross
      : filteredRows;

  // IDs of rows that pass the chart cross-filter — used to determine which rows to highlight.
  const highlightedRowIds = React.useMemo((): Set<unknown> | null => {
    if (!hasChartCrossFilters || crossFilterMode !== 'cross-highlight') {
      return null;
    }
    const ids = new Set<unknown>();
    for (const row of filteredRows) {
      ids.add(row.id);
    }
    return ids;
  }, [hasChartCrossFilters, crossFilterMode, filteredRows]);

  const rows = React.useMemo(() => {
    return baseRows.map((row, index) => ({
      id: row.id ?? `${widget.id}-${index}`,
      ...row,
    }));
  }, [baseRows, widget.id]);

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
      Object.entries(widget.config.gridAggregations).map(([field, fn]) => [
        field,
        toGridAggFn(fn),
      ]),
    );
  }, [widget.config.gridAggregations]);

  // Drive column visibility externally so toggling always reflects widget config,
  // even when a field has previously been used as a group-by column.
  // Grouped columns must be hidden from the data view (DataGridPremium renders them
  // as the group cell instead); we enforce that here since we own the model.
  const columnVisibilityModel = React.useMemo(
    () =>
      Object.fromEntries(
        allFieldIds.map((id) => [
          id,
          visibleFields.includes(id) && !rowGroupingModel.includes(id),
        ]),
      ),
    [allFieldIds, visibleFields, rowGroupingModel],
  );

  const handleCellClick = React.useCallback(
    (params: GridCellParams) => {
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
        String(activeCrossFilter.value) === String(value)
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
  const conditionalFormats = widget.config.gridConditionalFormats ?? [];
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
    [conditionalFormats, widget.id],
  );


  // Only shown when grouping is not active (DataGridPremium aggregation handles it otherwise).
  //
  // In cross-highlight mode the grid body shows ALL baseline rows but dims non-matching ones.
  // The summary should reflect only the highlighted (cross-filter-inclusive) subset so the
  // totals agree with what the user is focusing on. In all other modes use `rows` directly.
  const summaryConfig = widget.config.gridGroupByField ? undefined : widget.config.gridSummaryFields;
  const summaryBasisRows =
    hasChartCrossFilters && crossFilterMode === 'cross-highlight' ? filteredRows : rows;
  const summaryValues = React.useMemo(() => {
    if (!summaryConfig || Object.keys(summaryConfig).length === 0 || !dataSource) {
      return null;
    }
    return computeGridSummary(summaryBasisRows, dataSource.fields, { fields: summaryConfig });
  }, [summaryBasisRows, dataSource, summaryConfig]);

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
      {isError && (
        <Box sx={{ p: 1, color: 'error.main' }}>
          <Typography variant="caption">{errorMessage || localeText.widgetLoadError}</Typography>
        </Box>
      )}
      <DataGridPremium
        density="compact"
        columns={columns}
        disableColumnMenu
        rows={rows}
        pinnedRows={pinnedRows}
        getRowId={(row) =>
          String((row as Record<string, unknown>).__rowId ?? (row as Record<string, unknown>).id)
        }
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
          '& .MuiDataGrid-cell': { cursor: 'pointer' },
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
        getRowClassName={(params) => {
          if (params.id === '__summary__') {
            return '';
          }
          // Incoming chart cross-highlight: dim rows that don't match the cross-filter.
          if (highlightedRowIds !== null) {
            return highlightedRowIds.has(params.row.id) ? '' : 'StudioGrid-dimmed';
          }
          // Outgoing cross-filter: highlight the row this table is filtering on.
          if (activeCrossFilter) {
            const rowValue = (params.row as Record<string, unknown>)[activeCrossFilter.field];
            return String(rowValue) === String(activeCrossFilter.value)
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
        {...slotProps?.dataGrid}
      />
    </div>
  );
});



