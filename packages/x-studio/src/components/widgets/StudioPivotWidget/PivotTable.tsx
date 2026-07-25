'use client';
import * as React from 'react';
import { Box, useTheme } from '@mui/material';
import type { StudioDataField } from '../../../models';
import {
  formatPivotCellValue,
  resolvePivotCellValue,
  type PivotAggregation,
  type PivotMatrix,
} from './pivotUtils';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';

const CELL_W = 90;
const LABEL_W = 140;
const ROW_H = 32;

interface PivotTableProps {
  matrix: PivotMatrix;
  /**
   * `null` when the configured `pivotAggregation` failed validation — every cell then
   * renders as "no value" rather than silently showing a different measure
   * (see `resolvePivotAggregation`).
   */
  aggFn: PivotAggregation | null;
  /**
   * Definition of the resolved `pivotValueField` (a data-source field or an expression
   * field normalized to the same shape), so cells render in the measure's own
   * format/currency/precision — the same way the grid, KPI and map widgets format it —
   * instead of a hard-coded 2-decimal number.
   */
  valueField?: Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>;
  showTotals: boolean;
  height: number;
}

export function PivotTable({ matrix, aggFn, valueField, showTotals, height }: PivotTableProps) {
  const theme = useTheme();
  const localeText = useStudioLocaleText();

  // Cell resolution (aggregation + rounding) is shared with the CSV export
  // (`pivotToCsv`) via `resolvePivotCellValue`, so an exported cell can never differ
  // from the displayed cell (finding 3.2); only the presentation differs.
  const fmt = (agg: Parameters<typeof resolvePivotCellValue>[0]) => {
    const value = resolvePivotCellValue(agg, aggFn);
    if (value === null) {
      return '—';
    }
    return formatPivotCellValue(value, aggFn, valueField);
  };

  // Use theme.vars for CSS variable references so styles adapt in dark mode.
  const vars =
    (theme as typeof theme & { vars: typeof theme.palette }).vars?.palette ?? theme.palette;
  const headerBg = vars.action.selected;
  const totalBg = vars.action.hover;
  const borderColor = vars.divider;
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
    background: vars.background.paper,
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
            <th style={cornerStyle} aria-label={localeText.pivotCornerHeaderAriaLabel} />
            {matrix.colValues.map((cv) => (
              <th key={cv} scope="col" style={headerStyle}>
                {cv || localeText.pivotBlankValueLabel}
              </th>
            ))}
            {showTotals && (
              <th scope="col" style={{ ...headerStyle, background: totalBg }}>
                {localeText.pivotTotalLabel}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {matrix.rowValues.map((rv, ri) => {
            const rowCells = matrix.cells.get(rv);
            let rowBg = vars.background.paper;
            if (ri % 2 === 1) {
              rowBg = vars.action.hover;
            }
            return (
              <tr key={rv}>
                <th scope="row" style={{ ...labelStyle, background: rowBg }}>
                  {rv || localeText.pivotBlankValueLabel}
                </th>
                {matrix.colValues.map((cv) => (
                  <td key={cv} style={{ ...cellStyle, background: rowBg }}>
                    {fmt(rowCells?.get(cv))}
                  </td>
                ))}
                {showTotals && (
                  <td style={{ ...cellStyle, background: totalBg, fontWeight: 500 }}>
                    {fmt(matrix.rowTotals.get(rv))}
                  </td>
                )}
              </tr>
            );
          })}
          {showTotals && (
            <tr>
              <th scope="row" style={{ ...labelStyle, background: totalBg, fontWeight: 600 }}>
                {localeText.pivotTotalLabel}
              </th>
              {matrix.colValues.map((cv) => (
                <td key={cv} style={{ ...cellStyle, background: totalBg, fontWeight: 500 }}>
                  {fmt(matrix.colTotals.get(cv))}
                </td>
              ))}
              <td style={{ ...cellStyle, background: totalBg, fontWeight: 700 }}>
                {fmt(matrix.grandTotal)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Box>
  );
}

// ── Widget component ──────────────────────────────────────────────────────────
