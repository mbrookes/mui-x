'use client';
import * as React from 'react';
import {
  Box,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioPageTheme } from '../models';
import { StudioGridWidget } from '../StudioGridWidget';
import { StudioChartWidget, CHART_MIN_HEIGHT } from '../StudioChartWidget';
import { StudioKpiWidget } from '../StudioKpiWidget';
import { StudioTextWidget } from '../StudioTextWidget';
import { StudioFilterWidget } from '../StudioFilterWidget';
import { exportGridToCsv, exportChartToPng } from '../internals/widgetUtils';
import { resolveRows } from '../internals/chartUtils';

export interface StudioWidgetCardProps {
  widgetId: string;
  isFirstRow?: boolean;
  pageTheme?: StudioPageTheme;
}

// Module-level set survives component unmount/remount (e.g. drag-and-drop repositioning).
// Widgets that have already been rendered once skip the defer on subsequent mounts
// so rearranging cards doesn't cause a visible blank-shell flash.
const hydratedWidgets = new Set<string>();
const COMPACT_WIDGET_MIN_HEIGHT = 160;

export const StudioWidgetCard = React.memo(function StudioWidgetCard(props: StudioWidgetCardProps) {
  const [hovered, setHovered] = React.useState(false);
  const { widgetId, isFirstRow = false, pageTheme } = props;
  const controller = useStudioController();
  const mode = useStudioSelector((state) => state.mode);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  // Narrow selector: only re-render when THIS widget's selection state changes
  const isSelected = useStudioSelector((state) => state.shell.selectedWidgetId === widgetId);
  // Narrow selector: true when another widget is selected (hides hover actions on this card).
  // Using `widgetId !== selectedId` avoids global "nothing selected" subscription — when
  // selection moves from A→B only cards A and B re-render rather than all N cards.
  const dimmed = useStudioSelector(
    (state) => state.shell.selectedWidgetId !== null && state.shell.selectedWidgetId !== widgetId,
  );
  const source = useStudioSelector((state) =>
    widget?.sourceId ? state.dataSources[widget.sourceId] : undefined,
  );
  // Narrow selector: only extract the rank filter for this widget to avoid
  // re-rendering all cards whenever any filter changes
  const activeRankFilter = useStudioSelector((state) => {
    if (widget?.kind !== 'chart') {
      return null;
    }
    return (
      state.filters.find(
        (f) =>
          f.scope === 'widget' &&
          f.widgetId === widgetId &&
          f.filterMode === 'rank' &&
          typeof f.value === 'number' &&
          f.value > 0,
      ) ?? null
    );
  });

  const ref = React.useRef<HTMLDivElement>(null);
  const chartContainerRef = React.useRef<HTMLDivElement>(null);
  const chartExpandContainerRef = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  // Defer heavy widget content to after the first browser paint so the card
  // shells are visible immediately on initial load. Widgets that have already
  // been rendered (tracked in hydratedWidgets) skip the defer so that
  // drag-and-drop repositioning doesn't cause a blank-shell flash.
  //
  // NOTE: intentionally NOT using startTransition/useTransition here.
  // Wrapping setShowContent in a transition makes it low-priority and lets
  // continuous mouse events (mouseenter/mouseleave hover state) preempt it
  // indefinitely, causing a ~5-second visible delay after DnD drops.
  // The requestAnimationFrame delay alone is sufficient to avoid blocking the
  // first paint without causing hover-induced starvation.
  const [showContent, setShowContent] = React.useState(() => hydratedWidgets.has(widgetId));
  React.useEffect(() => {
    hydratedWidgets.add(widgetId);
    if (showContent) {
      return undefined;
    }
    const raf = requestAnimationFrame(() => {
      setShowContent(true);
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleExport = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!widget) {
        return;
      }
      if (widget.kind === 'grid') {
        // Compute filtered rows lazily at export time — no need for a reactive subscription
        const { filters, dataSources, relationships, expressionFields } = controller.getState();
        const pageFilters = filters.filter((f) => f.scope === 'page');
        const widgetFilters = filters.filter(
          (f) => f.scope === 'widget' && f.widgetId === widget.id,
        );
        const crossFilters = filters.filter(
          (f) => f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id,
        );
        const interactiveFilters = filters.filter(
          (f) => f.scope === 'interactive' && f.sourceWidgetId !== widget.id,
        );
        const allFilters = [...pageFilters, ...widgetFilters, ...crossFilters, ...interactiveFilters];
        const rows = source?.rows
          ? resolveRows(source.rows, widget.sourceId, allFilters, dataSources, relationships, expressionFields)
          : [];
        exportGridToCsv(widget, source, rows);
      } else if (widget.kind === 'chart') {
        exportChartToPng(widget, chartContainerRef.current);
      }
    },
    [widget, source, controller],
  );

  if (!widget) {
    return null;
  }

  const canExport = widget.kind === 'grid' || widget.kind === 'chart';
  const isChart = widget.kind === 'chart';
  const showEditActions =
    mode === 'edit' && (isSelected || (!dimmed && hovered));
  const showViewExport = mode === 'view' && hovered && canExport;
  const showViewExpand = mode === 'view' && hovered && isChart;
  const actionButtonSx = { width: 24, height: 24, padding: 0, '& svg': { fontSize: 16 } } as const;

  // Overhang: center the overlay on the top edge of the card. Constrained to sit
  // inside the card for top-row widgets (where there's no room above to overhang).
  const overlayTopSx = isFirstRow
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
        borderColor: pageTheme?.cardBorderColor ?? 'divider',
        borderWidth: pageTheme?.cardBorderWidth ?? 1,
        border: pageTheme?.cardBorder === false && !isSelected ? 'none' : undefined,
        borderRadius: pageTheme?.cardRadius !== undefined ? `${pageTheme.cardRadius}px` : undefined,
        backgroundColor: pageTheme?.cardBackground ?? undefined,
        cursor: isDragging ? 'grabbing' : 'pointer',
        p: pageTheme?.cardPadding ?? 2,
        boxSizing: 'border-box',
        position: 'relative',
        minHeight:
          widget.kind === 'kpi' || widget.kind === 'filter'
            ? COMPACT_WIDGET_MIN_HEIGHT
            : undefined,
        outline: isSelected ? '2px solid' : undefined,
        outlineColor: isSelected ? 'primary.main' : undefined,
        outlineOffset: -1,
        transition: 'outline-color 0.15s',
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
            boxShadow: '0 2px 4px rgba(0,0,0,0.10)',
            px: 0.5,
            py: 0.25,
            visibility: showEditActions ? 'visible' : 'hidden',
            pointerEvents: showEditActions ? 'auto' : 'none',
          }}
        >
          {canExport && (
            <Tooltip title={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}>
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={handleExport}
                aria-label={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}
                tabIndex={showEditActions ? 0 : -1}
              >
                <DownloadIcon />
              </IconButton>
            </Tooltip>
          )}
          {isChart && (
            <Tooltip title="Expand chart">
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded(true);
                }}
                aria-label="Expand chart"
                tabIndex={showEditActions ? 0 : -1}
              >
                <OpenInFullIcon />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Duplicate widget">
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                controller.duplicateWidget(widgetId);
              }}
              aria-label="Duplicate widget"
              tabIndex={showEditActions ? 0 : -1}
            >
              <ContentCopyIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete widget">
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                controller.removeWidget(widgetId);
              }}
              aria-label="Delete widget"
              tabIndex={showEditActions ? 0 : -1}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      )}
      {mode === 'view' && (canExport || isChart) && (
        <Stack
          direction="row"
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
            visibility: showViewExport || showViewExpand ? 'visible' : 'hidden',
            pointerEvents: showViewExport || showViewExpand ? 'auto' : 'none',
          }}
        >
          {canExport && (
            <Tooltip title={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}>
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={handleExport}
                aria-label={widget.kind === 'grid' ? 'Export as CSV' : 'Export as PNG'}
                tabIndex={showViewExport ? 0 : -1}
              >
                <DownloadIcon />
              </IconButton>
            </Tooltip>
          )}
          {isChart && (
            <Tooltip title="Expand chart">
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded(true);
                }}
                aria-label="Expand chart"
                tabIndex={showViewExpand ? 0 : -1}
              >
                <OpenInFullIcon />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      )}
      <Stack spacing={widget.kind === 'grid' ? 2 : 0.5}>
        {/* Widget header */}
        <div>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography
                variant="h6"
                noWrap
                sx={widget.kind === 'text' ? {
                  ...(widget.config.textTitleColor && { color: widget.config.textTitleColor }),
                  ...(widget.config.textTitleFontFamily && {
                    fontFamily: widget.config.textTitleFontFamily === 'serif'
                      ? "Georgia, 'Times New Roman', Times, serif"
                      : "'Courier New', Courier, monospace",
                  }),
                  ...(widget.config.textTitleFontSize && { fontSize: widget.config.textTitleFontSize }),
                  ...(widget.config.textTitleAlign && { textAlign: widget.config.textTitleAlign }),
                } : undefined}
              >
                {widget.title || (widget.kind === 'kpi' ? 'KPI' : widget.kind.charAt(0).toUpperCase() + widget.kind.slice(1))}
              </Typography>
              {widget.subtitle && (
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                  {widget.subtitle}
                </Typography>
              )}
            </Box>
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
        {/* Widget content — deferred to after first paint to avoid blocking initial render */}
        {showContent && widget.kind === 'grid' && <StudioGridWidget widget={widget} dataSource={source} />}
        {showContent && widget.kind === 'chart' && (
          <Box ref={chartContainerRef} sx={{ minHeight: CHART_MIN_HEIGHT }}>
            <StudioChartWidget widget={widget} dataSource={source} height={CHART_MIN_HEIGHT} />
          </Box>
        )}
        {showContent && widget.kind === 'kpi' && <StudioKpiWidget widget={widget} dataSource={source} />}
        {showContent && widget.kind === 'text' && <StudioTextWidget widget={widget} />}
        {showContent && widget.kind === 'filter' && <StudioFilterWidget widget={widget} dataSource={source} />}
      </Stack>
      {/* Chart full-screen overlay dialog */}
      {isChart && expanded && (
        <Dialog
          open={expanded}
          onClose={() => setExpanded(false)}
          maxWidth={false}
          slotProps={{
            paper: {
              sx: {
                width: 'min(1400px, 90vw)',
                maxWidth: 'none',
              },
            },
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="h6" noWrap>
                {widget.title || 'Chart'}
              </Typography>
              {widget.subtitle && (
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                  {widget.subtitle}
                </Typography>
              )}
            </Box>
            <IconButton
              size="small"
              onClick={() => setExpanded(false)}
              aria-label="Close expanded chart"
              sx={{ flexShrink: 0 }}
            >
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent sx={{ p: 2, pt: 0 }}>
            <Box ref={chartExpandContainerRef}>
              <StudioChartWidget widget={widget} dataSource={source} height={500} />
            </Box>
          </DialogContent>
          <DialogActions sx={{ px: 2, pb: 1.5 }}>
            <Tooltip title="Export as PNG">
              <IconButton
                size="small"
                onClick={() => exportChartToPng(widget, chartExpandContainerRef.current)}
                aria-label="Export expanded chart as PNG"
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </DialogActions>
        </Dialog>
      )}
    </Paper>
  );
});
