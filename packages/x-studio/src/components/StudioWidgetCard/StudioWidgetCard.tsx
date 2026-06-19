'use client';
import * as React from 'react';
import {
  Box,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import dayjs from 'dayjs';

import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  useCustomWidgetMap,
  selectMode,
  selectPages,
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
  makeSelectPartitionedBaseFiltersForPage,
  makeSelectWidget,
  makeSelectIsWidgetSelected,
  makeSelectIsWidgetDimmed,
  makeSelectWidgetSource,
  makeSelectWidgetRankFilter,
  makeSelectWidgetSliderFilter,
  makeSelectWidgetActiveCrossFilter,
} from '../../context';
import { StudioWidgetCardActionsOverlay } from './StudioWidgetCardActionsOverlay';
import { moveWidgetInLayout, type WidgetMoveDirection } from '../../internals/widgetLayoutMove';
import { useStudioAnnounce } from '../../internals/StudioLiveRegion';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { StudioWidgetEditDialog } from '../StudioWidgetEditDialog';
import type { StudioPageTheme } from '../../models';
import { StudioGridWidget } from '../widgets/StudioGridWidget/StudioGridWidget';
import type { StudioGridWidgetProps } from '../widgets/StudioGridWidget/StudioGridWidget';
import { StudioChartWidget, CHART_MIN_HEIGHT } from '../widgets/StudioChartWidget';
import type { StudioChartWidgetProps } from '../widgets/StudioChartWidget';
import { StudioKpiWidget } from '../widgets/StudioKpiWidget';
import type { StudioKpiWidgetProps } from '../widgets/StudioKpiWidget/StudioKpiWidget';
import { StudioTextWidget } from '../widgets/StudioTextWidget';
import type { StudioTextWidgetProps } from '../widgets/StudioTextWidget/StudioTextWidget';
import { StudioFilterWidget } from '../widgets/StudioFilterWidget';
import type { StudioFilterWidgetProps } from '../widgets/StudioFilterWidget';
import { StudioPivotWidget } from '../widgets/StudioPivotWidget/StudioPivotWidget';
import { StudioMapWidget } from '../widgets/StudioMapWidget';
import {
  exportGridToCsv,
  exportChartToPng,
  inferKpiDateSubtitle,
} from '../../internals/widgetUtils';
import { canDetectAnomalies } from '../../internals/anomalyDetection';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { SliderFilterPill } from './SliderFilterPill';
import {
  DRAG_TYPE_CANVAS_WIDGET,
  type CanvasWidgetDragItem,
} from '../StudioCanvas/studioWidgetDndTypes';
import { useStudioDraggable } from '../StudioCanvas/useStudioDraggable';
import { createClonePreview } from '../StudioCanvas/createClonePreview';

