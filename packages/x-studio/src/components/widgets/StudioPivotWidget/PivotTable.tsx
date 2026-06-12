'use client';
import * as React from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import { formatNumber } from '../../../internals/numberFormat';
import { type PivotMatrix, resolveAgg } from './pivotUtils';

const CELL_W = 90;
const LABEL_W = 140;
const ROW_H = 32;

interface PivotTableProps {
  matrix: PivotMatrix;
  aggFn: 'sum' | 'avg' | 'count' | 'min' | 'max';
  showTotals: boolean;
  height: number;
}

const fmt = (v: number | null) => {
  if (v === null) {
    return '—';
  }
  return formatNumber(Math.round(v * 100) / 100, 'decimal');
};

export function PivotTable({ matrix, aggFn, showTotals, height }: PivotTableProps) {
  const theme = useTheme();

  const headerBg =
    theme.palette.mode === 'dark' ? theme.palette.grey[800] : theme.palette.grey[100];
  const totalBg = theme.palette.mode === 'dark' ? theme.palette.grey[700] : theme.palette.grey[50];
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
            <th style={cornerStyle} aria-label="Row / column header" />
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
            let rowBg = theme.palette.background.paper;
            if (ri % 2 === 1) {
              rowBg = theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)';
            }
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
