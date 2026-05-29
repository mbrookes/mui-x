'use client';
import * as React from 'react';
import {
  Box,
  Button,
  Skeleton,
  Typography,
  useTheme,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useWidgetRows } from '../internals/useWidgetRows';
import { formatNumber } from '../internals/numberFormat';
import { useStudioLocaleText } from '../context';
import type { StudioDataSource, StudioWidget } from '../models';

// ── Aggregation ───────────────────────────────────────────────────────────────

interface AggState {
  sum: number;
  count: number;
  min: number;
  max: number;
}

function emptyAgg(): AggState {
  return { sum: 0, count: 0, min: Infinity, max: -Infinity };
}

function addToAgg(agg: AggState, v: number) {
  agg.sum += v;
  agg.count += 1;
  if (v < agg.min) {
    agg.min = v;
  }
  if (v > agg.max) {
    agg.max = v;
  }
}

function resolveAgg(
  agg: AggState | undefined,
  fn: 'sum' | 'avg' | 'count' | 'min' | 'max',
): number | null {
  if (!agg || agg.count === 0) {
    return null;
  }
  switch (fn) {
    case 'sum':
      return agg.sum;
    case 'avg':
      return agg.sum / agg.count;
    case 'count':
      return agg.count;
    case 'min':
      return agg.min === Infinity ? null : agg.min;
    case 'max':
      return agg.max === -Infinity ? null : agg.max;
    default:
      return agg.sum;
  }
}

interface PivotMatrix {
  rowValues: string[];
  colValues: string[];
  /** cells[rowVal][colVal] */
  cells: Map<string, Map<string, AggState>>;
  rowTotals: Map<string, AggState>;
  colTotals: Map<string, AggState>;
  grandTotal: AggState;
}

function buildPivotMatrix(
  rows: Record<string, unknown>[],
  rowField: string,
  colField: string,
  valueField: string | undefined,
  aggFn: 'sum' | 'avg' | 'count' | 'min' | 'max',
): PivotMatrix {
  const rowSet = new Set<string>();
  const colSet = new Set<string>();
  const cells = new Map<string, Map<string, AggState>>();
  const rowTotals = new Map<string, AggState>();
  const colTotals = new Map<string, AggState>();
  const grandTotal = emptyAgg();

  for (const row of rows) {
    const rv = String(row[rowField] ?? '');
    const cv = String(row[colField] ?? '');
    // For count, value can be anything (we count rows)
    const v = valueField ? Number(row[valueField] ?? 0) : 1;

    rowSet.add(rv);
    colSet.add(cv);

    // cell
    if (!cells.has(rv)) {
      cells.set(rv, new Map());
    }
    const rowCells = cells.get(rv)!;
    if (!rowCells.has(cv)) {
      rowCells.set(cv, emptyAgg());
    }
    addToAgg(rowCells.get(cv)!, v);

    // row total
    if (!rowTotals.has(rv)) {
      rowTotals.set(rv, emptyAgg());
    }
    addToAgg(rowTotals.get(rv)!, v);

    // col total
    if (!colTotals.has(cv)) {
      colTotals.set(cv, emptyAgg());
    }
    addToAgg(colTotals.get(cv)!, v);

    // grand total
    addToAgg(grandTotal, v);
  }

  return {
    rowValues: [...rowSet].sort(),
    colValues: [...colSet].sort(),
    cells,
    rowTotals,
    colTotals,
    grandTotal,
  };
}

// ── CSV export ────────────────────────────────────────────────────────────────

function formatCell(v: number | null): string {
  if (v === null) {
    return '';
  }
  return String(Math.round(v * 1000) / 1000);
}