export interface StudioWidgetCardProps {
  widgetId: string;
  /** ID of the page this widget card belongs to. Used to scope filters and drag metadata. */
  pageId: string;
  isFirstRow?: boolean;
  pageTheme?: StudioPageTheme;
  /** Replaceable sub-components. */
  slots?: {
    /** Custom component rendered over widget content while cross-filters recompute. */
    loadingOverlay?: React.ElementType;
  };
  /** Props forwarded to slot components. */
  slotProps?: {
    /** Extra props spread onto the default or custom loading overlay. Currently unused by the default overlay but available for custom implementations. */
    loadingOverlay?: object;
    /** Extra props spread onto `StudioChartWidget` for chart widgets. */
    chart?: Partial<Omit<StudioChartWidgetProps, 'widget' | 'dataSource'>>;
    /** Extra props spread onto `StudioGridWidget` for grid widgets. */
    grid?: Partial<Omit<StudioGridWidgetProps, 'widget' | 'dataSource'>>;
    /** Extra props spread onto `StudioKpiWidget` for KPI widgets. */
    kpi?: Partial<Omit<StudioKpiWidgetProps, 'widget' | 'dataSource'>>;
    /** Extra props spread onto `StudioFilterWidget` for filter widgets. */
    filter?: Partial<Omit<StudioFilterWidgetProps, 'widget' | 'dataSource'>>;
    /** Extra props spread onto `StudioTextWidget` for text widgets. */
    text?: Partial<Omit<StudioTextWidgetProps, 'widget'>>;
    /** Extra props spread onto the outer MUI `Paper` card shell. The `sx` prop is merged additively. */
    paper?: Omit<import('@mui/material').PaperProps, 'sx'> & { sx?: object };
  };
  /**
   * Called when a widget that has no data source configured is clicked.
   * Use this in composed layouts to open a configuration panel automatically,
   * guiding users to complete the widget setup.
   * @param {string} widgetId The ID of the widget that needs configuration.
   */
  onUnconfiguredClick?: (widgetId: string) => void;
  /**
   * Called when the user clicks the "Edit" action on a widget card.
   * When provided, the built-in `StudioWidgetEditDialog` is NOT rendered — the
   * caller is responsible for opening a configuration UI for the given widget.
   * When omitted, the card opens `StudioWidgetEditDialog` internally.
   * @param {string} widgetId The ID of the widget to edit.
   */
  onEditRequest?: (widgetId: string) => void;
  /**
   * Called when the user clicks the "AI assistant" action on a widget card.
   * When provided, an AI icon button appears in the widget's action overlay.
   * When omitted, the AI button is not shown.
   * @param {string} widgetId The ID of the widget to assist with.
   */
  onAiRequest?: (widgetId: string) => void;
  /**
   * Called when the user triggers an AI insight action (summary/analysis/forecast/anomaly).
   * The `prompt` is a ready-to-send message for the chat panel.
   * When omitted, the insight button is not shown.
   * @param {string} widgetId The ID of the widget.
   * @param {string} prompt The pre-built chat message to submit.
   */
  onInsightRequest?: (widgetId: string, prompt: string) => void;
}

// Module-level set survives component unmount/remount (e.g. drag-and-drop repositioning).
// Widgets that have already been rendered once skip the defer on subsequent mounts
// so rearranging cards doesn't cause a visible blank-shell flash.
const hydratedWidgets = new Set<string>();

const KPI_WIDGET_MIN_HEIGHT = 160;
const FILTER_WIDGET_MIN_HEIGHT = KPI_WIDGET_MIN_HEIGHT / 2;
const MAP_WIDGET_DEFAULT_HEIGHT = 400;

function DefaultLoadingOverlay() {
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(255,255,255,0.6)',
        zIndex: 1,
        borderRadius: 'inherit',
        backdropFilter: 'blur(2px)',
      }}
    >
      <CircularProgress size={24} />
    </Box>
  );
}

