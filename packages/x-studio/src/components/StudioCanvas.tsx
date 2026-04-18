import * as React from 'react';
import {
  Box,
  Chip,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioDataSource, StudioWidget, StudioWidgetKind } from '../models';
import { StudioGridWidget } from './StudioGridWidget';
import { StudioChartWidget } from './StudioChartWidget';
import { StudioKpiWidget } from './StudioKpiWidget';

const SALES_SOURCE_ID = 'source-sales';

function createSalesDataSource(): StudioDataSource {
  return {
    id: SALES_SOURCE_ID,
    label: 'Sales',
    fields: [
      { id: 'product', label: 'Product', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'revenue', label: 'Revenue', type: 'number' },
      { id: 'quantity', label: 'Quantity', type: 'number' },
      { id: 'margin', label: 'Margin %', type: 'number' },
    ],
    rows: [
      { id: 1, product: 'Alpha Pro', category: 'Software', region: 'DACH', revenue: 12400, quantity: 8, margin: 62 },
      { id: 2, product: 'Beta Suite', category: 'Hardware', region: 'UK', revenue: 9750, quantity: 5, margin: 38 },
      { id: 3, product: 'Gamma Cloud', category: 'Software', region: 'Nordics', revenue: 18200, quantity: 12, margin: 71 },
      { id: 4, product: 'Delta Device', category: 'Hardware', region: 'DACH', revenue: 6300, quantity: 3, margin: 22 },
      { id: 5, product: 'Epsilon Analytics', category: 'Software', region: 'UK', revenue: 21500, quantity: 15, margin: 68 },
      { id: 6, product: 'Zeta Connect', category: 'Services', region: 'Nordics', revenue: 7800, quantity: 6, margin: 45 },
      { id: 7, product: 'Eta Platform', category: 'Software', region: 'DACH', revenue: 16900, quantity: 11, margin: 74 },
      { id: 8, product: 'Theta Hub', category: 'Hardware', region: 'UK', revenue: 4200, quantity: 2, margin: 18 },
      { id: 9, product: 'Iota Insights', category: 'Services', region: 'DACH', revenue: 9100, quantity: 7, margin: 53 },
      { id: 10, product: 'Kappa Flow', category: 'Software', region: 'Nordics', revenue: 14600, quantity: 9, margin: 66 },
    ],
  };
}

interface WidgetCardProps {
  widgetId: string;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function WidgetCard(props: WidgetCardProps) {
  const { isFirst, isLast, onMoveDown, onMoveUp, widgetId } = props;
  const controller = useStudioController();
  const mode = useStudioSelector((state) => state.mode);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const isSelected = useStudioSelector((state) => state.shell.selectedWidgetId === widgetId);
  const source = useStudioSelector((state) =>
    widget?.sourceId ? state.dataSources[widget.sourceId] : undefined,
  );

  if (!widget) {
    return null;
  }

  const kindLabel: Record<StudioWidgetKind, string> = { grid: 'Table', chart: 'Chart', kpi: 'KPI' };

  return (
    <Paper
      variant="outlined"
      onClick={() => controller.setSelectedWidget(widgetId)}
      aria-selected={isSelected}
      aria-label={`Widget: ${widget.title}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          controller.setSelectedWidget(widgetId);
        }
      }}
      sx={{
        borderColor: isSelected ? 'primary.main' : 'divider',
        borderWidth: isSelected ? 2 : 1,
        cursor: 'pointer',
        p: 2,
        transition: 'border-color 0.15s',
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      <Stack spacing={2}>
        {/* Widget header */}
        <Stack direction="row" alignItems="flex-start" spacing={1}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle1" noWrap sx={{ flexGrow: 1 }}>
                {widget.title}
              </Typography>
              <Chip label={kindLabel[widget.kind]} size="small" variant="outlined" />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {source?.label ?? 'Unbound source'}
            </Typography>
          </Box>

          {mode === 'edit' && (
            <Stack direction="row" spacing={0.5}>
              <Tooltip title="Move up">
                <span>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveUp();
                    }}
                    disabled={isFirst}
                    aria-label="Move widget up"
                  >
                    <KeyboardArrowUpIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Move down">
                <span>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveDown();
                    }}
                    disabled={isLast}
                    aria-label="Move widget down"
                  >
                    <KeyboardArrowDownIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Duplicate widget">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.duplicateWidget(widgetId);
                  }}
                  aria-label="Duplicate widget"
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete widget">
                <IconButton
                  size="small"
                  color="error"
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.removeWidget(widgetId);
                  }}
                  aria-label="Delete widget"
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          )}
        </Stack>

        {/* Widget content */}
        {widget.kind === 'grid' && <StudioGridWidget widget={widget} dataSource={source} />}
        {widget.kind === 'chart' && <StudioChartWidget widget={widget} dataSource={source} />}
        {widget.kind === 'kpi' && <StudioKpiWidget widget={widget} dataSource={source} />}
      </Stack>
    </Paper>
  );
}

export function StudioCanvas() {
  const mode = useStudioSelector((state) => state.mode);
  const widgetIds = useStudioSelector(
    (state) => state.pages[state.dashboard.activePageId].widgetIds,
  );
  const controller = useStudioController();

  const handleMoveUp = React.useCallback(
    (widgetId: string) => {
      const state = controller.getState();
      const page = state.pages[state.dashboard.activePageId];
      const idx = page.widgetIds.indexOf(widgetId);

      if (idx <= 0) {
        return;
      }

      const newIds = [...page.widgetIds];
      [newIds[idx - 1], newIds[idx]] = [newIds[idx], newIds[idx - 1]];
      controller.updateState({
        pages: { ...state.pages, [page.id]: { ...page, widgetIds: newIds } },
      });
    },
    [controller],
  );

  const handleMoveDown = React.useCallback(
    (widgetId: string) => {
      const state = controller.getState();
      const page = state.pages[state.dashboard.activePageId];
      const idx = page.widgetIds.indexOf(widgetId);

      if (idx < 0 || idx >= page.widgetIds.length - 1) {
        return;
      }

      const newIds = [...page.widgetIds];
      [newIds[idx], newIds[idx + 1]] = [newIds[idx + 1], newIds[idx]];
      controller.updateState({
        pages: { ...state.pages, [page.id]: { ...page, widgetIds: newIds } },
      });
    },
    [controller],
  );

  if (widgetIds.length === 0) {
    return (
      <Paper
        variant="outlined"
        sx={{
          alignItems: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minHeight: 420,
          p: 4,
          borderStyle: 'dashed',
          justifyContent: 'center',
        }}
      >
        <Typography variant="h6" color="text.secondary">
          Canvas is empty
        </Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center">
          {mode === 'edit'
            ? 'Use the Compose panel to add widgets.'
            : 'Switch to Edit mode to add widgets.'}
        </Typography>
      </Paper>
    );
  }

  return (
    <Stack spacing={2}>
      {widgetIds.map((widgetId, index) => (
        <WidgetCard
          key={widgetId}
          widgetId={widgetId}
          isFirst={index === 0}
          isLast={index === widgetIds.length - 1}
          onMoveUp={() => handleMoveUp(widgetId)}
          onMoveDown={() => handleMoveDown(widgetId)}
        />
      ))}
    </Stack>
  );
}
