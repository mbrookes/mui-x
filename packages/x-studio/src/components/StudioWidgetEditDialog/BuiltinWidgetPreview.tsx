'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import {
  useStudioSelector,
  selectWidgets,
  makeSelectWidgetSource,
  useCustomWidgetMap,
} from '../../context';
import { StudioGridWidget } from '../widgets/StudioGridWidget';
import { StudioChartWidget, CHART_MIN_HEIGHT } from '../widgets/StudioChartWidget';
import { StudioKpiWidget } from '../widgets/StudioKpiWidget';
import { StudioTextWidget } from '../widgets/StudioTextWidget';
import { StudioFilterWidget } from '../widgets/StudioFilterWidget';
import { StudioPivotWidget } from '../widgets/StudioPivotWidget';
import { StudioMapWidget } from '../widgets/StudioMapWidget';

const MAP_WIDGET_DEFAULT_HEIGHT = 400;

// ── Built-in widget preview ───────────────────────────────────────────────────

export function BuiltinWidgetPreview({ widgetId }: { widgetId: string }) {
  const widgets = useStudioSelector(selectWidgets);
  const widget = widgets[widgetId];
  const selectSource = React.useMemo(() => makeSelectWidgetSource(widgetId), [widgetId]);
  const source = useStudioSelector(selectSource);
  const customWidgetMap = useCustomWidgetMap();
  const customDef = widget ? (customWidgetMap.get(widget.kind) ?? null) : null;

  if (!widget) {
    return null;
  }

  return (
    <React.Fragment>
      {widget.kind === 'grid' && <StudioGridWidget widget={widget} dataSource={source} />}
      {widget.kind === 'chart' && (
        <StudioChartWidget widget={widget} dataSource={source} height={CHART_MIN_HEIGHT } />
      )}
      {widget.kind === 'kpi' && <StudioKpiWidget widget={widget} dataSource={source} />}
      {widget.kind === 'text' && <StudioTextWidget widget={widget} />}
      {widget.kind === 'filter' && <StudioFilterWidget widget={widget} dataSource={source} />}
      {widget.kind === 'pivot' && <StudioPivotWidget widget={widget} dataSource={source} />}
      {widget.kind === 'map' && (
        <Box sx={{ height: MAP_WIDGET_DEFAULT_HEIGHT }}>
          {source && <StudioMapWidget widget={widget} dataSource={source} />}
        </Box>
      )}
      {customDef && <customDef.component widget={widget} dataSource={source ?? undefined} />}
    </React.Fragment>
  );
}
