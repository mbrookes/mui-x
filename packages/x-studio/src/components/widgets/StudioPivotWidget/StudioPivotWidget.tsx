'use client';
import * as React from 'react';
import { Box, Skeleton, Typography } from '@mui/material';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import {
  useStudioLocaleText,
  useStudioSelector,
  makeSelectExpressionFieldsForSource,
} from '../../../context';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import type { StudioDataSource, StudioWidgetOf } from '../../../models';
import { PivotTable } from './PivotTable';
import { buildPivotMatrix, pivotToCsv, downloadCsv, type PivotMeasureContext } from './pivotUtils';

export interface StudioPivotWidgetProps {
  widget: StudioWidgetOf<'pivot'>;
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

  // `effectiveRows` (not `filteredRows`) so the pivot honours `config.crossFilterMode` the
  // same way Map/KPI do: `'none'` shows the grand total (chart cross-filters ignored),
  // anything else (the default) respects the active cross-filter. Pivot has no per-row
  // visual to "dim" (its cells are already aggregated), so — like the Map widget — there is
  // no separate cross-highlight ghost overlay; `'cross-highlight'` behaves the same as
  // `'cross-filter'` here (architecture review: pivot ignored crossFilterMode entirely).
  const {
    effectiveRows: filteredRows,
    isLoading,
    isError,
    errorMessage,
  } = useWidgetRows(widget, dataSource, pageId);
  const localeText = useStudioLocaleText();

  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);

  // A measure expression (e.g. `sum(total)/count()`) aggregates itself over a row set —
  // it has no per-row value, so `row[pivotValueField]` is always `undefined` for one.
  // Previously pivot had no `evaluateMeasure` path at all (unlike KPI's handling of the
  // same case), so a measure-expression `pivotValueField` silently rendered every cell
  // empty. Detect it here and route through `buildMeasurePivotMatrix` instead.
  const measureExprField = React.useMemo(
    () => expressionFields.find((f) => f.id === pivotValueField && f.isMeasure) ?? null,
    [expressionFields, pivotValueField],
  );

  const measureContext: PivotMeasureContext | undefined = React.useMemo(
    () => (measureExprField ? { measureField: measureExprField, expressionFields } : undefined),
    [measureExprField, expressionFields],
  );

  const matrix = React.useMemo(() => {
    if (!pivotRowField || !pivotColField || filteredRows.length === 0) {
      return null;
    }
    return buildPivotMatrix(
      filteredRows,
      pivotRowField,
      pivotColField,
      pivotValueField,
      measureContext,
    );
  }, [filteredRows, pivotRowField, pivotColField, pivotValueField, measureContext]);

  const handleExport = React.useCallback(() => {
    if (!matrix) {
      return;
    }
    const csv = pivotToCsv(matrix, pivotAggregation, pivotShowTotals, localeText.pivotTotalLabel);
    downloadCsv(csv, `${widget.title || 'pivot'}.csv`);
  }, [matrix, pivotAggregation, pivotShowTotals, widget.title, localeText.pivotTotalLabel]);

  React.useEffect(() => {
    if (exportRef) {
      exportRef.current = matrix ? handleExport : null;
    }
    // Clear the export ref on every re-run (dep change) and on unmount. Without
    // this, an export scheduled/in-flight when the widget unmounts (or is
    // reconfigured away from pivot) leaves a stale closure on `exportRef` —
    // `StudioWidgetCard`'s export button reads `imperativeExportRef.current`
    // lazily on click, so a stale entry would still fire `handleExport` (closing
    // over this now-unmounted instance's `matrix`/`widget`) even though this
    // component is gone.
    return () => {
      if (exportRef) {
        exportRef.current = null;
      }
    };
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
