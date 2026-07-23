'use client';
import * as React from 'react';
import {
  Box,
  Chip,
  CircularProgress,
  Paper,
  Skeleton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectMode,
  selectPages,
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
  selectCrossFilterAllPages,
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
import { StudioWidgetExpandDialog } from './StudioWidgetExpandDialog';
import { moveWidgetInLayout, type WidgetMoveDirection } from '../../internals/widgetLayoutMove';
import { resolveTextFontFamily } from '../../internals/textFontFamily';
import {
  sanitizeCssColor,
  sanitizeFontSize,
  sanitizeFiniteNumber,
} from '../../internals/cssValueValidation';
import { useStudioAnnounce } from '../../internals/StudioLiveRegion';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { useWidgetDefMap, BUILTIN_WIDGET_DEFS } from '../../internals/builtinWidgetDefs';
import { StudioWidgetEditDialog } from '../StudioWidgetEditDialog';
import { isWidgetOfKind } from '../../models';
import type { StudioPageTheme } from '../../models';
import type { StudioGridWidgetProps } from '../widgets/StudioGridWidget/StudioGridWidget';
import type { StudioChartWidgetProps } from '../widgets/StudioChartWidget';
import type { StudioKpiWidgetProps } from '../widgets/StudioKpiWidget/StudioKpiWidget';
import type { StudioTextWidgetProps } from '../widgets/StudioTextWidget/StudioTextWidget';
import type { StudioFilterWidgetProps } from '../widgets/StudioFilterWidget';
import { inferKpiDateSubtitle } from '../../internals/widgetUtils';
import { canDetectAnomalies } from '../../internals/anomalyDetection';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { formatCrossFilterValueLabel } from '../../internals/crossFilterValueLabel';
import { resolveFieldDef } from '../widgets/StudioChartWidget/chartWidgetHelpers';
import { useWidgetKindLabels } from '../StudioComposeDrawer/StudioComposeDrawerLabels';
import { runWidgetExport } from './widgetExport';
import { useStudioWidgetInsights } from './useStudioWidgetInsights';
import { useStudioWidgetCardDrag } from './useStudioWidgetCardDrag';
import { SliderFilterPill } from './SliderFilterPill';

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

function DefaultLoadingOverlay() {
  const theme = useTheme();
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: alpha(theme.palette.background.paper, 0.6),
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
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
  const allDataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const localeText = useStudioLocaleText();
  const widgetKindLabels = useWidgetKindLabels();
  const widgetDefMap = useWidgetDefMap();
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
      return (
        inferKpiDateSubtitle(
          widget,
          allFilters,
          { activePageId: pageId, crossFilterAllPages },
          localeText,
        ) ??
        widget.subtitle ??
        ''
      );
    }
    return widget.subtitle ?? '';
  }, [widget, allFilters, pageId, crossFilterAllPages, localeText]);

  // Unified widget-kind definition — built-in or consumer-registered custom kind.
  const def = widget ? widgetDefMap.get(widget.kind) : undefined;
  // Only non-builtin (custom) kinds need L2 enrichment applied here; built-in widgets
  // enrich their own rows internally via `useWidgetRows`.
  const isCustomKind = widget != null && !(widget.kind in BUILTIN_WIDGET_DEFS);

  // Enrich the raw data source with expression-field values (L2 pipeline) for custom widgets.
  // Built-in widgets handle enrichment themselves via useWidgetRows; custom widgets receive
  // raw rows by default, but expression fields (e.g. computed columns) would not resolve.
  // We apply L2 enrichment here (no filter application) so `dataSource.rows` includes all
  // computed column values. The enriched result is stable — getCachedEnrichedRows caches by
  // reference, so repeated renders with the same inputs return the same array.
  const enrichedCustomSource = React.useMemo(() => {
    if (!isCustomKind || !source) {
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
  }, [isCustomKind, source, allDataSources, relationships, expressionFields]);

  // Full-bleed custom widgets render edge-to-edge: no title/subtitle header and no card padding.
  const isFullBleedCustom = def?.fullBleed === true;

  // AI insights are disabled for filter/text/kpi widgets; custom widgets opt in via `aiInsight: true`.
  // The `aiInsights` feature flag lets embedders hide per-widget AI actions independently of AI chat.
  const supportsInsight = features.aiInsights && widget != null && def?.aiInsight === true;

  // ── AI Insight routing + anomaly detection state ───────────────────────────
  const {
    handleInsightRequest,
    anomalyEnabled,
    anomalyAnnotations,
    setAnomalyAnnotations,
    handleAnomalyToggle,
    handleAnomalyExplain,
  } = useStudioWidgetInsights({ widget, widgetId, onInsightRequest });

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
  // Populated by pivot internally, or by a custom widget kind via its `exportRef` prop (see
  // `StudioCustomWidgetDef.export` / `StudioCustomWidgetProps.exportRef`) — either way, whichever
  // widget owns the current `def.component` is responsible for knowing how to export itself.
  const imperativeExportRef = React.useRef<(() => void) | null>(null);
  const textAiRefreshRef = React.useRef<(() => void) | null>(null);
  // Detect when filter recomputation is in-flight (deferred rendering).
  // Only relevant for chart/grid/pivot widgets that go through useWidgetRows, and only
  // for the sync in-memory pipeline. Adapter-backed widgets already signal their own
  // fetch via `isLoading` — this mirrors `useWidgetRows.ts`'s `isRecomputing`
  // (`!hasAdapter && deferredBasePartitioned !== basePartitioned`), which excludes them
  // for the same reason. Without the `hasAdapter` exclusion here, this independent
  // computation showed a loading overlay on top of a widget that was already showing
  // its own adapter-driven loading state.
  // Scoped to this widget's own page so inactive pages don't show spurious spinners.
  const partitioned = useStudioSelector(selectBasePartitioned);
  const deferredPartitioned = React.useDeferredValue(partitioned);
  const hasAdapter = Boolean(source?.adapter);
  const isRecomputing =
    !hasAdapter &&
    (widget?.kind === 'chart' || widget?.kind === 'grid' || widget?.kind === 'pivot') &&
    deferredPartitioned !== partitioned;

  const LoadingOverlay = slots?.loadingOverlay ?? DefaultLoadingOverlay;

  // Pointer drag-and-drop wiring lives in a focused hook; it owns the drag "side effects"
  // (body flag + source-card dimming) and clears them even on unmount / canDrag flip mid-drag.
  const isDragging = useStudioWidgetCardDrag({ ref, widgetId, pageId, canDrag: mode === 'edit' });

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
  // shells are visible immediately on initial load.
  //
  // NOTE: intentionally NOT using startTransition/useTransition here.
  // Wrapping setShowContent in a transition makes it low-priority and lets
  // continuous mouse events (mouseenter/mouseleave hover state) preempt it
  // indefinitely, causing a ~5-second visible delay after DnD drops.
  // The requestAnimationFrame delay alone is sufficient to avoid blocking the
  // first paint without causing hover-induced starvation.
  //
  // Each widget Box is keyed by its own `widgetId` (see StudioCanvas), so
  // ordinary layout edits (adding/moving/removing a sibling in the same row)
  // no longer remount this component — the defer below only ever runs once
  // per genuine mount of a given widget.
  const [showContent, setShowContent] = React.useState(false);

  React.useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setShowContent(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleExport = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!widget) {
        return;
      }
      // Per-kind export dispatch lives in `widgetExport.ts` (mirrors the `setupPanel`
      // pattern) so the card stays free of kind-specific export branches.
      runWidgetExport({
        widget,
        source,
        controller,
        pageId,
        isCustomKind,
        chartContainer: chartContainerRef.current,
        imperativeExport: imperativeExportRef.current,
        chartBackgroundColor: theme.palette.background.default,
        localeText,
      });
    },
    [
      widget,
      source,
      controller,
      pageId,
      theme.palette.background.default,
      isCustomKind,
      localeText,
    ],
  );

  if (!widget) {
    return null;
  }

  // In view mode, let the widget def opt into collapsing the entire card (custom widgets only).
  // Pass the enriched source so shouldHide can evaluate expression-field–driven conditions.
  if (mode === 'view' && def?.shouldHide?.({ widget, dataSource: enrichedCustomSource })) {
    return null;
  }

  const exportKind = def?.capabilities?.export;
  const canExport = features.export && exportKind != null;
  const isChart = widget.kind === 'chart';
  const canExpand = def?.capabilities?.expand === true;
  // Forecast is only rendered for line/area charts (see StudioChartWidget), so hide the
  // forecast insight action for every other widget kind / chart type.
  const supportsForecast =
    isWidgetOfKind(widget, 'chart') &&
    (widget.config.chartType === 'line' || widget.config.chartType === 'area');
  // "Active" (outline border + persistent toolbar) is an edit-mode concept only. In view
  // mode a widget is never activated, even if it carries a stale selection from edit mode.
  const isActive = isSelected && mode === 'edit';
  const showEditActions = !isDragging && mode === 'edit' && (isSelected || (!dimmed && hovered));
  // View-mode toolbar is only revealed while the widget is hovered ("covered"), never pinned.
  const showViewActions = mode === 'view' && hovered;
  const showViewExport = showViewActions && canExport;
  const showViewExpand = showViewActions && canExpand;
  const exportLabel =
    exportKind === 'png' ? localeText.widgetExportPngTooltip : localeText.widgetExportCsvTooltip;

  // Overhang: center the overlay on the top edge of the card. Constrained to sit
  // inside the card for top-row widgets (where there's no room above to overhang).
  const overlayTopSx = isFirstRow ? { top: 6 } : { top: 0, transform: 'translateY(-50%)' };
  const minHeight = def?.capabilities?.minHeight;

  // Extra props forwarded from `slotProps.<kind>` (currently only grid/chart/kpi/filter/text
  // accept them via the public `StudioWidgetCardProps.slotProps` API).
  const extraProps = (
    slotProps as Record<string, Record<string, unknown> | undefined> | undefined
  )?.[widget.kind];

  // `pageTheme` is doc-authored (`StudioPage.theme`), reachable via `loadSerializedState`/the
  // AI tool loop, so its color/size values are sanitized before reaching `sx` (finding 1) —
  // same treatment as the text widget's style fields in `internals/cssValueValidation.ts`.
  // Hoisted into plain-typed locals (rather than calling the generic sanitizers inline inside
  // the `sx={{ ... }}` object literal below) because a generic call sitting in a
  // contextually-typed position lets TS infer its type parameter from the surrounding CSS
  // property's (very wide, MUI `SystemStyleObject`) expected type instead of from the call's
  // own argument, which broke the `sx` prop's overload resolution entirely.
  const sanitizedCardBorderColor: string | undefined = sanitizeCssColor(
    pageTheme?.cardBorderColor,
    'divider',
  );
  const sanitizedCardBorderWidth: number = sanitizeFiniteNumber(pageTheme?.cardBorderWidth) ?? 1;
  const sanitizedCardRadius = sanitizeFiniteNumber(pageTheme?.cardRadius);
  const sanitizedCardBackground: string | undefined = sanitizeCssColor(pageTheme?.cardBackground);
  const sanitizedCardPadding: number = sanitizeFiniteNumber(pageTheme?.cardPadding) ?? 2;

  // Same hoisting rationale as the `pageTheme` sanitization above — computed here (rather
  // than inline inside the title `Typography`'s `sx={{ ... }}`) to keep every value the
  // `sx` object reads plainly typed as `string | undefined` / `number | undefined`.
  const sanitizedTitleFontSize: number | undefined = sanitizeFontSize(widget.config?.titleFontSize);
  const sanitizedTextTitleColor: string | undefined = isWidgetOfKind(widget, 'text')
    ? sanitizeCssColor(widget.config.textTitleColor)
    : undefined;
  const sanitizedTextTitleFontSize: number | undefined = isWidgetOfKind(widget, 'text')
    ? sanitizeFontSize(widget.config.textTitleFontSize)
    : undefined;

  return (
    <Box sx={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Paper
        ref={ref}
        variant="outlined"
        {...slotProps?.paper}
        onClick={() => {
          // View mode is read-only: clicking must not select/activate the widget.
          if (mode !== 'edit') {
            return;
          }
          controller.setSelectedWidget(widgetId);
          if (onUnconfiguredClick && def?.requiresDataSource !== false && !widget.sourceId) {
            onUnconfiguredClick(widgetId);
          }
        }}
        role="group"
        aria-current={isActive ? true : undefined}
        aria-label={localeText.filtersSectionWidgetTitle(widget.title ?? '')}
        data-widget-card
        data-widget-id={widgetId}
        tabIndex={0}
        onKeyDown={(event) => {
          if (mode !== 'edit') {
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            // Prevent Space from scrolling the page (and Enter from triggering any
            // default form submission) since both keys already activate the card.
            event.preventDefault();
            controller.setSelectedWidget(widgetId);
            if (onUnconfiguredClick && def?.requiresDataSource !== false && !widget.sourceId) {
              onUnconfiguredClick(widgetId);
            }
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // `hovered` also gates the view-mode export/expand toolbar (`showViewActions`
        // below); without a focus-driven equivalent it was mouse-only, so a
        // keyboard-only user could never reveal those actions in view mode (edit mode
        // already has a keyboard path via card selection/`isSelected`). React's
        // `onFocus`/`onBlur` behave like native `focusin`/`focusout` (they bubble from
        // descendants), so this also fires when a toolbar button itself receives focus
        // via Tab, keeping the buttons visible while they're being tabbed through
        // (finding 2.14).
        onFocus={() => setHovered(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setHovered(false);
          }
        }}
        sx={{
          // `pageTheme` colors/sizes are doc-authored (`StudioPage.theme`) and reachable
          // via `loadSerializedState`/the AI tool loop, so they're sanitized the same way
          // as the text widget's style fields before reaching `sx` (finding 1).
          borderColor: sanitizedCardBorderColor ?? 'divider',
          borderWidth: sanitizedCardBorderWidth,
          border: pageTheme?.cardBorder === false && !isActive ? 'none' : undefined,
          borderRadius: sanitizedCardRadius !== undefined ? `${sanitizedCardRadius}px` : undefined,
          backgroundColor: sanitizedCardBackground,
          cursor: isDragging ? 'move' : 'default',
          p: isFullBleedCustom ? 0 : sanitizedCardPadding,
          boxSizing: 'border-box',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          minHeight,
          outline: isActive ? '2px solid' : undefined,
          outlineColor: isActive ? 'primary.main' : undefined,
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
          canExpand={canExpand}
          exportLabel={exportLabel}
          showEditActions={showEditActions}
          showViewActions={showViewActions}
          showViewExport={showViewExport}
          showViewExpand={showViewExpand}
          overlayTopSx={overlayTopSx}
          moveToPageOptions={moveToPageOptions}
          onAiRequest={onAiRequest ? () => onAiRequest(widgetId) : undefined}
          onAiRefresh={
            isWidgetOfKind(widget, 'text') &&
            widget.config.textAiEnabled &&
            (mode === 'edit' || hovered)
              ? () => textAiRefreshRef.current?.()
              : undefined
          }
          onInsightRequest={supportsInsight && onInsightRequest ? handleInsightRequest : undefined}
          supportsForecast={supportsForecast}
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
                    ...(sanitizedTitleFontSize !== undefined && {
                      fontSize: sanitizedTitleFontSize,
                    }),
                    ...(isWidgetOfKind(widget, 'text') && {
                      flexGrow: 1,
                      // Sanitized before reaching `sx` — see `internals/cssValueValidation.ts`
                      // (finding 1): these are doc-authored config values reachable via
                      // `loadSerializedState`/the AI `update_widget` tool call, and Emotion
                      // does not escape interpolated `sx` property values.
                      ...(sanitizedTextTitleColor !== undefined && {
                        color: sanitizedTextTitleColor,
                      }),
                      ...(widget.config.textTitleFontFamily && {
                        fontFamily: resolveTextFontFamily(widget.config.textTitleFontFamily),
                      }),
                      ...(sanitizedTextTitleFontSize !== undefined && {
                        fontSize: sanitizedTextTitleFontSize,
                      }),
                      ...(widget.config.textTitleFontWeight && {
                        fontWeight: widget.config.textTitleFontWeight,
                      }),
                      ...(widget.config.textTitleAlign && {
                        textAlign: widget.config.textTitleAlign,
                      }),
                    }),
                  }}
                >
                  {widget.title ||
                    widgetKindLabels[widget.kind] ||
                    widget.kind.charAt(0).toUpperCase() + widget.kind.slice(1)}
                </Typography>
                {activeRankFilter && (
                  <Chip
                    size="small"
                    label={`${activeRankFilter.rankDirection === 'bottom' ? localeText.filterRankBottom : localeText.filterRankTop} ${activeRankFilter.value}`}
                    color="primary"
                    variant="outlined"
                    sx={{ flexShrink: 0, height: 20, fontSize: 11 }}
                  />
                )}
                {activeCrossFilter && (
                  <Chip
                    size="small"
                    label={`${
                      // Check the source's physical fields first, then expression
                      // (computed) fields, mirroring `resolveFieldDef`'s use elsewhere
                      // for field-label lookups — a cross-filter on a calculated field
                      // previously fell straight through to the raw field id since only
                      // `source.fields` was checked (finding 3.11).
                      resolveFieldDef(activeCrossFilter.field, source, expressionFields)?.label ??
                      activeCrossFilter.field
                    }: ${formatCrossFilterValueLabel(activeCrossFilter.value)}`}
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
            shift when real content arrives (avoids CLS). Dispatch to the widget's
            render component is a single lookup into the unified widget-kind registry
            (built-in and custom kinds are otherwise indistinguishable here). */}
          {def &&
            (showContent ? (
              <Box sx={{ position: 'relative', ...(def.capabilities.contentSx ?? {}) }}>
                <def.component
                  widget={widget}
                  dataSource={isCustomKind ? enrichedCustomSource : source}
                  pageId={pageId}
                  anomalyEnabled={anomalyEnabled}
                  onAnomalyDetected={setAnomalyAnnotations}
                  chartContainerRef={chartContainerRef}
                  aiRefreshRef={textAiRefreshRef}
                  exportRef={imperativeExportRef}
                  extraProps={extraProps}
                />
                {isRecomputing && <LoadingOverlay />}
              </Box>
            ) : (
              <Skeleton
                variant="rectangular"
                height={def.capabilities.skeletonHeight?.(widget) ?? 120}
                sx={{ borderRadius: 1 }}
              />
            ))}
        </Stack>
        {/* Chart full-screen overlay dialog */}
        {canExpand && expanded && def && (
          <StudioWidgetExpandDialog
            open={expanded}
            onClose={() => setExpanded(false)}
            widget={widget}
            def={def}
            dataSource={source}
            pageId={pageId}
            effectiveSubtitle={effectiveSubtitle}
          />
        )}
        {/* Widget edit dialog — only when no external onEditRequest handler. Uses the dialog's
            default `BuiltinWidgetPreview`, which resolves through the same unified widget-kind
            registry, so built-in and custom widgets are both previewed correctly. */}
        {!onEditRequest && editDialogOpen && (
          <StudioWidgetEditDialog
            open={editDialogOpen}
            onClose={() => setEditDialogOpen(false)}
            widgetId={widgetId}
          />
        )}
      </Paper>
    </Box>
  );
});
