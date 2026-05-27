'use client';
import * as React from 'react';
import { Box, Tooltip, Typography, useTheme } from '@mui/material';
import type { StudioChartType, StudioBarLayout } from '../models';
import { AreaIcon } from '../icons/charts/AreaIcon';
import { Area100Icon } from '../icons/charts/Area100Icon';
import { AreaStackedIcon } from '../icons/charts/AreaStackedIcon';
import { BarGroupedIcon } from '../icons/charts/BarGroupedIcon';
import { Bar100Icon } from '../icons/charts/Bar100Icon';
import { BarStackedIcon } from '../icons/charts/BarStackedIcon';
import { BarHorizontalIcon } from '../icons/charts/BarHorizontalIcon';
import { BarStackedHorizontalIcon } from '../icons/charts/BarStackedHorizontalIcon';
import { Bar100HorizontalIcon } from '../icons/charts/Bar100HorizontalIcon';
import { DonutIcon } from '../icons/charts/DonutIcon';
import { GaugeIcon } from '../icons/charts/GaugeIcon';
import { LineIcon } from '../icons/charts/LineIcon';
import { PieIcon } from '../icons/charts/PieIcon';
import { ScatterIcon } from '../icons/charts/ScatterIcon';

interface ChartTypeOption {
  chartType: StudioChartType;
  barLayout?: StudioBarLayout;
  label: string;
  Icon: React.FC<{ size?: number; color?: string; secondaryColor?: string }>;
}

const CHART_TYPE_OPTIONS: ChartTypeOption[] = [
  { chartType: 'bar', label: 'Bar (grouped)', Icon: BarGroupedIcon },
  { chartType: 'bar-stacked', label: 'Bar (stacked)', Icon: BarStackedIcon },
  { chartType: 'bar-100', label: 'Bar (100%)', Icon: Bar100Icon },
  { chartType: 'bar', barLayout: 'horizontal', label: 'Bar (horizontal)', Icon: BarHorizontalIcon },
  {
    chartType: 'bar-stacked',
    barLayout: 'horizontal',
    label: 'Bar (stacked, horizontal)',
    Icon: BarStackedHorizontalIcon,
  },
  {
    chartType: 'bar-100',
    barLayout: 'horizontal',
    label: 'Bar (100%, horizontal)',
    Icon: Bar100HorizontalIcon,
  },
  { chartType: 'line', label: 'Line', Icon: LineIcon },
  { chartType: 'area', label: 'Area', Icon: AreaIcon },
  { chartType: 'area-stacked', label: 'Area (stacked)', Icon: AreaStackedIcon },
  { chartType: 'area-100', label: 'Area (100%)', Icon: Area100Icon },
  { chartType: 'scatter', label: 'Scatter', Icon: ScatterIcon },
  { chartType: 'pie', label: 'Pie', Icon: PieIcon },
  { chartType: 'donut', label: 'Donut', Icon: DonutIcon },
  { chartType: 'gauge', label: 'Gauge', Icon: GaugeIcon },
];

export function ChartTypePicker({
  chartType,
  barLayout,
  onChange,
}: {
  chartType: StudioChartType;
  barLayout?: StudioBarLayout;
  onChange: (chartType: StudioChartType, barLayout?: StudioBarLayout) => void;
}) {
  const theme = useTheme();
  const primary = theme.palette.primary.main;
  const secondary = theme.palette.secondary.main || theme.palette.primary.light;

  return (
    <div>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block' }}>
        Chart type
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(36px, 1fr))',
          gap: 0.5,
        }}
      >
        {CHART_TYPE_OPTIONS.map((opt) => {
          const selected =
            opt.chartType === chartType &&
            (opt.barLayout ?? 'grouped') === (barLayout ?? 'grouped');
          return (
            <Tooltip
              key={`${opt.chartType}-${opt.barLayout ?? ''}`}
              title={opt.label}
              placement="top"
            >
              <Box
                role="button"
                tabIndex={0}
                aria-label={opt.label}
                aria-pressed={selected}
                onClick={() => onChange(opt.chartType, opt.barLayout)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    onChange(opt.chartType, opt.barLayout);
                  }
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  p: 0.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: selected ? 'primary.main' : 'divider',
                  bgcolor: selected ? 'primary.main18' : 'transparent',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  color: selected ? 'primary.main' : 'text.secondary',
                  '&:hover': {
                    borderColor: 'primary.main',
                    bgcolor: 'primary.main10',
                    color: 'primary.main',
                  },
                  '&:focus-visible': {
                    outline: 2,
                    outlineColor: 'primary.main',
                    outlineOffset: 1,
                  },
                }}
              >
                <opt.Icon
                  size={28}
                  color={selected ? primary : 'currentColor'}
                  secondaryColor={selected ? secondary : 'currentColor'}
                />
              </Box>
            </Tooltip>
          );
        })}
      </Box>
    </div>
  );
}
