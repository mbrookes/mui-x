'use client';

import * as React from 'react';
import { Box, Fab, Tooltip } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import FilterListIcon from '@mui/icons-material/FilterList';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';

import {
  CanvasScrollContext,
  useStudioController,
  useStudioSelector,
  useStudioFeatures,
  useStudioLocaleText,
  selectMode,
  selectShell,
  selectWidgets,
  selectDataSources,
  selectFilters,
  selectAi,
  selectActivePageId,
} from '../../context';
import { useStudioKeyboardShortcuts } from '../../internals/useStudioKeyboardShortcuts';
import { StudioLiveRegionProvider } from '../../internals/StudioLiveRegion';
import { StudioDrawerErrorBoundary } from '../../internals/StudioDrawerErrorBoundary';
import { StudioWidgetErrorBoundary } from '../../internals/StudioWidgetErrorBoundary';
import { DrawerPanel } from './DrawerPanel';
import { TabbedSidebar } from './TabbedSidebar';
import { StudioCanvas } from '../StudioCanvas';
import { StudioDataDrawer } from '../StudioDataDrawer';
import { StudioComposeDrawer } from '../StudioComposeDrawer';
import { StudioFiltersDrawer } from '../StudioFiltersDrawer';
import { StudioCrossFilterBar } from '../StudioCanvas/StudioCrossFilterBar';
import { StudioQuickFilterBar } from '../StudioCanvas/StudioQuickFilterBar';
import type { StudioChatPanelProps } from '../StudioChatPanel/StudioChatPanel';
import type { StudioAIConfig } from '../StudioChatPanel/studioBackendAdapter';
import { nextAutoSubmitSeq } from '../StudioChatPanel/chatIds';
import type { StudioCanvasProps } from '../StudioCanvas/StudioCanvas';

// Lazy-load the chat panel so @base-ui/react/menu (and the full @mui/x-chat
// bundle) are not downloaded until the user opens the AI panel for the first time.
const StudioChatPanel = React.lazy(() =>
  import('../StudioChatPanel/StudioChatPanel').then((m) => ({
    default: m.StudioChatPanel,
  })),
);

const MIN_CANVAS_WIDTH = 480;

interface StudioContentProps {
  dataDrawer?: React.ReactNode;
  composeDrawer?: React.ReactNode;
  filtersDrawer?: React.ReactNode;
  canvas?: React.ReactNode;
  sidebarLayout?: 'stacked' | 'tabbed';
  sidebarSide?: 'left' | 'right';
  stackBreakpoint?: number;
  aiConfig?: StudioAIConfig | null;
  slotProps?: {
    chatPanel?: Omit<
      StudioChatPanelProps,
      'aiConfig' | 'open' | 'onClose' | 'overlay' | 'focusedWidgetId' | 'pendingMessage'
    >;
    canvas?: StudioCanvasProps;
  };
}

