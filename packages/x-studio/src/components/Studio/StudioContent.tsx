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
} from '../../context';
import { useStudioKeyboardShortcuts } from '../../internals/useStudioKeyboardShortcuts';
import { StudioLiveRegionProvider } from '../../internals/StudioLiveRegion';
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
    chatPanel?: Omit<StudioChatPanelProps, 'aiConfig' | 'open' | 'onClose' | 'overlay'>;
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
  const canvasScrollRef = React.useRef<HTMLDivElement>(null);
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();

  const filters = useStudioSelector(selectFilters);
  const hasCrossFilters = filters.some((f) => f.scope.kind === 'cross-filter' && !f.disabled);

  const shell = useStudioSelector(selectShell);
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const selectedWidgetId = shell.selectedWidgetId;
  const selectedFieldId = shell.selectedFieldId;
  const selectedSourceId = shell.selectedSourceId;
  const selectedWidget = selectedWidgetId ? (widgets[selectedWidgetId] ?? null) : null;
  const selectedField = React.useMemo(() => {
    if (!selectedSourceId || !selectedFieldId) {
      return null;
    }
    return dataSources[selectedSourceId]?.fields.find((f) => f.id === selectedFieldId) ?? null;
  }, [dataSources, selectedSourceId, selectedFieldId]);

  const composePanelTitle =
    selectedWidget?.title ?? selectedField?.label ?? localeText.composeDrawerTitle;
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  useStudioKeyboardShortcuts();

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
    setPendingInsight({ text: prompt, id: Date.now() });
  }, []);

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
              {/* Cross-filter mode toggle — visible on all pages while any cross-filter is active */}
              {mode !== 'edit' && features.crossFilterBar && hasCrossFilters && (
                <StudioCrossFilterBar />
              )}

              {/* Active page-filter chips */}
              {mode !== 'edit' && <StudioQuickFilterBar />}

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
                <Box sx={{ minWidth: MIN_CANVAS_WIDTH, minHeight: '100%' }}>
                  {canvas ?? (
                    <StudioCanvas
                      stackBreakpoint={stackBreakpoint}
                      {...slotProps?.canvas}
                      onBackgroundClick={() => setChatOpen(false)}
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
                onClick={() => setChatOpen((prev) => !prev)}
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
              <StudioChatPanel
                focusedWidgetId={insightFocusedWidgetId}
                {...slotProps?.chatPanel}
                aiConfig={aiConfig}
                open={chatOpen}
                onClose={() => setChatOpen(false)}
                overlay
                pendingMessage={pendingInsight ?? undefined}
              />
            </React.Suspense>
          </React.Fragment>
        )}
      </Box>
    </StudioLiveRegionProvider>
  );
});
