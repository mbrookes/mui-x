'use client';
import * as React from 'react';
import {
  Box,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import {
  useStudioController,
  useStudioSelector,
  selectShell,
  selectWidgets,
  makeSelectWidgetSource,
} from '../context';
import { StudioGridWidget } from '../StudioGridWidget';
import { StudioChartWidget, CHART_MIN_HEIGHT } from '../StudioChartWidget';
import { StudioKpiWidget } from '../StudioKpiWidget';

// ── Inner widget renderer ─────────────────────────────────────────────────────

function DrilldownWidgetContent(props: { widgetId: string }) {
  const { widgetId } = props;
  const widgets = useStudioSelector(selectWidgets);
  const selectSource = React.useMemo(() => makeSelectWidgetSource(widgetId), [widgetId]);
  const source = useStudioSelector(selectSource);
  const widget = widgets[widgetId];

  if (!widget) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Widget not found.
      </Typography>
    );
  }

  if (widget.kind === 'grid') {
    return <StudioGridWidget widget={widget} dataSource={source} />;
  }
  if (widget.kind === 'chart') {
    return <StudioChartWidget widget={widget} dataSource={source} height={CHART_MIN_HEIGHT} />;
  }
  if (widget.kind === 'kpi') {
    return <StudioKpiWidget widget={widget} dataSource={source} />;
  }
  return (
    <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
      This widget type cannot be shown in the drilldown panel.
    </Typography>
  );
}

// ── Context chips ─────────────────────────────────────────────────────────────

function ContextChips(props: { rowData: Record<string, unknown> }) {
  const { rowData } = props;
  const entries = Object.entries(rowData).filter(
    ([, value]) => value !== null && value !== undefined && String(value).trim() !== '',
  );
  if (entries.length === 0) {
    return null;
  }
  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
      {entries.slice(0, 6).map(([key, value]) => (
        <Chip key={key} label={`${key}: ${String(value)}`} size="small" variant="outlined" />
      ))}
      {entries.length > 6 && (
        <Chip label={`+${entries.length - 6} more`} size="small" variant="outlined" />
      )}
    </Stack>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────

export interface StudioDrilldownDrawerProps {
  /** Width of the drilldown drawer in pixels. @default 480 */
  width?: number;
}

export function StudioDrilldownDrawer(props: StudioDrilldownDrawerProps) {
  const { width = 480 } = props;
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const widgets = useStudioSelector(selectWidgets);
  const { activeDrilldown } = shell;

  const drilldownWidget = activeDrilldown
    ? widgets[activeDrilldown.drilldownWidgetId]
    : undefined;

  const handleClose = React.useCallback(() => {
    controller.closeDrilldown();
  }, [controller]);

  return (
    <Drawer
      anchor="right"
      open={Boolean(activeDrilldown)}
      onClose={handleClose}
      variant="temporary"
      slotProps={{
        paper: {
          sx: { width, maxWidth: '90vw', display: 'flex', flexDirection: 'column' },
        },
      }}
    >
      {/* Header */}
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 2, py: 1.5, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography variant="subtitle1" sx={{ flexGrow: 1, fontWeight: 600 }}>
          {drilldownWidget?.title ?? 'Detail'}
        </Typography>
        <Tooltip title="Close">
          <IconButton size="small" onClick={handleClose} aria-label="Close drilldown">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Context filter chips */}
      {activeDrilldown && Object.keys(activeDrilldown.rowData).length > 0 && (
        <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Filtered to:
          </Typography>
          <ContextChips rowData={activeDrilldown.rowData} />
        </Box>
      )}

      {/* Widget content */}
      <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
        {activeDrilldown && (
          <DrilldownWidgetContent widgetId={activeDrilldown.drilldownWidgetId} />
        )}
      </Box>
    </Drawer>
  );
}