function pivotToCsv(
  matrix: PivotMatrix,
  aggFn: 'sum' | 'avg' | 'count' | 'min' | 'max',
  showTotals: boolean,
): string {
  const { rowValues, colValues } = matrix;
  const header = ['', ...colValues, ...(showTotals ? ['Total'] : [])];
  const lines: string[] = [header.map((h) => JSON.stringify(h)).join(',')];

  for (const rv of rowValues) {
    const rowCells = matrix.cells.get(rv);
    const cells = colValues.map((cv) => formatCell(resolveAgg(rowCells?.get(cv), aggFn)));
    const rowTotal = showTotals ? formatCell(resolveAgg(matrix.rowTotals.get(rv), aggFn)) : undefined;
    const line = [JSON.stringify(rv), ...cells, ...(rowTotal !== undefined ? [rowTotal] : [])];
    lines.push(line.join(','));
  }

  if (showTotals) {
    const totals = colValues.map((cv) => formatCell(resolveAgg(matrix.colTotals.get(cv), aggFn)));
    const grand = formatCell(resolveAgg(matrix.grandTotal, aggFn));
    lines.push([JSON.stringify('Total'), ...totals, grand].join(','));
  }

  return lines.join('\n');
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Pivot table render ────────────────────────────────────────────────────────

const CELL_W = 90;
const LABEL_W = 140;
const ROW_H = 32;

interface PivotTableProps {
  matrix: PivotMatrix;
  aggFn: 'sum' | 'avg' | 'count' | 'min' | 'max';
  showTotals: boolean;
  height: number;
  valueFieldLabel?: string;
}

function PivotTable({ matrix, aggFn, showTotals, height }: PivotTableProps) {
  const theme = useTheme();

  const fmt = (v: number | null) => {
    if (v === null) {
      return '—';
    }
    return formatNumber(Math.round(v * 100) / 100, 'decimal');
  };

  const headerBg = theme.palette.mode === 'dark'
    ? theme.palette.grey[800]
    : theme.palette.grey[100];
  const totalBg = theme.palette.mode === 'dark'
    ? theme.palette.grey[700]
    : theme.palette.grey[50];
  const borderColor = theme.palette.divider;
  const cellStyle: React.CSSProperties = {
    border: `1px solid ${borderColor}`,
    padding: '4px 8px',
    whiteSpace: 'nowrap',
    textAlign: 'right',
    fontSize: 12,
    minWidth: CELL_W,
    height: ROW_H,
  };
  const labelStyle: React.CSSProperties = {
    ...cellStyle,
    textAlign: 'left',
    position: 'sticky',
    left: 0,
    background: theme.palette.background.paper,
    zIndex: 1,
    minWidth: LABEL_W,
    fontWeight: 500,
  };
  const headerStyle: React.CSSProperties = {
    ...cellStyle,
    background: headerBg,
    position: 'sticky',
    top: 0,
    fontWeight: 600,
  };
  const cornerStyle: React.CSSProperties = {
    ...labelStyle,
    ...headerStyle,
    position: 'sticky',
    left: 0,
    top: 0,
    zIndex: 2,
  };

  return (
    <Box sx={{ height, overflow: 'auto', position: 'relative' }}>
      <table
        style={{
          borderCollapse: 'collapse',
          minWidth: LABEL_W + matrix.colValues.length * CELL_W,
        }}
      >
        <thead>
          <tr>
            <th style={cornerStyle} />
            {matrix.colValues.map((cv) => (
              <th key={cv} style={headerStyle}>
                {cv || '(blank)'}
              </th>
            ))}
            {showTotals && <th style={{ ...headerStyle, background: totalBg }}>Total</th>}
          </tr>
        </thead>
        <tbody>
          {matrix.rowValues.map((rv, ri) => {
            const rowCells = matrix.cells.get(rv);
            const rowBg = ri % 2 === 1
              ? (theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)')
              : theme.palette.background.paper;
            return (
              <tr key={rv}>
                <td style={{ ...labelStyle, background: rowBg }}>{rv || '(blank)'}</td>
                {matrix.colValues.map((cv) => (
                  <td key={cv} style={{ ...cellStyle, background: rowBg }}>
                    {fmt(resolveAgg(rowCells?.get(cv), aggFn))}
                  </td>
                ))}
                {showTotals && (
                  <td style={{ ...cellStyle, background: totalBg, fontWeight: 500 }}>
                    {fmt(resolveAgg(matrix.rowTotals.get(rv), aggFn))}
                  </td>
                )}
              </tr>
            );
          })}
          {showTotals && (
            <tr>
              <td style={{ ...labelStyle, background: totalBg, fontWeight: 600 }}>Total</td>
              {matrix.colValues.map((cv) => (
                <td key={cv} style={{ ...cellStyle, background: totalBg, fontWeight: 500 }}>
                  {fmt(resolveAgg(matrix.colTotals.get(cv), aggFn))}
                </td>
              ))}
              <td style={{ ...cellStyle, background: totalBg, fontWeight: 700 }}>
                {fmt(resolveAgg(matrix.grandTotal, aggFn))}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Box>
  );
}

// ── Widget component ──────────────────────────────────────────────────────────

export interface StudioPivotWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

export function StudioPivotWidget({ widget, dataSource }: StudioPivotWidgetProps) {
  const { config } = widget;
  const { pivotRowField, pivotColField, pivotValueField, pivotAggregation = 'sum', pivotShowTotals = true } = config;

  const { filteredRows, isLoading, isError, errorMessage } = useWidgetRows(widget, dataSource);
  const localeText = useStudioLocaleText();

  const matrix = React.useMemo(() => {
    if (!pivotRowField || !pivotColField || filteredRows.length === 0) {
      return null;
    }
    return buildPivotMatrix(filteredRows, pivotRowField, pivotColField, pivotValueField, pivotAggregation);
  }, [filteredRows, pivotRowField, pivotColField, pivotValueField, pivotAggregation]);

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
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 200,
          color: 'error.main',
        }}
      >
        <Typography variant="body2">{errorMessage || localeText.widgetLoadError}</Typography>
      </Box>
    );
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
          {rowCount} rows × {colCount} columns
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
