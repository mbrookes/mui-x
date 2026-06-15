'use client';
import * as React from 'react';
import { Box, Tooltip, Typography, useTheme } from '@mui/material';
import { useStudioLocaleText } from '../../context';
import type { StudioChartType, StudioBarLayout } from '../../models';
import { AreaIcon } from '../../icons/charts/AreaIcon';
import { Area100Icon } from '../../icons/charts/Area100Icon';
import { AreaStackedIcon } from '../../icons/charts/AreaStackedIcon';
import { BarGroupedIcon } from '../../icons/charts/BarGroupedIcon';
import { Bar100Icon } from '../../icons/charts/Bar100Icon';
import { BarStackedIcon } from '../../icons/charts/BarStackedIcon';
import { BarHorizontalIcon } from '../../icons/charts/BarHorizontalIcon';
import { BarStackedHorizontalIcon } from '../../icons/charts/BarStackedHorizontalIcon';
import { Bar100HorizontalIcon } from '../../icons/charts/Bar100HorizontalIcon';
import { DonutIcon } from '../../icons/charts/DonutIcon';
import { GaugeIcon } from '../../icons/charts/GaugeIcon';
import { LineIcon } from '../../icons/charts/LineIcon';
import { PieIcon } from '../../icons/charts/PieIcon';
import { MixedIcon } from '../../icons/charts/MixedIcon';
import { ScatterIcon } from '../../icons/charts/ScatterIcon';
import { HeatmapIcon } from '../../icons/charts/HeatmapIcon';
import { FunnelIcon } from '../../icons/charts/FunnelIcon';
import { GanttIcon } from '../../icons/charts/GanttIcon';
import { SankeyIcon } from '../../icons/charts/SankeyIcon';

interface ChartTypeOption {
  chartType: StudioChartType;
  barLayout?: StudioBarLayout;
  label: string;
  Icon: React.FC<{ size?: number; color?: string; secondaryColor?: string }>;
}

function getChartTypeOptions(
  localeText: ReturnType<typeof useStudioLocaleText>,
): ChartTypeOption[] {
  return [
    { chartType: 'bar', label: localeText.chartTypeBarGrouped, Icon: BarGroupedIcon },
    { chartType: 'bar-stacked', label: localeText.chartTypeBarStacked, Icon: BarStackedIcon },
    { chartType: 'bar-100', label: localeText.chartTypeBar100, Icon: Bar100Icon },
    {
      chartType: 'bar',
      barLayout: 'horizontal',
      label: localeText.chartTypeBarHorizontal,
      Icon: BarHorizontalIcon,
    },
    {
      chartType: 'bar-stacked',
      barLayout: 'horizontal',
      label: localeText.chartTypeBarStackedHorizontal,
      Icon: BarStackedHorizontalIcon,
    },
    {
      chartType: 'bar-100',
      barLayout: 'horizontal',
      label: localeText.chartTypeBar100Horizontal,
      Icon: Bar100HorizontalIcon,
    },
    { chartType: 'line', label: localeText.chartTypeLine, Icon: LineIcon },
    { chartType: 'area', label: localeText.chartTypeArea, Icon: AreaIcon },
    { chartType: 'area-stacked', label: localeText.chartTypeAreaStacked, Icon: AreaStackedIcon },
    { chartType: 'area-100', label: localeText.chartTypeArea100, Icon: Area100Icon },
    { chartType: 'scatter', label: localeText.chartTypeScatter, Icon: ScatterIcon },
    { chartType: 'mixed', label: localeText.chartTypeMixed, Icon: MixedIcon },
    { chartType: 'heatmap', label: localeText.chartTypeHeatmap, Icon: HeatmapIcon },
    { chartType: 'funnel', label: localeText.chartTypeFunnel, Icon: FunnelIcon },
    { chartType: 'gantt', label: localeText.chartTypeGantt, Icon: GanttIcon },
    { chartType: 'sankey', label: localeText.chartTypeSankey, Icon: SankeyIcon },
    { chartType: 'pie', label: localeText.chartTypePie, Icon: PieIcon },
    { chartType: 'donut', label: localeText.chartTypeDonut, Icon: DonutIcon },
    { chartType: 'gauge', label: localeText.chartTypeGauge, Icon: GaugeIcon },
  ];
}

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
  const localeText = useStudioLocaleText();
  const primary = theme.palette.primary.main;
  const secondary = theme.palette.secondary.main || theme.palette.primary.light;
  const chartTypeOptions = getChartTypeOptions(localeText);

  return (
    <div>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block' }}>
        {localeText.chartTypePickerLabel}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(36px, 1fr))',
          gap: 0.5,
        }}
      >
        {chartTypeOptions.map((opt) => {
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
                    event.preventDefault();
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
                  cursor: 'default',
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
