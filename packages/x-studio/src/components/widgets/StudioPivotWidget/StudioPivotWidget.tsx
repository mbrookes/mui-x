'use client';
import * as React from 'react';
import { Box, Skeleton, Typography } from '@mui/material';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { useStudioLocaleText } from '../../../context';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import type { StudioDataSource, StudioWidget } from '../../../models';
import { PivotTable } from './PivotTable';
import { buildPivotMatrix, pivotToCsv, downloadCsv } from './pivotUtils';

export interface StudioPivotWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope page-level filters correctly. */
  pageId: string;
  /** Ref populated with an export function when data is available, or null when not. */
  exportRef?: React.MutableRefObject<(() => void) | null>;
}

export function StudioPivotWidget({
  widget,
  dataSource,
  pageId,
  exportRef,
}: StudioPivotWidgetProps) {
  const { config } = widget;
  const {
    pivotRowField,
    pivotColField,
    pivotValueField,
    pivotAggregation = 'sum',
    pivotShowTotals = true,
  } = config;

  const { filteredRows, isLoading, isError, errorMessage } = useWidgetRows(
    widget,
    dataSource,
    pageId,
  );
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

  React.useEffect(() => {
    if (exportRef) {
      exportRef.current = matrix ? handleExport : null;
    }
  }, [exportRef, matrix, handleExport]);

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

  return (
    <Box sx={{ position: 'relative' }}>
      <PivotTable
        matrix={matrix}
        aggFn={pivotAggregation}
        showTotals={pivotShowTotals}
        height={300}
      />
    </Box>
  );
}
