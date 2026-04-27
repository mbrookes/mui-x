import * as React from 'react';
import { DataGrid, type GridColDef, type GridRowSelectionModel } from '@mui/x-data-grid';
import { Chip, Stack } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import { useStudioController, useStudioSelector } from '../context';
import { applyFilters, resolveMetricRefs } from './chartUtils';
import { formatFieldValue } from './numberFormat';

export interface StudioGridWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

export function StudioGridWidget(props: StudioGridWidgetProps) {
  const { dataSource, widget } = props;
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const dataSources = useStudioSelector((state) => state.dataSources);

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

    const filteredRows = applyFilters(dataSource.rows, allFilters);

    return filteredRows.map((row, index) => ({
      id: row.id ?? `${widget.id}-${index}`,
      ...row,
    }));
  }, [dataSource, widget.id, filters, dataSources]);

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

      // Use configured field, fall back to first non-hidden string field
      const crossFilterFieldId = widget.config.crossFilterField;
      const filterField = crossFilterFieldId
        ? dataSource?.fields.find((f) => f.id === crossFilterFieldId)
        : dataSource?.fields.find((f) => f.type === 'string' && !f.hidden);

      if (!filterField) {
        return;
      }

      const value = (selectedRow as Record<string, unknown>)[filterField.id];
      if (value !== undefined) {
        controller.applyCrossFilter(widget.id, filterField.id, value);
      }
    },
    [controller, widget.id, widget.config.crossFilterField, rows, dataSource],
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

  return (
    <div>
      {crossFilterIndicator}
      <DataGrid
        autoHeight
        columns={columns}
        disableColumnMenu
        rows={rows}
        pageSizeOptions={[5, 10, 25]}
        initialState={{
          pagination: {
            paginationModel: {
              pageSize: 5,
              page: 0,
            },
          },
        }}
        onRowSelectionModelChange={handleRowSelectionChange}
      />
    </div>
  );
}
