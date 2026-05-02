'use client';
import * as React from 'react';
import { DataGridPro, type GridColDef, type GridCellParams } from '@mui/x-data-grid-pro';
import { Chip, Stack } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import { useStudioController, useStudioSelector } from '../context';
import { applyFilters, resolveMetricRefs } from '../internals/chartUtils';
import { formatFieldValue } from '../internals/numberFormat';
import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';
import { computeGridSummary } from '../utils/gridSummary';

export interface StudioGridWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

export const StudioGridWidget = React.memo(function StudioGridWidget(props: StudioGridWidgetProps) {
  const { dataSource, widget } = props;
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const expressionFields = useStudioSelector((state) => state.expressionFields);
  const relationships = useStudioSelector((state) => state.relationships);
  const activePageId = useStudioSelector((state) => state.dashboard.activePageId);

  // Check if this widget has an active cross-filter (on the current page)
  const activeCrossFilter = filters.find(
    (f) => f.scope === 'cross-filter' && f.sourceWidgetId === widget.id && f.pageId === activePageId,
  );

  const columns = React.useMemo<GridColDef[]>(() => {
    const visibleFields = widget.config.columns?.length
      ? widget.config.columns
      : (dataSource?.fields.map((f) => f.id) ?? []);

    return visibleFields.map((fieldName) => {
      const field = dataSource?.fields.find((candidate) => candidate.id === fieldName);

      return {
        field: fieldName,
        flex: 1,
        headerName: field?.label ?? fieldName,
        minWidth: 140,
        type: field?.type === 'number' ? 'number' : 'string',
        valueFormatter:
          field?.type === 'number' && field.format
            ? (value: unknown) => formatFieldValue(value, field)
            : undefined,
      };
    });
  }, [dataSource, widget.config.columns]);

  const rows = React.useMemo(() => {
    if (!dataSource?.rows) {
      return [];
    }

    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === widget.id);
    // Cross-filters from OTHER widgets on the same page affect this widget
    const crossFilters = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
    );
    const allFilters = resolveMetricRefs(
      [...pageFilters, ...widgetFilters, ...crossFilters],
      dataSources,
    );

    const enrichedRows = enrichRowsWithExpressions(dataSource.rows, expressionFields, widget.sourceId ?? '', dataSources, relationships);
    const filteredRows = applyFilters(enrichedRows, allFilters);

    return filteredRows.map((row, index) => ({
      id: row.id ?? `${widget.id}-${index}`,
      ...row,
    }));
  }, [dataSource, widget.id, widget.sourceId, filters, dataSources, expressionFields, relationships, activePageId]);

  const handleCellClick = React.useCallback(
    (params: GridCellParams) => {
      // Don't cross-filter from the summary pinned row
      if (params.id === '__summary__') {
        return;
      }

      const fieldId = params.field;
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
    [controller, widget.id, widget.sourceId, activeCrossFilter],
  );

  // Resolve the active filter field's display label for the chip
  const activeCrossFilterLabel = React.useMemo(() => {
    if (!activeCrossFilter) {
      return null;
    }
    const exprField = expressionFields.find((ef) => ef.id === activeCrossFilter.field);
    if (exprField) {
      return exprField.label;
    }
    const dataField = dataSource?.fields.find((f) => f.id === activeCrossFilter.field);
    return dataField?.label ?? activeCrossFilter.field;
  }, [activeCrossFilter, expressionFields, dataSource]);

  // Cross-filter indicator
  const crossFilterIndicator = activeCrossFilter ? (
    <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
      <Chip
        size="small"
        label={`${activeCrossFilterLabel} = ${activeCrossFilter.value}`}
        onDelete={() => controller.clearCrossFilter(widget.id)}
        color="primary"
        variant="outlined"
      />
    </Stack>
  ) : null;

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
      {crossFilterIndicator}
      <DataGridPro
        density="compact"
        columns={columns}
        disableColumnMenu
        rows={rows}
        pinnedRows={pinnedRows}
        hideFooter
        disableRowSelectionOnClick
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
      />
    </div>
  );
});
