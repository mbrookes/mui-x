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
  useStudioUIConfig,
  selectMode,
  selectPages,
  selectActivePageId,
  selectFilters,
  selectPartitionedBaseFilters,
  makeSelectWidget,
  makeSelectIsWidgetSelected,
  makeSelectIsWidgetDimmed,
  makeSelectWidgetSource,
  makeSelectWidgetRankFilter,
  makeSelectWidgetSliderFilter,
  makeSelectWidgetActiveCrossFilter,
} from '../../context';
import { StudioWidgetCardActionsOverlay } from './StudioWidgetCardActionsOverlay';
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
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { StudioInsightPanel } from '../StudioInsightPanel/StudioInsightPanel';
import {
  generateWidgetInsight,
  type StudioInsightOptions,
  type StudioInsightResult,
} from '../StudioChatPanel/generateInsight';
import { SliderFilterPill } from './SliderFilterPill';
import {
  DRAG_TYPE_CANVAS_WIDGET,
  type CanvasWidgetDragItem,
} from '../StudioCanvas/studioWidgetDndTypes';
import { useStudioDraggable } from '../StudioCanvas/useStudioDraggable';
import { createClonePreview } from '../StudioCanvas/createClonePreview';

export interface StudioWidgetCardProps {
  widgetId: string;
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
    isFirstRow = false,
    pageTheme,
    slots,
    slotProps,
    onUnconfiguredClick,
    onEditRequest,
    onAiRequest,
  } = props;
  const controller = useStudioController();
  // Create stable selector functions scoped to this widgetId.
  // Using React.useMemo ensures the selector identity is preserved across renders
  // so React 19's useSyncExternalStore doesn't recreate getSelection each render.
  const selectWidgetFn = React.useMemo(() => makeSelectWidget(widgetId), [widgetId]);
  const selectIsSelectedFn = React.useMemo(() => makeSelectIsWidgetSelected(widgetId), [widgetId]);
  const selectIsDimmedFn = React.useMemo(() => makeSelectIsWidgetDimmed(widgetId), [widgetId]);
  const selectSourceFn = React.useMemo(() => makeSelectWidgetSource(widgetId), [widgetId]);
  const selectRankFilterFn = React.useMemo(() => makeSelectWidgetRankFilter(widgetId), [widgetId]);
  const selectSliderFilterFn = React.useMemo(
    () => makeSelectWidgetSliderFilter(widgetId),
    [widgetId],
  );
  const selectCrossFilterFn = React.useMemo(
    () => makeSelectWidgetActiveCrossFilter(widgetId),
    [widgetId],
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
  const activePageId = useStudioSelector(selectActivePageId);
  const allFilters = useStudioSelector(selectFilters);
  const localeText = useStudioLocaleText();
  const customWidgetMap = useCustomWidgetMap();
  const { aiConfig } = useStudioUIConfig();

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

  // Full-bleed custom widgets render edge-to-edge: no title/subtitle header and no card padding.
  const isFullBleedCustom = customDef?.fullBleed === true;

  // AI insights are disabled for filter/text/kpi widgets; custom widgets opt in via `aiInsight: true`
  const supportsInsight =
    widget != null &&
    widget.kind !== 'filter' &&
    widget.kind !== 'text' &&
    widget.kind !== 'kpi' &&
    (customDef === null || customDef.aiInsight === true);

  // ── AI Insight state ───────────────────────────────────────────────────────
  const [insightOpen, setInsightOpen] = React.useState(false);
  const [insightLoading, setInsightLoading] = React.useState(false);
  const [insightError, setInsightError] = React.useState<string | null>(null);
  const [insightResult, setInsightResult] = React.useState<StudioInsightResult | null>(null);
  const [insightType, setInsightType] = React.useState<StudioInsightOptions['type']>('summary');
  const insightAbortRef = React.useRef<AbortController | null>(null);

  const handleInsightRequest = React.useCallback(
    (type: StudioInsightOptions['type']) => {
      if (!aiConfig?.endpoint) {
        return;
      }
      insightAbortRef.current?.abort();
      const controller2 = new AbortController();
      insightAbortRef.current = controller2;

      setInsightType(type);
      setInsightOpen(true);
      setInsightLoading(true);
      setInsightError(null);
      setInsightResult(null);

      generateWidgetInsight(widgetId, controller, aiConfig, { type, signal: controller2.signal })
        .then((result) => {
          setInsightResult(result);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') {
            return;
          }
          setInsightError(err instanceof Error ? err.message : 'Failed to generate insight.');
        })
        .finally(() => {
          setInsightLoading(false);
        });
    },
    [widgetId, controller, aiConfig],
  );

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: abort on unmount only
  React.useEffect(() => {
    return () => {
      insightAbortRef.current?.abort();
    };
  }, []);

  // ── Anomaly detection state ────────────────────────────────────────────────
  const [anomalyEnabled, setAnomalyEnabled] = React.useState(false);
  const [anomalyAnnotations, setAnomalyAnnotations] = React.useState<
    import('../../models/baseTypes').StudioChartAnnotation[]
  >([]);
  const anomalyExplainAbortRef = React.useRef<AbortController | null>(null);

  // Toggle anomaly detection; clear annotations immediately when disabling
  const handleAnomalyToggle = React.useCallback(() => {
    setAnomalyEnabled((prev) => {
      if (prev) {
        setAnomalyAnnotations([]);
      }
      return !prev;
    });
  }, []);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: abort on unmount only
  React.useEffect(() => {
    return () => {
      anomalyExplainAbortRef.current?.abort();
    };
  }, []);

  const handleAnomalyExplain = React.useCallback(() => {
    if (!aiConfig?.endpoint || !anomalyAnnotations.length) {
      return;
    }
    import('../StudioChatPanel/generateInsight').then(({ generateAnomalyExplanation }) => {
      anomalyExplainAbortRef.current?.abort();
      const abortCtrl = new AbortController();
      anomalyExplainAbortRef.current = abortCtrl;
      handleInsightRequest('anomaly' as StudioInsightOptions['type']);
      generateAnomalyExplanation(widgetId, anomalyAnnotations, controller, aiConfig, {
        signal: abortCtrl.signal,
      })
        .then((result) => {
          setInsightResult(result);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') {
            return;
          }
          setInsightError(err instanceof Error ? err.message : 'Failed to explain anomalies.');
        })
        .finally(() => {
          setInsightLoading(false);
        });
    });
  }, [aiConfig, anomalyAnnotations, widgetId, controller, handleInsightRequest]);

  // Pages the user can move this widget to (all pages except the current one)
  const moveToPageOptions = React.useMemo(
    () =>
      Object.values(pages).flatMap((p) =>
        p.id !== activePageId ? [{ id: p.id, title: p.title }] : [],
      ),
    [pages, activePageId],
  );

  const ref = React.useRef<HTMLDivElement>(null);
  const chartContainerRef = React.useRef<HTMLDivElement>(null);
  const chartExpandContainerRef = React.useRef<HTMLDivElement>(null);

  // Detect when filter recomputation is in-flight (deferred rendering).
  // Only relevant for chart and grid widgets that go through useWidgetRows.
  const partitioned = useStudioSelector(selectPartitionedBaseFilters);
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
      sourcePageId: activePageId,
    }),
    [widgetId, activePageId],
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
        const currentActivePageId = state.dashboard.activePageId;
        const sourceRows = source?.rows ?? [];
        const rows =
          sourceRows.length > 0
            ? pipeline.resolveWidgetRows(
                widget.id,
                widget.sourceId,
                sourceRows,
                currentActivePageId,
              )
            : [];
        exportGridToCsv(widget, source, rows);
      } else if (widget.kind === 'chart') {
        exportChartToPng(widget, chartContainerRef.current, theme.palette.background.default);
      }
    },
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- deps are correct
    [widget, source, controller, theme.palette.background.default],
  );

  if (!widget) {
    return null;
  }

  // In view mode, let the custom widget def opt into collapsing the entire card.
  if (mode === 'view' && customDef?.shouldHide?.({ widget, dataSource: source ?? undefined })) {
    return null;
  }

  const canExport = widget.kind === 'grid' || widget.kind === 'chart';
  const isChart = widget.kind === 'chart';
  const showEditActions = mode === 'edit' && (isSelected || (!dimmed && hovered));
  const showViewExport = mode === 'view' && hovered && canExport;
  const showViewExpand = mode === 'view' && hovered && isChart;
  const exportLabel =
    widget.kind === 'grid' ? localeText.widgetExportCsvTooltip : localeText.widgetExportPngTooltip;

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
          onInsightRequest={
            aiConfig?.endpoint && supportsInsight ? handleInsightRequest : undefined
          }
          anomalyEnabled={anomalyEnabled}
          anomalyCount={anomalyAnnotations.length}
          onAnomalyToggle={isChart ? handleAnomalyToggle : undefined}
          onAnomalyExplain={
            isChart && aiConfig?.endpoint && anomalyEnabled && anomalyAnnotations.length > 0
              ? handleAnomalyExplain
              : undefined
          }
          onExport={handleExport}
          onExpand={() => setExpanded(true)}
          onEdit={handleEditClick}
          onDuplicate={() => controller.duplicateWidget(widgetId)}
          onDelete={() => controller.removeWidget(widgetId)}
          onMoveToPage={(pageId) => controller.moveWidgetToPage(widgetId, pageId)}
        />
        {/* AI Insight panel — floats over widget content when open */}
        {insightOpen && (
          <StudioInsightPanel
            insight={insightResult}
            loading={insightLoading}
            error={insightError}
            activeType={insightType}
            showForecast={isChart || widget.kind === 'kpi'}
            onClose={() => {
              setInsightOpen(false);
              insightAbortRef.current?.abort();
            }}
            onRegenerate={handleInsightRequest}
          />
        )}
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
                <StudioGridWidget widget={widget} dataSource={source} {...slotProps?.grid} />
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
                <StudioKpiWidget widget={widget} dataSource={source} {...slotProps?.kpi} />
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
              <StudioTextWidget widget={widget} {...slotProps?.text} />
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
                <StudioPivotWidget widget={widget} dataSource={source} />
                {isRecomputing && <LoadingOverlay />}
              </Box>
            ) : (
              <Skeleton variant="rectangular" height={300} sx={{ borderRadius: 1 }} />
            ))}
          {widget.kind === 'map' &&
            (showContent ? (
              <Box sx={{ position: 'relative', height: MAP_WIDGET_DEFAULT_HEIGHT }}>
                {source && <StudioMapWidget widget={widget} dataSource={source} />}
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
              <customDef.component widget={widget} dataSource={source ?? undefined} />
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
                <StudioChartWidget widget={widget} dataSource={source} height={500} />
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
            {widget.kind === 'grid' && <StudioGridWidget widget={widget} dataSource={source} />}
            {widget.kind === 'chart' && (
              <StudioChartWidget widget={widget} dataSource={source} height={CHART_MIN_HEIGHT} />
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
          </StudioWidgetEditDialog>
        )}
      </Paper>
    </Box>
  );
});
