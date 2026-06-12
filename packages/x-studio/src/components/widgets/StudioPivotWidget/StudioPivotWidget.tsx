'use client';
import * as React from 'react';
import { Box, Button, Skeleton, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { useStudioLocaleText } from '../../../context';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import type { StudioDataSource, StudioWidget } from '../../../models';
import { PivotTable } from './PivotTable';
import { buildPivotMatrix, pivotToCsv, downloadCsv } from './pivotUtils';

export interface StudioPivotWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

export function StudioPivotWidget({ widget, dataSource }: StudioPivotWidgetProps) {
  const { config } = widget;
  const {
    pivotRowField,
    pivotColField,
    pivotValueField,
    pivotAggregation = 'sum',
    pivotShowTotals = true,
  } = config;

  const { filteredRows, isLoading, isError, errorMessage } = useWidgetRows(widget, dataSource);
  const localeText = useStudioLocaleText();

  const matrix = React.useMemo(() => {
    if (!pivotRowField || !pivotColField || filteredRows.length === 0) {
      return null;
    }
    return buildPivotMatrix(filteredRows, pivotRowField, pivotColField, pivotValueField);
  }, [filteredRows, pivotRowField, pivotColField, pivotValueField]);

  const handleExport = React.useCallback(() => {
    if (!matrix) {
      return;
    }
    const csv = pivotToCsv(matrix, pivotAggregation, pivotShowTotals);
    downloadCsv(csv, `${widget.title || 'pivot'}.csv`);
  }, [matrix, pivotAggregation, pivotShowTotals, widget.title]);

  if (isLoading) {
    return <Skeleton variant="rectangular" height={300} sx={{ borderRadius: 1 }} />;
  }

  if (isError) {
    return <StudioWidgetErrorOverlay message={errorMessage} height={200} />;
  }

  if (!pivotRowField || !pivotColField) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 200,
          color: 'text.disabled',
        }}
      >
        <Typography variant="body2">{localeText.widgetConfigurePivotHint}</Typography>
      </Box>
    );
  }

  if (!matrix || (matrix.rowValues.length === 0 && matrix.colValues.length === 0)) {
    return (
      <Box
        role="status"
        aria-live="polite"
        aria-atomic="true"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 200,
          color: 'text.disabled',
        }}
      >
        <Typography variant="body2">{localeText.widgetNoData}</Typography>
      </Box>
    );
  }

  const rowCount = matrix.rowValues.length;
  const colCount = matrix.colValues.length;

  return (
    <Box sx={{ position: 'relative' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          mb: 0.5,
          gap: 1,
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {localeText.pivotRowsColumnsLabel(rowCount, colCount)}
        </Typography>
        <Button
          size="small"
          startIcon={<DownloadIcon fontSize="small" />}
          onClick={handleExport}
          sx={{ minWidth: 0, fontSize: 11, py: 0.25 }}
        >
          CSV
        </Button>
      </Box>
      <PivotTable
        matrix={matrix}
        aggFn={pivotAggregation}
        showTotals={pivotShowTotals}
        height={300}
      />
    </Box>
  );
}
