'use client';
import * as React from 'react';
import { DataGridPro, type GridColDef, type GridRowSelectionModel } from '@mui/x-data-grid-pro';
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

export function getDefaultCrossFilterFieldId(
  widget: StudioWidget,
  dataSource?: StudioDataSource,
) {
  return widget.config.columns?.[0] ?? dataSource?.fields.find((field) => !field.hidden)?.id;
}

export const StudioGridWidget = React.memo(function StudioGridWidget(props: StudioGridWidgetProps) {
  const { dataSource, widget } = props;
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const expressionFields = useStudioSelector((state) => state.expressionFields);
  const relationships = useStudioSelector((state) => state.relationships);

  // Check if this widget has an active cross-filter
  const activeCrossFilter = filters.find(
    (f) => f.scope === 'cross-filter' && f.sourceWidgetId === widget.id,
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
    // Cross-filters from OTHER widgets affect this widget
    const crossFilters = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id,
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
  }, [dataSource, widget.id, widget.sourceId, filters, dataSources, expressionFields, relationships]);

  const handleRowSelectionChange = React.useCallback(
    (selection: GridRowSelectionModel) => {
      const ids = Array.from(selection.ids);
      if (ids.length === 0) {
        controller.clearCrossFilter(widget.id);
        return;
      }

      // Use the first selected row for cross-filtering
      const selectedRowId = ids[0];
      const selectedRow = rows.find((r) => r.id === selectedRowId);
      if (!selectedRow) {
        return;
      }

      // Use configured field, fall back to the first visible grid column.
      const crossFilterFieldId = widget.config.crossFilterField;
      const filterField = crossFilterFieldId
        ? dataSource?.fields.find((f) => f.id === crossFilterFieldId)
        : dataSource?.fields.find((f) => f.id === getDefaultCrossFilterFieldId(widget, dataSource));

      if (!filterField) {
        return;
      }

      const value = (selectedRow as Record<string, unknown>)[filterField.id];
      if (value !== undefined) {
        controller.applyCrossFilter(widget.id, filterField.id, value, widget.sourceId);
      }
    },
    [controller, widget.id, widget.config.columns, widget.config.crossFilterField, rows, dataSource],
  );

  // Cross-filter indicator
  const crossFilterIndicator = activeCrossFilter ? (
    <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
      <Chip
        size="small"
        label={`Filtering: ${activeCrossFilter.field} = ${activeCrossFilter.value}`}
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
        sx={{ height: 400 }}
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
        onRowSelectionModelChange={handleRowSelectionChange}
      />
    </div>
  );
});
