'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import {
  useAxesTooltip,
  useItemTooltip,
  ChartsTooltipContainer,
  ChartsTooltipPaper,
  ChartsTooltipTable,
  ChartsTooltipRow,
  ChartsTooltipCell,
} from '@mui/x-charts/ChartsTooltip';
import type { ChartsTooltipProps } from '@mui/x-charts/ChartsTooltip';

/**
 * Provides the field/question label rendered as the tooltip *title* for single-series
 * survey-style charts. The pie/donut series doesn't carry the field label, so it's passed
 * down via context; the bar axis tooltip can read it from the series label directly but
 * prefers the context value when present for consistency.
 */
export const ChartFieldTitleContext = React.createContext<string | undefined>(undefined);

function Swatch({ color }: { color: string }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '2px',
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

/**
 * Shared tooltip body: the field/question as the title, then a single row of
 * [colour swatch] [category] [value] — so the category (the thing being hovered) is the
 * labelled data point rather than the title, matching how the legend reads.
 */
function FieldTooltipShell(props: {
  title?: string;
  color: string;
  category: React.ReactNode;
  value: React.ReactNode;
}) {
  const { title, color, category, value } = props;
  return (
    <ChartsTooltipPaper>
      <ChartsTooltipTable>
        {title ? (
          <Typography component="caption" sx={{ textAlign: 'left', fontWeight: 600 }}>
            {title}
          </Typography>
        ) : null}
        <tbody>
          <ChartsTooltipRow>
            {/* Swatch + value columns shrink to their content so the category column absorbs
                the slack (the long question title widens the table). This keeps the category
                hugging the swatch on the left and the value pinned to the right, instead of
                the short data row spreading its cells across the title's width. */}
            <ChartsTooltipCell component="td" sx={{ width: '1px', whiteSpace: 'nowrap' }}>
              <Swatch color={color} />
            </ChartsTooltipCell>
            <ChartsTooltipCell component="th" sx={{ textAlign: 'left' }}>
              {category}
            </ChartsTooltipCell>
            <ChartsTooltipCell
              component="td"
              sx={{
                width: '1px',
                whiteSpace: 'nowrap',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {value}
            </ChartsTooltipCell>
          </ChartsTooltipRow>
        </tbody>
      </ChartsTooltipTable>
    </ChartsTooltipPaper>
  );
}

function AxisFieldTooltipContent() {
  const data = useAxesTooltip();
  const contextTitle = React.useContext(ChartFieldTitleContext);
  if (!data || data.length === 0) {
    return null;
  }
  const axis = data[0];
  const item = axis.seriesItems[0];
  if (!item) {
    return null;
  }
  return (
    <FieldTooltipShell
      title={contextTitle ?? item.formattedLabel ?? undefined}
      color={item.color}
      category={axis.axisFormattedValue}
      value={item.formattedValue as React.ReactNode}
    />
  );
}

function ItemFieldTooltipContent() {
  const item = useItemTooltip();
  const title = React.useContext(ChartFieldTitleContext);
  if (!item) {
    return null;
  }
  return (
    <FieldTooltipShell
      title={title}
      color={item.color}
      category={item.label ?? ''}
      value={item.formattedValue as React.ReactNode}
    />
  );
}

/**
 * Replaces the whole tooltip slot, so it must re-create the positioning container
 * (`ChartsTooltipContainer`) and only swap the inner content.
 */
export function AxisFieldTooltip(props: ChartsTooltipProps) {
  return (
    <ChartsTooltipContainer {...props} trigger="axis">
      <AxisFieldTooltipContent />
    </ChartsTooltipContainer>
  );
}

export function ItemFieldTooltip(props: ChartsTooltipProps) {
  return (
    <ChartsTooltipContainer {...props} trigger="item">
      <ItemFieldTooltipContent />
    </ChartsTooltipContainer>
  );
}