export const StudioWidgetCard = React.memo(function StudioWidgetCard(props: StudioWidgetCardProps) {
  const [hovered, setHovered] = React.useState(false);
  const {
    widgetId,
    pageId,
    isFirstRow = false,
    pageTheme,
    slots,
    slotProps,
    onUnconfiguredClick,
    onEditRequest,
    onAiRequest,
    onInsightRequest,
  } = props;
  const controller = useStudioController();
  // Create stable selector functions scoped to this widgetId / pageId.
  // Using React.useMemo ensures the selector identity is preserved across renders
  // so React 19's useSyncExternalStore doesn't recreate getSelection each render.
  const selectWidgetFn = React.useMemo(() => makeSelectWidget(widgetId), [widgetId]);
  const selectIsSelectedFn = React.useMemo(() => makeSelectIsWidgetSelected(widgetId), [widgetId]);
  const selectIsDimmedFn = React.useMemo(() => makeSelectIsWidgetDimmed(widgetId), [widgetId]);
  const selectSourceFn = React.useMemo(() => makeSelectWidgetSource(widgetId), [widgetId]);
  const selectRankFilterFn = React.useMemo(() => makeSelectWidgetRankFilter(widgetId), [widgetId]);
  const selectSliderFilterFn = React.useMemo(
    () => makeSelectWidgetSliderFilter(widgetId, pageId),
    [widgetId, pageId],
  );
  const selectCrossFilterFn = React.useMemo(
    () => makeSelectWidgetActiveCrossFilter(widgetId, pageId),
    [widgetId, pageId],
  );
  const selectBasePartitioned = React.useMemo(
    () => makeSelectPartitionedBaseFiltersForPage(pageId),
    [pageId],
  );

  const mode = useStudioSelector(selectMode);
  const theme = useTheme();
  const widget = useStudioSelector(selectWidgetFn);
  const isSelected = useStudioSelector(selectIsSelectedFn);
  const dimmed = useStudioSelector(selectIsDimmedFn);
  const source = useStudioSelector(selectSourceFn);
  const activeRankFilter = useStudioSelector(selectRankFilterFn);
  const activeSliderFilter = useStudioSelector(selectSliderFilterFn);
  const activeCrossFilter = useStudioSelector(selectCrossFilterFn);
  const pages = useStudioSelector(selectPages);
  const allFilters = useStudioSelector(selectFilters);
  const allDataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const localeText = useStudioLocaleText();
  const customWidgetMap = useCustomWidgetMap();
  const features = useStudioFeatures();

  // For KPI widgets with auto subtitle and no user-set subtitle, derive a date range label
  // dynamically from the active date filters so it always reflects current filter state.
  const effectiveSubtitle = React.useMemo(() => {
    if (!widget) {
      return '';
    }
    const isAutoSubtitle =
      widget.subtitleMode === 'auto' || (!widget.subtitleMode && !widget.subtitle);
    if (widget.kind === 'kpi' && isAutoSubtitle) {
      return inferKpiDateSubtitle(widget, allFilters, localeText) ?? widget.subtitle ?? '';
    }
    return widget.subtitle ?? '';
  }, [widget, allFilters, localeText]);
  // Look up the custom widget definition for non-builtin widget kinds
  const customDef =
    widget && !['grid', 'chart', 'kpi', 'text', 'filter', 'pivot', 'map'].includes(widget.kind)
      ? (customWidgetMap.get(widget.kind) ?? null)
      : null;

  // Enrich the raw data source with expression-field values (L2 pipeline) for custom widgets.
  // Built-in widgets handle enrichment themselves via useWidgetRows; custom widgets receive
  // raw rows by default, but expression fields (e.g. computed columns) would not resolve.
  // We apply L2 enrichment here (no filter application) so `dataSource.rows` includes all
  // computed column values. The enriched result is stable — getCachedEnrichedRows caches by
  // reference, so repeated renders with the same inputs return the same array.
  const enrichedCustomSource = React.useMemo(() => {
    if (!customDef || !source) {
      return source ?? undefined;
    }
    const pipeline = createStudioPipeline({
      dataSources: allDataSources,
      relationships,
      expressionFields,
      filters: [],
    });
    const enrichedRows = pipeline.getEnrichedRows(source.rows ?? [], source.id);
    return { ...source, rows: enrichedRows };
  }, [customDef, source, allDataSources, relationships, expressionFields]);

  // Full-bleed custom widgets render edge-to-edge: no title/subtitle header and no card padding.
  const isFullBleedCustom = customDef?.fullBleed === true;

  // AI insights are disabled for filter/text/kpi widgets; custom widgets opt in via `aiInsight: true`.
  // The `aiInsights` feature flag lets embedders hide per-widget AI actions independently of AI chat.
  const supportsInsight =
    features.aiInsights &&
    widget != null &&
    widget.kind !== 'filter' &&
    widget.kind !== 'text' &&
    widget.kind !== 'kpi' &&
    (customDef === null || customDef.aiInsight === true);

  // ── AI Insight routing ────────────────────────────────────────────────────
  const handleInsightRequest = React.useCallback(
    (type: 'summary' | 'analysis' | 'forecast' | 'correlation') => {
      if (!onInsightRequest || !widget) {
        return;
      }
      const title = widget.title || widget.kind;
      let prompt: string;
      if (type === 'summary') {
        prompt = `Give me a 2–3 sentence high-level summary of the "${title}" widget — what it shows and the single most important takeaway. Be brief, no bullet points.`;
      } else if (type === 'analysis') {
        prompt = `Analyse the "${title}" widget — identify key trends, patterns, and notable values`;
      } else if (type === 'forecast') {
        prompt = `Forecast the "${title}" widget — what trend do you expect over the next few periods?`;
      } else if (type === 'correlation') {
        prompt = `Show a correlation analysis for the "${title}" widget`;
      } else {
        prompt = `Analyse the "${title}" widget`;
      }
      onInsightRequest(widgetId, prompt);
    },
    [onInsightRequest, widget, widgetId],
  );

  // ── Anomaly detection state ────────────────────────────────────────────────
  const [anomalyEnabled, setAnomalyEnabled] = React.useState(false);
  const [anomalyAnnotations, setAnomalyAnnotations] = React.useState<
    import('../../models/baseTypes').StudioChartAnnotation[]
  >([]);
  // Toggle anomaly detection; clear annotations immediately when disabling
  const handleAnomalyToggle = React.useCallback(() => {
    setAnomalyEnabled((prev) => {
      if (prev) {
        setAnomalyAnnotations([]);
      }
      return !prev;
    });
  }, []);

  const handleAnomalyExplain = React.useCallback(() => {
    if (!onInsightRequest || !anomalyAnnotations.length || !widget) {
      return;
    }
    const title = widget.title || widget.kind;
    const annotationDetails = anomalyAnnotations
      .map((a) => {
        const axisLabel = a.axis === 'x' ? 'X-axis' : 'Y-axis';
        const labelPart = a.label ? ` (${a.label})` : '';
        return `- ${axisLabel} anomaly at ${JSON.stringify(a.value)}${labelPart}`;
      })
      .join('\n');
    const prompt = `Explain the anomalies detected in the "${title}" widget:\n${annotationDetails}`;
    onInsightRequest(widgetId, prompt);
  }, [onInsightRequest, anomalyAnnotations, widget, widgetId]);

  // Pages the user can move this widget to (all pages except the one this widget is on)
  const moveToPageOptions = React.useMemo(
    () =>
      Object.values(pages).flatMap((p) => (p.id !== pageId ? [{ id: p.id, title: p.title }] : [])),
    [pages, pageId],
  );

  // Keyboard-accessible canvas reorder (the drag-and-drop path is pointer-only).
  const widgetRows = React.useMemo(() => pages[pageId]?.widgetRows ?? [], [pages, pageId]);
  const announce = useStudioAnnounce();
  const handleMoveWidget = React.useCallback(
    (direction: WidgetMoveDirection) => {
      const next = moveWidgetInLayout(widgetRows, widgetId, direction);
      if (next) {
        controller.setWidgetLayout(next);
        announce(localeText.canvasWidgetMovedAnnouncement);
      }
    },
    [widgetRows, widgetId, controller, announce, localeText],
  );
  const moveWidgetDisabled = React.useMemo(
    () => ({
      up: moveWidgetInLayout(widgetRows, widgetId, 'up') === null,
      down: moveWidgetInLayout(widgetRows, widgetId, 'down') === null,
      left: moveWidgetInLayout(widgetRows, widgetId, 'left') === null,
      right: moveWidgetInLayout(widgetRows, widgetId, 'right') === null,
    }),
    [widgetRows, widgetId],
  );

  const ref = React.useRef<HTMLDivElement>(null);
  const chartContainerRef = React.useRef<HTMLDivElement>(null);
  const chartExpandContainerRef = React.useRef<HTMLDivElement>(null);
  const pivotExportRef = React.useRef<(() => void) | null>(null);
  const textAiRefreshRef = React.useRef<(() => void) | null>(null);
  // Detect when filter recomputation is in-flight (deferred rendering).
  // Only relevant for chart and grid widgets that go through useWidgetRows.
  // Detect when filter recomputation is in-flight (deferred rendering).
  // Scoped to this widget's own page so inactive pages don't show spurious spinners.
  const partitioned = useStudioSelector(selectBasePartitioned);
  const deferredPartitioned = React.useDeferredValue(partitioned);
  const isRecomputing =
    (widget?.kind === 'chart' || widget?.kind === 'grid' || widget?.kind === 'pivot') &&
    deferredPartitioned !== partitioned;

  const LoadingOverlay = slots?.loadingOverlay ?? DefaultLoadingOverlay;

  const [isDragging, setIsDragging] = React.useState(false);

  const getData = React.useCallback(
    (): CanvasWidgetDragItem => ({
      type: DRAG_TYPE_CANVAS_WIDGET,
      widgetId,
      sourcePageId: pageId,
    }),
    [widgetId, pageId],
  );

  const renderPreview = React.useMemo(() => createClonePreview(ref), []);

  useStudioDraggable({
    ref,
    canDrag: mode === 'edit',
    getData,
    renderPreview,
    onDragStart: () => {
      setIsDragging(true);
      document.body.dataset.studioDraggingWidgetId = widgetId;
      if (ref.current) {
        ref.current.style.opacity = '0.1';
      }
    },
    onDrop: () => {
      setIsDragging(false);
      delete document.body.dataset.studioDraggingWidgetId;
      if (ref.current) {
        ref.current.style.opacity = '';
      }
    },
  });

  const [expanded, setExpanded] = React.useState(false);
  // Built-in edit dialog — only used when onEditRequest is not provided
  const [editDialogOpen, setEditDialogOpen] = React.useState(false);

  const handleEditClick = React.useCallback(() => {
    if (onEditRequest) {
      onEditRequest(widgetId);
    } else {
      setEditDialogOpen(true);
    }
  }, [onEditRequest, widgetId]);

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
  }, [showContent, widgetId]);

  const handleExport = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!widget) {
        return;
      }
      if (widget.kind === 'grid' && widget.sourceId) {
        // Compute filtered rows lazily at export time — no need for a reactive subscription
        const state = controller.getState();
        const pipeline = createStudioPipeline(state);
        const sourceRows = source?.rows ?? [];
        const rows =
          sourceRows.length > 0
            ? pipeline.resolveWidgetRows(widget.id, widget.sourceId, sourceRows, pageId)
            : [];
        exportGridToCsv(widget, source, rows);
      } else if (widget.kind === 'chart') {
        exportChartToPng(widget, chartContainerRef.current, theme.palette.background.default);
      } else if (widget.kind === 'pivot') {
        pivotExportRef.current?.();
      }
    },
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- deps are correct
    [widget, source, controller, theme.palette.background.default],
  );

  if (!widget) {
    return null;
  }

  // In view mode, let the custom widget def opt into collapsing the entire card.
  // Pass the enriched source so shouldHide can evaluate expression-field–driven conditions.
  if (mode === 'view' && customDef?.shouldHide?.({ widget, dataSource: enrichedCustomSource })) {
    return null;
  }

  const canExport =
    features.export &&
    (widget.kind === 'grid' || widget.kind === 'chart' || widget.kind === 'pivot');
  const isChart = widget.kind === 'chart';
  const showEditActions = !isDragging && mode === 'edit' && (isSelected || (!dimmed && hovered));
  const showViewExport = mode === 'view' && hovered && canExport;
  const showViewExpand = mode === 'view' && hovered && isChart;
  const exportLabel =
    widget.kind === 'chart' ? localeText.widgetExportPngTooltip : localeText.widgetExportCsvTooltip;

  // Overhang: center the overlay on the top edge of the card. Constrained to sit
  // inside the card for top-row widgets (where there's no room above to overhang).
  const overlayTopSx = isFirstRow ? { top: 6 } : { top: 0, transform: 'translateY(-50%)' };
  let minHeight: number | undefined;
  if (widget.kind === 'kpi') {
    minHeight = KPI_WIDGET_MIN_HEIGHT;
  } else if (widget.kind === 'filter') {
    minHeight = FILTER_WIDGET_MIN_HEIGHT;
  }

  return (
    <Box sx={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Paper
        ref={ref}
        variant="outlined"
        {...slotProps?.paper}
        onClick={() => {
          controller.setSelectedWidget(widgetId);
          if (
            mode === 'edit' &&
            onUnconfiguredClick &&
            widget.kind !== 'text' &&
            !widget.sourceId
          ) {
            onUnconfiguredClick(widgetId);
          }
        }}
        role="group"
        aria-current={isSelected ? true : undefined}
        aria-label={localeText.filtersSectionWidgetTitle(widget.title ?? '')}
        data-widget-card
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            controller.setSelectedWidget(widgetId);
            if (
              mode === 'edit' &&
              onUnconfiguredClick &&
              widget.kind !== 'text' &&
              !widget.sourceId
            ) {
              onUnconfiguredClick(widgetId);
            }
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        sx={{
          borderColor: pageTheme?.cardBorderColor ?? 'divider',
          borderWidth: pageTheme?.cardBorderWidth ?? 1,
          border: pageTheme?.cardBorder === false && !isSelected ? 'none' : undefined,
          borderRadius:
            pageTheme?.cardRadius !== undefined ? `${pageTheme.cardRadius}px` : undefined,
          backgroundColor: pageTheme?.cardBackground ?? undefined,
          cursor: isDragging ? 'move' : 'default',
          p: isFullBleedCustom ? 0 : (pageTheme?.cardPadding ?? 2),
          boxSizing: 'border-box',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          minHeight,
          outline: isSelected ? '2px solid' : undefined,
          outlineColor: isSelected ? 'primary.main' : undefined,
          outlineOffset: -1,
          transition: 'outline-color 0.15s',
          '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
          boxShadow: isDragging ? 4 : undefined,
          ...(slotProps?.paper?.sx ?? {}),
        }}
      >
        {/* Action button overlay — floats over content so title is never truncated */}
        <StudioWidgetCardActionsOverlay
          mode={mode}
          canExport={canExport}
          isChart={isChart}
          exportLabel={exportLabel}
          showEditActions={showEditActions}
          showViewExport={showViewExport}
          showViewExpand={showViewExpand}
          overlayTopSx={overlayTopSx}
          moveToPageOptions={moveToPageOptions}
          onAiRequest={onAiRequest ? () => onAiRequest(widgetId) : undefined}
          onAiRefresh={
            widget.kind === 'text' && widget.config.textAiEnabled && (mode === 'edit' || hovered)
              ? () => textAiRefreshRef.current?.()
              : undefined
          }
          onInsightRequest={supportsInsight && onInsightRequest ? handleInsightRequest : undefined}
          anomalyEnabled={anomalyEnabled}
          anomalyCount={anomalyAnnotations.length}
          onAnomalyToggle={
            widget && features.aiInsights && canDetectAnomalies(widget)
              ? handleAnomalyToggle
              : undefined
          }
          onAnomalyExplain={
            widget &&
            onInsightRequest &&
            anomalyEnabled &&
            anomalyAnnotations.length > 0 &&
            canDetectAnomalies(widget)
              ? handleAnomalyExplain
              : undefined
          }
          onExport={handleExport}
          onExpand={() => setExpanded(true)}
          onEdit={handleEditClick}
          onDuplicate={() => controller.duplicateWidget(widgetId)}
          onDelete={() => controller.removeWidget(widgetId)}
          onMoveToPage={(pageId) => controller.moveWidgetToPage(widgetId, pageId)}
          onMoveWidget={handleMoveWidget}
          moveWidgetDisabled={moveWidgetDisabled}
        />
        <Stack spacing={widget.kind === 'grid' ? 2 : 0.5} sx={{ flexGrow: 1, minHeight: 0 }}>
          {/* Widget header — omitted for full-bleed custom widgets that render edge-to-edge */}
          {!isFullBleedCustom && (
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                <Typography
                  variant="h6"
                  noWrap
                  sx={{
                    minWidth: 0,
                    flexShrink: 1,
                    ...(widget.kind === 'text' && {
                      flexGrow: 1,
                      ...(widget.config.textTitleColor && {
                        color: widget.config.textTitleColor,
                      }),
                      ...(widget.config.textTitleFontFamily && {
                        fontFamily:
                          widget.config.textTitleFontFamily === 'serif'
                            ? "Georgia, 'Times New Roman', Times, serif"
                            : "'Courier New', Courier, monospace",
                      }),
                      ...(widget.config.textTitleFontSize && {
                        fontSize: widget.config.textTitleFontSize,
                      }),
                      ...(widget.config.textTitleAlign && {
                        textAlign: widget.config.textTitleAlign,
                      }),
                    }),
                  }}
                >
                  {widget.title ||
                    (widget.kind === 'kpi'
                      ? 'KPI'
                      : widget.kind.charAt(0).toUpperCase() + widget.kind.slice(1))}
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
                {activeCrossFilter && (
                  <Chip
                    size="small"
                    label={(() => {
                      const fieldLabel =
                        source?.fields.find((f) => f.id === activeCrossFilter.field)?.label ??
                        activeCrossFilter.field;
                      const val = activeCrossFilter.value;
                      let valueLabel: string;
                      if (val !== null && typeof val === 'object' && 'from' in val && 'to' in val) {
                        // between filter (e.g. date range emitted by a period-grouped bar click)
                        const r = val as { from?: string; to?: string };
                        const fmtDate = (s?: string) => (s ? dayjs(s).format('D MMM YYYY') : '');
                        valueLabel =
                          r.from && r.to && r.from !== r.to
                            ? `${fmtDate(r.from)} – ${fmtDate(r.to)}`
                            : fmtDate(r.from ?? r.to) || '';
                      } else {
                        valueLabel = String(val ?? '');
                      }
                      return `${fieldLabel}: ${valueLabel}`;
                    })()}
                    onDelete={() => controller.clearCrossFilter(widgetId)}
                    color="primary"
                    variant="outlined"
                    sx={{ flexShrink: 0, height: 20, fontSize: 11 }}
                  />
                )}
                {activeSliderFilter && (
                  <SliderFilterPill
                    filter={activeSliderFilter}
                    source={source}
                    onClear={() => controller.clearInteractiveFilter(widgetId)}
                  />
                )}
              </Stack>
              {effectiveSubtitle && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ display: 'block' }}
                >
                  {effectiveSubtitle}
                </Typography>
              )}
            </Box>
          )}
          {/* Widget content — deferred to after first paint to avoid blocking initial render.
            A Skeleton placeholder preserves the card's height so the layout does not
            shift when real content arrives (avoids CLS). */}
          {widget.kind === 'grid' &&
            (showContent ? (
              <Box sx={{ position: 'relative' }}>
                <StudioGridWidget
                  widget={widget}
                  dataSource={source}
                  pageId={pageId}
                  {...slotProps?.grid}
                />
                {isRecomputing && <LoadingOverlay />}
              </Box>
            ) : (
              <Skeleton
                variant="rectangular"
                height={widget.config.gridHeight ?? 400}
                sx={{ borderRadius: 1 }}
              />
            ))}
          {widget.kind === 'chart' &&
            (showContent ? (
              <Box sx={{ position: 'relative' }}>
                <Box ref={chartContainerRef} sx={{ minHeight: CHART_MIN_HEIGHT }}>
                  <StudioChartWidget
                    widget={widget}
                    dataSource={source}
                    pageId={pageId}
                    height={CHART_MIN_HEIGHT}
                    anomalyEnabled={anomalyEnabled}
                    onAnomalyDetected={setAnomalyAnnotations}
                    {...slotProps?.chart}
                  />
                </Box>
                {isRecomputing && <LoadingOverlay />}
              </Box>
            ) : (
              <Skeleton variant="rectangular" height={CHART_MIN_HEIGHT} sx={{ borderRadius: 1 }} />
            ))}
          {widget.kind === 'kpi' &&
            (showContent ? (
              <Box sx={{ flexGrow: 1, minHeight: 0 }}>
                <StudioKpiWidget
                  widget={widget}
                  dataSource={source}
                  pageId={pageId}
                  {...slotProps?.kpi}
                />
              </Box>
            ) : (
              <Skeleton
                variant="rectangular"
                height={KPI_WIDGET_MIN_HEIGHT - 48}
                sx={{ borderRadius: 1 }}
              />
            ))}
          {widget.kind === 'text' &&
            (showContent ? (
              <StudioTextWidget
                widget={widget}
                aiRefreshRef={textAiRefreshRef}
                {...slotProps?.text}
              />
            ) : (
              <Skeleton variant="rectangular" height={60} sx={{ borderRadius: 1 }} />
            ))}
          {widget.kind === 'filter' &&
            (showContent ? (
              <StudioFilterWidget widget={widget} dataSource={source} {...slotProps?.filter} />
            ) : (
              <Skeleton
                variant="rectangular"
                height={FILTER_WIDGET_MIN_HEIGHT - 48}
                sx={{ borderRadius: 1 }}
              />
            ))}
          {widget.kind === 'pivot' &&
            (showContent ? (
              <Box sx={{ position: 'relative' }}>
                <StudioPivotWidget
                  widget={widget}
                  dataSource={source}
                  pageId={pageId}
                  exportRef={pivotExportRef}
                />
                {isRecomputing && <LoadingOverlay />}
              </Box>
            ) : (
              <Skeleton variant="rectangular" height={300} sx={{ borderRadius: 1 }} />
            ))}
          {widget.kind === 'map' &&
            (showContent ? (
              <Box sx={{ position: 'relative', height: MAP_WIDGET_DEFAULT_HEIGHT }}>
                {source && <StudioMapWidget widget={widget} dataSource={source} pageId={pageId} />}
                {isRecomputing && <LoadingOverlay />}
              </Box>
            ) : (
              <Skeleton
                variant="rectangular"
                height={MAP_WIDGET_DEFAULT_HEIGHT}
                sx={{ borderRadius: 1 }}
              />
            ))}
          {customDef &&
            (showContent ? (
              <customDef.component widget={widget} dataSource={enrichedCustomSource} />
            ) : (
              <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 1 }} />
            ))}
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
                {effectiveSubtitle && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    sx={{ display: 'block' }}
                  >
                    {effectiveSubtitle}
                  </Typography>
                )}
              </Box>
              <IconButton
                size="small"
                onClick={() => setExpanded(false)}
                aria-label={localeText.widgetCardCloseExpandedAriaLabel}
                sx={{ flexShrink: 0 }}
              >
                <CloseIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent sx={{ p: 2, pt: 0 }}>
              <Box ref={chartExpandContainerRef}>
                <StudioChartWidget
                  widget={widget}
                  dataSource={source}
                  pageId={pageId}
                  height={500}
                />
              </Box>
            </DialogContent>
            <DialogActions sx={{ px: 2, pb: 1.5 }}>
              <Tooltip title={localeText.widgetExportPngTooltip}>
                <IconButton
                  size="small"
                  onClick={() => exportChartToPng(widget, chartExpandContainerRef.current)}
                  aria-label={localeText.widgetCardExportPngAriaLabel}
                >
                  <DownloadIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </DialogActions>
          </Dialog>
        )}
        {/* Widget edit dialog — only when no external onEditRequest handler */}
        {!onEditRequest && editDialogOpen && (
          <StudioWidgetEditDialog
            open={editDialogOpen}
            onClose={() => setEditDialogOpen(false)}
            widgetId={widgetId}
          >
            {widget.kind === 'grid' && (
              <StudioGridWidget widget={widget} dataSource={source} pageId={pageId} />
            )}
            {widget.kind === 'chart' && (
              <StudioChartWidget
                widget={widget}
                dataSource={source}
                pageId={pageId}
                height={CHART_MIN_HEIGHT}
              />
            )}
            {widget.kind === 'kpi' && (
              <StudioKpiWidget widget={widget} dataSource={source} pageId={pageId} />
            )}
            {widget.kind === 'text' && <StudioTextWidget widget={widget} />}
            {widget.kind === 'filter' && <StudioFilterWidget widget={widget} dataSource={source} />}
            {widget.kind === 'pivot' && (
              <StudioPivotWidget
                widget={widget}
                dataSource={source}
                pageId={pageId}
                exportRef={pivotExportRef}
              />
            )}
            {widget.kind === 'map' && (
              <Box sx={{ height: MAP_WIDGET_DEFAULT_HEIGHT }}>
                {source && <StudioMapWidget widget={widget} dataSource={source} pageId={pageId} />}
              </Box>
            )}
            {customDef && <customDef.component widget={widget} dataSource={enrichedCustomSource} />}
          </StudioWidgetEditDialog>
        )}
      </Paper>
    </Box>
  );
});
