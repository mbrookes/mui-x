import * as React from 'react';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';

import type { StudioDataSource, StudioWidget } from '../models';

export interface StudioGridWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

export function StudioGridWidget(props: StudioGridWidgetProps) {
  const { dataSource, widget } = props;

  const columns = React.useMemo<GridColDef[]>(() => {
    const visibleFields = widget.config.columns?.length
      ? widget.config.columns
      : widget.bindings.map((binding) => binding.field);

    return visibleFields.map((fieldName) => {
      const field = dataSource?.fields.find((candidate) => candidate.id === fieldName);

      return {
        field: fieldName,
        flex: 1,
        headerName: field?.label ?? fieldName,
        minWidth: 140,
        type: field?.type === 'number' ? 'number' : 'string',
      };
    });
  }, [dataSource, widget.bindings, widget.config.columns]);

  const rows = React.useMemo(() => {
    return (dataSource?.rows ?? []).map((row, index) => ({
      id: row.id ?? `${widget.id}-${index}`,
      ...row,
    }));
  }, [dataSource, widget.id]);

  return (
    <DataGrid
      autoHeight
      columns={columns}
      disableColumnMenu
      disableRowSelectionOnClick
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
    />
  );
}