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
import type { StudioDataField, StudioDataSource, StudioWidgetOf } from '../../../models';
import { PivotTable } from './PivotTable';
import {
  buildPivotMatrix,
  pivotToCsv,
  downloadCsv,
  resolvePivotAggregation,
  type PivotMeasureContext,
} from './pivotUtils';

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
    pivotAggregation,
    pivotShowTotals = true,
  } = config;

  // `pivotAggregation` is doc-/AI-authored and only its KEY name is validated at the load
  // boundary, never its value — an unrecognized name used to fall through to `sum`, so the
  // pivot showed a sum while the config asserted a different measure. Screen it against the
  // allow-list here, at the widget boundary (`SAFE_MAP_COLOR_SCHEMES` pattern); `null` makes
  // every cell render as `—` instead of a plausible-but-wrong number.
  const aggFn = resolvePivotAggregation(pivotAggregation);

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

  // The value field's own definition — resolved from the data source, or normalized from an
  // expression field (measure or calculated column) the same way `StudioGridWidget` does it.
  // Threaded into `PivotTable` so a cell renders in the measure's format/currency/precision
  // (`€1,234`) like every other widget kind, instead of the hard-coded 2-decimal number the
  // pivot used to print for every value regardless of type (`1234.00`, and `12.00` for a
  // `count`, which the CSV wrote as `12`).
  const valueFieldDef = React.useMemo<
    Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'> | undefined
  >(() => {
    if (!pivotValueField) {
      return undefined;
    }
    const field = dataSource?.fields.find((f) => f.id === pivotValueField);
    if (field) {
      return field;
    }
    const ef = expressionFields.find((f) => f.id === pivotValueField);
    if (ef) {
      return {
        type: ef.type ?? 'number',
        format: ef.format,
        precision: ef.precision,
        currencyCode: ef.currencyCode,
      };
    }
    return undefined;
  }, [pivotValueField, dataSource?.fields, expressionFields]);

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
    const csv = pivotToCsv(matrix, aggFn, pivotShowTotals, localeText.pivotTotalLabel);
    downloadCsv(csv, `${widget.title || 'pivot'}.csv`);
  }, [matrix, aggFn, pivotShowTotals, widget.title, localeText.pivotTotalLabel]);

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
        aggFn={aggFn}
        valueField={valueFieldDef}
        showTotals={pivotShowTotals}
        height={300}
      />
    </Box>
  );
}
