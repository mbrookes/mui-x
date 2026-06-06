'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import type { GridColDef } from '@mui/x-data-grid';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../../models';
import { enrichRowsWithExpressions } from '../../utils/expressionEvaluator';

export interface DataSourcePreviewProps {
  source: StudioDataSource;
  expressionFields: StudioExpressionField[];
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
}

/**
 * Read-only DataGrid preview of a data source including all physical and
 * calculated (expression) fields. Used in the data lineage dialog when a
 * source node is clicked (BL-103).
 */
export function DataSourcePreview({
  source,
  expressionFields,
  dataSources,
  relationships,
}: DataSourcePreviewProps) {
  const enrichedRows = React.useMemo(() => {
    if (!source.rows || source.rows.length === 0) {
      return [];
    }
    return enrichRowsWithExpressions(
      source.rows,
      expressionFields,
      source.id,
      dataSources,
      relationships,
    ).map((row, index) => ({ ...row, __previewRowId: `${source.id}-${index}` }));
  }, [source.rows, expressionFields, source.id, dataSources, relationships]);

  const columns = React.useMemo<GridColDef[]>(() => {
    const physicalCols = source.fields.reduce<GridColDef[]>((acc, f) => {
      if (!f.hidden) {
        acc.push({ field: f.id, headerName: f.label, flex: 1, minWidth: 100 });
      }
      return acc;
    }, []);

    const exprCols = expressionFields.reduce<GridColDef[]>((acc, ef) => {
      if (ef.sourceId === source.id && !ef.hidden && !ef.isMeasure) {
        acc.push({ field: ef.id, headerName: ef.label, flex: 1, minWidth: 100 });
      }
      return acc;
    }, []);

    return [...physicalCols, ...exprCols];
  }, [source.fields, expressionFields, source.id]);

  if (enrichedRows.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          No data available for {source.label}.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <DataGrid
        rows={enrichedRows}
        columns={columns}
        // eslint-disable-next-line no-underscore-dangle -- preview rows use an internal synthetic identifier
        getRowId={(row) => row.__previewRowId as string}
        density="compact"
        disableRowSelectionOnClick
        hideFooterSelectedRowCount
        pageSizeOptions={[25, 50, 100]}
        initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
      />
    </Box>
  );
}