// Memoized so it doesn't re-render when Studio re-renders for unrelated reasons.
export const StudioContent = React.memo(function StudioContent(props: StudioContentProps) {
  const {
    canvas,
    composeDrawer,
    dataDrawer,
    filtersDrawer,
    sidebarLayout = 'stacked',
    sidebarSide = 'left',
    stackBreakpoint,
    aiConfig,
    slotProps,
  } = props;
  const mode = useStudioSelector(selectMode);
  const controller = useStudioController();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const canvasScrollRef = React.useRef<HTMLDivElement>(null);
  const filterBarRegionRef = React.useRef<HTMLDivElement>(null);
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();

  const filters = useStudioSelector(selectFilters);
  const activePageId = useStudioSelector(selectActivePageId);
  const hasCrossFilters = filters.some((f) => f.scope.kind === 'cross-filter' && !f.disabled);

  // Tier1 whole-dashboard-crash fix: the chat panel renders AI-authored tool-call content
  // (`chatToolRenderers.tsx`'s per-tool dispatch), so a render throw there needs a boundary
  // — otherwise it propagates all the way up and unmounts the entire `<Studio>` tree.
  // (An earlier version of this comment claimed every other dynamic-content surface in the
  // package already sat under a boundary. That was false for this very file: `<StudioCanvas>`
  // and both pinned filter bars below rendered bare. They are wrapped now, so the claim holds
  // — but it is asserted by the JSX down there, not by this comment.)
  // `resetKey` combines the active thread id with that thread's message count so switching
  // threads OR sending/receiving a new message in the current thread clears a latched error,
  // instead of leaving the panel stuck on the fallback until the page reloads.
  const aiState = useStudioSelector(selectAi);
  const activeChatThread = aiState?.threads.find((t) => t.id === aiState.activeThreadId);
  const chatPanelResetKey = `${aiState?.activeThreadId ?? 'none'}:${activeChatThread?.messages.length ?? 0}`;

  // The pinned filter bars sit above the scroll container, so mounting/unmounting them (the
  // first cross-filter, clearing all filters, chips wrapping to another line) shrinks or grows
  // the scroll viewport and shoves the whole report up or down — a jarring vertical jump. Watch
  // the bar region's height and offset the scroll position by the delta so the content the user
  // is looking at stays put. Clamped at 0 so the top of the report still tucks under the bars.
  React.useLayoutEffect(() => {
    const region = filterBarRegionRef.current;
    const scrollEl = canvasScrollRef.current;
    if (!region || !scrollEl || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    let prevHeight = region.offsetHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = region.offsetHeight;
      const delta = nextHeight - prevHeight;
      if (delta !== 0) {
        prevHeight = nextHeight;
        scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta);
      }
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  const shell = useStudioSelector(selectShell);
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const selectedWidgetId = shell.selectedWidgetId;
  const selectedFieldId = shell.selectedFieldId;
  const selectedSourceId = shell.selectedSourceId;
  // `selectedWidgetId` is session state, but guard the record index against inherited keys
  // ("toString"/"constructor"/…) anyway, matching the guarded lookups in `StudioCanvas` and
  // `selectors.ts`: a bare bracket lookup resolves a function off `Object.prototype` instead
  // of "not found", and that truthy non-widget object then flows into `selectedWidget.title`
  // and `hasSelection` (prototype-chain key lookup fix).
  const selectedWidget =
    selectedWidgetId && Object.hasOwn(widgets, selectedWidgetId)
      ? (widgets[selectedWidgetId] ?? null)
      : null;
  const selectedField = React.useMemo(() => {
    if (!selectedSourceId || !selectedFieldId) {
      return null;
    }
    // `selectedSourceId` can originate from doc/host/AI-authored ids, so guard the record index
    // against inherited keys ("toString"/"constructor"/…): a bare bracket lookup would resolve a
    // function off `Object.prototype` that slips past `?.fields` and throws (prototype-chain fix).
    const selectedSource = Object.hasOwn(dataSources, selectedSourceId)
      ? dataSources[selectedSourceId]
      : undefined;
    return selectedSource?.fields.find((f) => f.id === selectedFieldId) ?? null;
  }, [dataSources, selectedSourceId, selectedFieldId]);

  const composePanelTitle =
    selectedWidget?.title ?? selectedField?.label ?? localeText.composeDrawerTitle;
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  // Scope the undo/redo keyboard shortcuts to THIS instance's root DOM node (1.3), so two
  // Studio instances mounted on the same page don't both react to a single Ctrl+Z.
  useStudioKeyboardShortcuts(rootRef);

  const [chatOpen, setChatOpen] = React.useState(false);
  const [pendingInsight, setPendingInsight] = React.useState<{
    text: string;
    id: number;
  } | null>(null);
  const [insightFocusedWidgetId, setInsightFocusedWidgetId] = React.useState<string | undefined>(
    undefined,
  );

  const handleWidgetInsightRequest = React.useCallback((widgetId: string, prompt: string) => {
    setChatOpen(true);
    setInsightFocusedWidgetId(widgetId);
    // Drawn from the same module-level monotonic counter `StudioChatPanel` uses for its
    // `initialPrompt` auto-submit `seq` — a plain `Date.now()` here previously could
    // collide (same millisecond) with that other auto-submit path's seq, causing the
    // auto-submit queue's dedup to silently drop one of the two entries (finding 13).
    setPendingInsight({ text: prompt, id: nextAutoSubmitSeq() });
  }, []);

  // Closing the panel ends the widget-scoped conversation it was opened for.
  //
  // `insightFocusedWidgetId` reaches the middleware's system prompt as `The user is asking
  // about widget "…"`, so leaving it set after the panel closes silently re-scopes every
  // LATER message — reopening from the FAB and asking for something unrelated still steered
  // the model at whichever widget's "Analysis" button was pressed hours earlier. The queued
  // insight prompt is dropped with it: if the panel closed before the auto-submit queue
  // consumed it, the user has already walked away from that request.
  const closeChat = React.useCallback(() => {
    setChatOpen(false);
    setInsightFocusedWidgetId(undefined);
    setPendingInsight(null);
  }, []);

  // The focus is a page-local concept — the widget it names is not visible after a page
  // switch, so it must not keep scoping the conversation. Compared against the previous
  // value rather than run on `[activePageId]` alone so the initial mount doesn't clear a
  // focus set in the same commit.
  const prevActivePageIdRef = React.useRef(activePageId);
  React.useEffect(() => {
    const prevPageId = prevActivePageIdRef.current;
    prevActivePageIdRef.current = activePageId;
    if (prevPageId !== activePageId) {
      setInsightFocusedWidgetId(undefined);
    }
  }, [activePageId]);

  // A focused widget that has since been deleted would send a dead id to the backend, which
  // resolves to nothing and leaves the prompt referencing a widget that no longer exists.
  React.useEffect(() => {
    if (insightFocusedWidgetId && !Object.hasOwn(widgets, insightFocusedWidgetId)) {
      setInsightFocusedWidgetId(undefined);
    }
  }, [widgets, insightFocusedWidgetId]);

  const showCompose = features.compose;
  const showFilters = features.filters;
  const showDataManagement = features.dataManagement;

  // Auto-switch to the compose panel when a new widget is selected in edit mode.
  // Tracks the previous selection so only *new* selections trigger the switch.
  const prevSelectedWidgetIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prevId = prevSelectedWidgetIdRef.current;
    prevSelectedWidgetIdRef.current = selectedWidgetId ?? null;
    if (!selectedWidgetId || selectedWidgetId === prevId || mode !== 'edit' || !showCompose) {
      return;
    }
    controller.setDrawerOpen('compose', true);
    if (sidebarLayout === 'tabbed') {
      controller.setDrawerOpen('data', false);
      controller.setDrawerOpen('filters', false);
    }
  }, [selectedWidgetId, mode, showCompose, controller, sidebarLayout]);

  let sidebar: React.ReactNode;
  if (sidebarLayout === 'tabbed') {
    const panels = [];
    if (mode === 'edit' && showCompose) {
      if (showDataManagement) {
        panels.push({
          drawer: 'data' as const,
          label: localeText.dataDrawerTitle,
          icon: <StorageIcon fontSize="small" />,
          children: dataDrawer ?? <StudioDataDrawer />,
        });
      }
      panels.push({
        drawer: 'compose' as const,
        label: localeText.composeDrawerTitle,
        title: composePanelTitle,
        icon: <TuneIcon fontSize="small" />,
        onBack: composeOnBack,
        children: composeDrawer ?? <StudioComposeDrawer />,
      });
    }
    if (showFilters) {
      panels.push({
        drawer: 'filters' as const,
        label: localeText.filtersDrawerTitle,
        icon: <FilterListIcon fontSize="small" />,
        children: filtersDrawer ?? <StudioFiltersDrawer />,
      });
    }
    sidebar = <TabbedSidebar side={sidebarSide} panels={panels} />;
  } else if (sidebarSide === 'right') {
    // Right side: render panels in reverse order so they read Data → Compose → Filters
    // from right to left (Data closest to the screen edge, Filters adjacent to the canvas).
    sidebar = (
      <React.Fragment>
        {showFilters && (
          <DrawerPanel
            side={sidebarSide}
            drawer="filters"
            title={localeText.filtersDrawerTitle}
            icon={<FilterListIcon fontSize="small" />}
          >
            {filtersDrawer ?? <StudioFiltersDrawer />}
          </DrawerPanel>
        )}
        {mode === 'edit' && showCompose && (
          <DrawerPanel
            side={sidebarSide}
            drawer="compose"
            title={composePanelTitle}
            icon={<TuneIcon fontSize="small" />}
            onBack={composeOnBack}
          >
            {composeDrawer ?? <StudioComposeDrawer />}
          </DrawerPanel>
        )}
        {mode === 'edit' && showCompose && showDataManagement && (
          <DrawerPanel
            side={sidebarSide}
            drawer="data"
            title={localeText.dataDrawerTitle}
            icon={<StorageIcon fontSize="small" />}
          >
            {dataDrawer ?? <StudioDataDrawer />}
          </DrawerPanel>
        )}
      </React.Fragment>
    );
  } else {
    sidebar = (
      <React.Fragment>
        {mode === 'edit' && showCompose && showDataManagement && (
          <DrawerPanel
            side={sidebarSide}
            drawer="data"
            title={localeText.dataDrawerTitle}
            icon={<StorageIcon fontSize="small" />}
          >
            {dataDrawer ?? <StudioDataDrawer />}
          </DrawerPanel>
        )}
        {mode === 'edit' && showCompose && (
          <DrawerPanel
            side={sidebarSide}
            drawer="compose"
            title={composePanelTitle}
            icon={<TuneIcon fontSize="small" />}
            onBack={composeOnBack}
          >
            {composeDrawer ?? <StudioComposeDrawer />}
          </DrawerPanel>
        )}
        {showFilters && (
          <DrawerPanel
            side={sidebarSide}
            drawer="filters"
            title={localeText.filtersDrawerTitle}
            icon={<FilterListIcon fontSize="small" />}
          >
            {filtersDrawer ?? <StudioFiltersDrawer />}
          </DrawerPanel>
        )}
      </React.Fragment>
    );
  }

  return (
    <StudioLiveRegionProvider>
      <Box
        ref={rootRef}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          bgcolor: 'background.default',
          position: 'relative',
        }}
      >
        <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
          <CanvasScrollContext.Provider value={canvasScrollRef}>
            {sidebarSide === 'left' && sidebar}

            {/* Canvas column: pinned filter bars + scrollable canvas */}
            <Box
              sx={(theme) => ({
                display: 'flex',
                flexDirection: 'column',
                flexGrow: 1,
                minWidth: 0,
                overflow: 'hidden',
                bgcolor: 'grey.100',
                ...theme.applyStyles('dark', { bgcolor: 'grey.900' }),
              })}
            >
              {/* Pinned filter bars. Wrapped so their appear/disappear height change can be
                  measured and compensated on the scroll container (see the effect above),
                  keeping the report content visually anchored instead of jumping.

                  Both bars render doc-authored filter content (field labels, formatted filter
                  values, saved-view names) and both used to render bare — a render throw in
                  either escaped every boundary in the tree and unmounted the whole `<Studio>`.
                  One boundary each, so a broken cross-filter bar still leaves the quick filter
                  bar usable. `resetKeys` are identity-compared: editing filters or switching
                  pages clears a latched error, and the overlay's Retry covers the rest. */}
              <Box ref={filterBarRegionRef}>
                {/* Cross-filter mode toggle — visible on all pages while any cross-filter is active */}
                {mode !== 'edit' && features.crossFilterBar && hasCrossFilters && (
                  <StudioWidgetErrorBoundary resetKeys={[filters, activePageId]}>
                    <StudioCrossFilterBar />
                  </StudioWidgetErrorBoundary>
                )}

                {/* Active page-filter chips */}
                {mode !== 'edit' && (
                  <StudioWidgetErrorBoundary resetKeys={[filters, activePageId]}>
                    <StudioQuickFilterBar />
                  </StudioWidgetErrorBoundary>
                )}
              </Box>

              <Box
                ref={canvasScrollRef}
                component="main"
                aria-label={localeText.canvasRegionAriaLabel}
                sx={{
                  flexGrow: 1,
                  minWidth: 0,
                  overflow: 'auto',
                }}
              >
                {/* The 480px floor keeps multi-column rows legible on desktop, but would force
                    horizontal scrolling on phones — so drop it below the `sm` breakpoint. */}
                <Box sx={{ minWidth: { xs: 0, sm: MIN_CANVAS_WIDTH }, minHeight: '100%' }}>
                  {/* The canvas itself (row/column layout resolution, per-widget keying) sits
                      above every per-widget boundary, and a consumer-supplied `canvas` node is
                      arbitrary host code — neither had a boundary, so a throw there unmounted
                      the whole `<Studio>` including the sidebar and chat panel. `resetKeys` are
                      identity-compared, so any widget/filter mutation or a page switch clears a
                      latched error; the overlay's Retry button covers view-only dashboards
                      (`featureFlags.compose: false`) where none of those may ever change. */}
                  <StudioWidgetErrorBoundary resetKeys={[widgets, filters, activePageId, mode]}>
                    {canvas ?? (
                      <StudioCanvas
                        stackBreakpoint={stackBreakpoint}
                        {...slotProps?.canvas}
                        onBackgroundClick={() => {
                          closeChat();
                          slotProps?.canvas?.onBackgroundClick?.();
                        }}
                        slotProps={{
                          ...slotProps?.canvas?.slotProps,
                          widgetCard: {
                            ...slotProps?.canvas?.slotProps?.widgetCard,
                            onInsightRequest:
                              features.aiChat && aiConfig?.endpoint
                                ? handleWidgetInsightRequest
                                : undefined,
                          },
                        }}
                      />
                    )}
                  </StudioWidgetErrorBoundary>
                </Box>
              </Box>
            </Box>

            {sidebarSide === 'right' && sidebar}
          </CanvasScrollContext.Provider>
        </Box>

        {/* AI chat button + panel */}
        {features.aiChat && aiConfig?.endpoint && (
          <React.Fragment>
            <Tooltip
              title={
                chatOpen ? localeText.aiAssistantCloseTooltip : localeText.aiAssistantOpenTooltip
              }
              placement="left"
            >
              <Fab
                onClick={() => {
                  if (chatOpen) {
                    closeChat();
                  } else {
                    setChatOpen(true);
                  }
                }}
                color={chatOpen ? 'primary' : 'default'}
                aria-label={
                  chatOpen ? localeText.aiAssistantCloseTooltip : localeText.aiAssistantOpenTooltip
                }
                size="medium"
                sx={{
                  position: 'absolute',
                  bottom: 20,
                  right: 20,
                  zIndex: (theme) => theme.zIndex.drawer + 2,
                }}
              >
                <AutoAwesomeIcon />
              </Fab>
            </Tooltip>
            <React.Suspense fallback={null}>
              <StudioDrawerErrorBoundary resetKey={chatPanelResetKey}>
                <StudioChatPanel
                  {...slotProps?.chatPanel}
                  // `focusedWidgetId` and `pendingMessage` are Studio-internally managed (the
                  // widget-insight focus + queued insight prompt), so they sit AFTER the spread —
                  // matching aiConfig/open/onClose/overlay — and are excluded from the consumer's
                  // `slotProps.chatPanel` type via the Omit above. Previously `focusedWidgetId` sat
                  // BEFORE the spread, letting a consumer silently override "Explain this widget",
                  // while `pendingMessage` sat after but was still spreadable in the type (T3).
                  focusedWidgetId={insightFocusedWidgetId}
                  aiConfig={aiConfig}
                  open={chatOpen}
                  onClose={closeChat}
                  overlay
                  pendingMessage={pendingInsight ?? undefined}
                />
              </StudioDrawerErrorBoundary>
            </React.Suspense>
          </React.Fragment>
        )}
      </Box>
    </StudioLiveRegionProvider>
  );
});
