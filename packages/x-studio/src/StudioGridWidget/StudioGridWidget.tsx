'use client';
import * as React from 'react';
import {
  DataGridPremium,
  type GridColDef,
  type GridCellParams,
  type GridAggregationModel,
} from '@mui/x-data-grid-premium';

import type { StudioDataSource, StudioWidget } from '../models';
import {
  useStudioController,
  useStudioSelector,
  selectFilters,
  makeSelectExpressionFieldsForSource,
  selectActivePageId,
} from '../context';
import { formatFieldValue } from '../internals/numberFormat';

import { computeGridSummary } from '../utils/gridSummary';
import { useWidgetRows } from '../internals/useWidgetRows';
import { StudioNoDataOverlay } from '../internals/StudioNoDataOverlay';

/** Maps our model's aggregation names to DataGridPremium built-in function names. */
function toGridAggFn(fn: string): string {
  return fn === 'count' ? 'size' : fn;
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
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
  const activePageId = useStudioSelector(selectActivePageId);
  const visibleFields = React.useMemo(
    () =>
      widget.config.columns?.length
        ? widget.config.columns
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
            ? (value: unknown) =>
                formatFieldValue(value, {
                  type: 'number',
                  format: fieldFormat,
                  currencyCode: field?.currencyCode,
                })
            : undefined,
      };
    });
  }, [dataSource, expressionFields, allFieldIds]);

  const { filteredRows, isLoading } = useWidgetRows(widget, dataSource);

  const rows = React.useMemo(() => {
    return filteredRows.map((row, index) => ({
      id: row.id ?? `${widget.id}-${index}`,
      ...row,
    }));
  }, [filteredRows, widget.id]);

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

  // Compute summary values over ALL filtered rows (not just the current page).
  // Only shown when grouping is not active (DataGridPremium aggregation handles it otherwise).
  const summaryConfig = widget.config.gridGroupByField ? undefined : widget.config.gridSummaryFields;
  const summaryValues = React.useMemo(() => {
    if (!summaryConfig || Object.keys(summaryConfig).length === 0 || !dataSource) {
      return null;
    }
    return computeGridSummary(rows, dataSource.fields, { fields: summaryConfig });
  }, [rows, dataSource, summaryConfig]);

  // Build a pinned bottom row for DataGridPremium using the summary values.
  const pinnedRows = React.useMemo(() => {
    if (!summaryValues) {
      return undefined;
    }
    return { bottom: [{ id: '__summary__', ...summaryValues }] };
  }, [summaryValues]);

  return (
    <div>
      <DataGridPremium
        density="compact"
        columns={columns}
        disableColumnMenu
        rows={rows}
        pinnedRows={pinnedRows}
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
          height: 400,
          '& .MuiDataGrid-cell': { cursor: 'pointer' },
          '& .StudioGrid-crossFilterMatch': {
            bgcolor: 'action.selected',
          },
        }}
        getRowClassName={(params) => {
          if (!activeCrossFilter || params.id === '__summary__') {
            return '';
          }
          const rowValue = (params.row as Record<string, unknown>)[activeCrossFilter.field];
          return String(rowValue) === String(activeCrossFilter.value)
            ? 'StudioGrid-crossFilterMatch'
            : '';
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
        onCellClick={handleCellClick}
        {...slotProps?.dataGrid}
      />
    </div>
  );
});



