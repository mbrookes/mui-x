'use client';
import * as React from 'react';
import { DataGridPro, type GridColDef, type GridCellParams } from '@mui/x-data-grid-pro';

import type { StudioDataSource, StudioWidget } from '../models';
import {
  useStudioController,
  useStudioSelector,
  selectFilters,
  makeSelectExpressionFieldsForSource,
  selectActivePageId,
} from '../context';
import { formatFieldValue } from '../internals/numberFormat';

import { buildGroupedGridRows } from '../utils/gridGrouping';
import { computeGridSummary } from '../utils/gridSummary';
import { useWidgetRows } from '../internals/useWidgetRows';

export interface StudioGridWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  /** Props forwarded to the underlying `DataGridPro`. */
  slotProps?: {
    dataGrid?: Partial<import('@mui/x-data-grid-pro').DataGridProProps>;
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

  const columns = React.useMemo<GridColDef[]>(() => {
    return visibleFields.map((fieldName) => {
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
  }, [dataSource, expressionFields, visibleFields]);

  const { filteredRows } = useWidgetRows(widget, dataSource);

  const rows = React.useMemo(() => {
    if (widget.config.gridGroupByField) {
      return buildGroupedGridRows(
        filteredRows,
        widget.config.gridGroupByField,
        visibleFields,
        widget.config.gridAggregations ?? {},
        widget.id,
      );
    }

    return filteredRows.map((row, index) => ({
      __rowId: row.id ?? `${widget.id}-${index}`,
      id: row.id ?? `${widget.id}-${index}`,
      ...row,
    }));
  }, [
    filteredRows,
    widget.config.gridAggregations,
    widget.config.gridGroupByField,
    widget.id,
    visibleFields,
  ]);

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

  // Resolve the active filter field's display label for the chip — unused
  // (chip now rendered in StudioWidgetCard title row)

  // Compute summary values over ALL filtered rows (not just the current page).
  const summaryConfig = widget.config.gridSummaryFields;
  const summaryValues = React.useMemo(() => {
    if (!summaryConfig || Object.keys(summaryConfig).length === 0 || !dataSource) {
      return null;
    }
    return computeGridSummary(rows, dataSource.fields, { fields: summaryConfig });
  }, [rows, dataSource, summaryConfig]);

  // Build a pinned bottom row for DataGridPro using the summary values.
  const pinnedRows = React.useMemo(() => {
    if (!summaryValues) {
      return undefined;
    }
    return { bottom: [{ id: '__summary__', ...summaryValues }] };
  }, [summaryValues]);

  return (
    <div>
      <DataGridPro
        density="compact"
        columns={columns}
        disableColumnMenu
        rows={rows}
        pinnedRows={pinnedRows}
        hideFooter
        disableRowSelectionOnClick
        getRowId={(row) =>
          // eslint-disable-next-line no-underscore-dangle
          ((row as Record<string, unknown>).__rowId ??
            (row as Record<string, unknown>).id) as string
        }
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
