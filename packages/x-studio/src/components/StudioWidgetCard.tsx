'use client';
import * as React from 'react';
import { Box, Chip, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioPageTheme } from '../models';
import { StudioGridWidget } from './StudioGridWidget';
import { StudioChartWidget } from './StudioChartWidget';
import { StudioKpiWidget } from './StudioKpiWidget';
import { StudioTextWidget } from './StudioTextWidget';
import { exportGridToCsv, exportChartToPng } from './widgetUtils';
import { resolveRows } from './chartUtils';

export interface StudioWidgetCardProps {
  widgetId: string;
  isFirstRow?: boolean;
  pageTheme?: StudioPageTheme;
}

export function StudioWidgetCard(props: StudioWidgetCardProps) {
  const [hovered, setHovered] = React.useState(false);
  const { widgetId, isFirstRow = false, pageTheme } = props;
  const controller = useStudioController();
  const mode = useStudioSelector((state) => state.mode);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const filters = useStudioSelector((state) => state.filters);
  const isSelected = selectedWidgetId === widgetId;
  const source = useStudioSelector((state) =>
    widget?.sourceId ? state.dataSources[widget.sourceId] : undefined,
  );
  const activeRankFilter = widget?.kind === 'chart'
    ? filters.find(
        (f) =>
          f.scope === 'widget' &&
          f.widgetId === widgetId &&
          f.filterMode === 'rank' &&
          typeof f.value === 'number' &&
          f.value > 0,
      ) ?? null
    : null;

  const ref = React.useRef<HTMLDivElement>(null);
  const chartContainerRef = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  React.useEffect(() => {
    if (mode !== 'edit') {
      return undefined;
    }
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    function handleDragStart(event: DragEvent) {
      setIsDragging(true);
      controller.setSelectedWidget(widgetId);
      event.dataTransfer?.setData(
        'application/json',
        JSON.stringify({ type: 'canvas-widget', widgetId }),
      );
      if (node) {
        event.dataTransfer?.setDragImage(node, 0, 0);
      }
    }
    function handleDragEnd() {
      setIsDragging(false);
    }
    node.setAttribute('draggable', 'true');
    node.addEventListener('dragstart', handleDragStart);
    node.addEventListener('dragend', handleDragEnd);
    return () => {
      node.removeAttribute('draggable');
      node.removeEventListener('dragstart', handleDragStart);
      node.removeEventListener('dragend', handleDragEnd);
    };
  }, [widgetId, mode, controller]);

  const filteredRows = React.useMemo(() => {
    if (!source?.rows || !widget) {
      return [];
    }
    const { dataSources, relationships } = controller.getState();
    const pageFilters = filters.filter((f) => f.scope === 'page');
    const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === widget.id);
    const crossFilters = filters.filter(
      (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id,
    );
    const allFilters = [...pageFilters, ...widgetFilters, ...crossFilters];
    return resolveRows(source.rows, widget.sourceId, allFilters, dataSources, relationships);
  }, [source, widget, filters, controller]);

  const handleExport = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!widget) {
        return;
      }
      if (widget.kind === 'grid') {
        exportGridToCsv(widget, source, filteredRows);
      } else if (widget.kind === 'chart') {
        exportChartToPng(widget, chartContainerRef.current);
      }
    },
    [widget, source, filteredRows],
  );

  if (!widget) {
    return null;
  }

  const canExport = widget.kind === 'grid' || widget.kind === 'chart';
  const showEditActions =
    mode === 'edit' && (isSelected || (!isSelected && !selectedWidgetId && hovered));
  const showViewExport = mode === 'view' && hovered && canExport;
  const isTopRow = isFirstRow;
  // Overhang: center the overlay on the top edge of the card. Constrained to sit
  // inside the card for top-row widgets (where there's no room above to overhang).
  const overlayTopSx = isTopRow
    ? { top: 6 }
    : { top: 0, transform: 'translateY(-50%)' };

  return (
    <Paper
      ref={ref}
      variant="outlined"
      onClick={() => controller.setSelectedWidget(widgetId)}
      aria-selected={isSelected}
      aria-label={`Widget: ${widget.title}`}
      data-widget-card
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          controller.setSelectedWidget(widgetId);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={{
        borderColor: isSelected ? 'primary.main' : (pageTheme?.cardBorderColor ?? 'divider'),
        borderWidth: isSelected ? 2 : (pageTheme?.cardBorderWidth ?? 1),
        border: pageTheme?.cardBorder === false && !isSelected ? 'none' : undefined,
        borderRadius: pageTheme?.cardRadius !== undefined ? `${pageTheme.cardRadius}px` : undefined,
        backgroundColor: pageTheme?.cardBackground ?? undefined,
        cursor: isDragging ? 'grabbing' : 'pointer',
        p: pageTheme?.cardPadding ?? 2,
        height: '100%',
        boxSizing: 'border-box',
        opacity: isDragging ? 0.5 : 1,
        position: 'relative',
        transition: 'border-color 0.15s',
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
        boxShadow: isDragging ? 4 : undefined,
      }}
    >
      {/* Action button overlay — floats over content so title is never truncated */}
      {mode === 'edit' && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            position: 'absolute',
            ...overlayTopSx,
            right: 6,
            zIndex: 1,
            alignItems: 'center',
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            boxShadow: '0 2px 6px rgba(0,0,0,0.10)',
            px: 0.5,
            visibility: showEditActions ? 'visible' : 'hidden',
            pointerEvents: showEditActions ? 'auto' : 'none',
          }}
        >
          {canExport && (
            <Tooltip title={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}>
              <IconButton
                size="small"
                onClick={handleExport}
                aria-label={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}
                tabIndex={showEditActions ? 0 : -1}
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Duplicate widget">
            <IconButton
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                controller.duplicateWidget(widgetId);
              }}
              aria-label="Duplicate widget"
              tabIndex={showEditActions ? 0 : -1}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete widget">
            <IconButton
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                controller.removeWidget(widgetId);
              }}
              aria-label="Delete widget"
              tabIndex={showEditActions ? 0 : -1}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      )}
      {mode === 'view' && canExport && (
        <Box
          sx={{
            position: 'absolute',
            ...overlayTopSx,
            right: 6,
            zIndex: 1,
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            boxShadow: '0 2px 6px rgba(0,0,0,0.10)',
            visibility: showViewExport ? 'visible' : 'hidden',
            pointerEvents: showViewExport ? 'auto' : 'none',
          }}
        >
          <Tooltip title={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}>
            <IconButton
              size="small"
              onClick={handleExport}
              aria-label={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}
              tabIndex={showViewExport ? 0 : -1}
            >
              <DownloadIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      <Stack spacing={2}>
        {/* Widget header */}
        <div>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="h6" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
              {widget.title}
            </Typography>
            {activeRankFilter && (
              <Chip
                size="small"
                label={`${activeRankFilter.rankDirection === 'bottom' ? 'Bottom' : 'Top'} ${activeRankFilter.value}`}
                color="primary"
                variant="outlined"
                sx={{ flexShrink: 0, height: 20, fontSize: 11 }}
              />
            )}
          </Stack>
        </div>
        {/* Widget content */}
        {widget.kind === 'grid' && <StudioGridWidget widget={widget} dataSource={source} />}
        {widget.kind === 'chart' && (
          <Box ref={chartContainerRef}>
            <StudioChartWidget widget={widget} dataSource={source} />
          </Box>
        )}
        {widget.kind === 'kpi' && <StudioKpiWidget widget={widget} dataSource={source} />}
        {widget.kind === 'text' && <StudioTextWidget widget={widget} />}
      </Stack>
    </Paper>
  );
}
