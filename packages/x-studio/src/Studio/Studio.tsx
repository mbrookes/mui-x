'use client';

import * as React from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import FilterListIcon from '@mui/icons-material/FilterList';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';

import {
  StudioProvider,
  CanvasScrollContext,
  useStudioController,
  useStudioSelector,
  useStudioFeatures,
  useStudioLocaleText,
  selectMode,
  selectShell,
  selectWidgets,
  selectDataSources,
} from '../context';
import type { StudioDataSourceAdapter, StudioFeatureFlags, StudioMode, StudioState } from '../models';
import type { StudioLocaleText } from '../internals/StudioUIConfigContext';
import { StudioController } from '../store';
import type { SerializedStudioState, MigrationResult } from '../store/statePersistence';
import { DrawerPanel } from './DrawerPanel';
import { TabbedSidebar } from './TabbedSidebar';
import { useStudioKeyboardShortcuts } from '../internals/useStudioKeyboardShortcuts';
import { StudioCanvas } from '../StudioCanvas';
import { StudioDataDrawer } from '../StudioDataDrawer';
import { StudioComposeDrawer } from '../StudioComposeDrawer';
import { StudioFiltersDrawer } from '../StudioFiltersDrawer';
// StudioDrilldownDrawer is kept as an exported composable component but no longer mounted by default.
import type { StudioChatPanelProps } from '../StudioChatPanel/StudioChatPanel';
import type { StudioAIConfig } from '../StudioChatPanel/studioAdapter';
import type { StudioCanvasProps } from '../StudioCanvas/StudioCanvas';

// Lazy-load the chat panel so @base-ui/react/menu (and the full @mui/x-chat
// bundle) are not downloaded until the user opens the AI panel for the first time.
const StudioChatPanel = React.lazy(
  () =>
    import('../StudioChatPanel/StudioChatPanel').then((m) => ({
      default: m.StudioChatPanel,
    })),
);

const MIN_CANVAS_WIDTH = 480;

// ── Public imperative handle ──────────────────────────────────────────────────

/**
 * Imperative handle exposed via `ref` on the `Studio` component.
 * Obtain it with `React.useRef<StudioHandle>()`.
 */
export interface StudioHandle {
  /** Undo the last action. */
  undo(): void;
  /** Redo the last undone action. */
  redo(): void;
  /** Returns true if there is an action to undo. */
  canUndo(): boolean;
  /** Returns true if there is an action to redo. */
  canRedo(): boolean;
  /** Switch between `'edit'` and `'view'` mode. */
  setMode(mode: StudioMode): void;
  /** Set the active page by id. */
  setActivePage(pageId: string): void;
  /** Return a snapshot of the current studio state. */
  getState(): StudioState;
  /** Serialise the current state to a plain JSON-safe object. */
  serializeState(): SerializedStudioState;
  /**
   * Load a previously serialised state, applying schema migrations as needed.
   * @returns A `MigrationResult` describing success or validation errors.
   */
  loadSerializedState(data: unknown): MigrationResult;
  /**
   * Attach (or remove) an async data source adapter for the given source.
   * When an adapter is provided, Studio calls `adapter.getRows(descriptor)` on every
   * descriptor change instead of using the in-memory rows pipeline.
   *
   * @param sourceId - The ID of the data source to configure.
   * @param adapter - The adapter implementation, or `undefined` to remove it.
   */
  setDataSourceAdapter(sourceId: string, adapter: StudioDataSourceAdapter | undefined): void;
}

// ── Slots / Props ─────────────────────────────────────────────────────────────

/* eslint-disable react/no-unused-prop-types */
// False positives: ESLint can't trace slot props through `...slots` spread into
// `StudioContent` or `initialState`/`onStateChange` through `memo + forwardRef`.
export interface StudioSlots {
  dataDrawer?: React.ReactNode;
  composeDrawer?: React.ReactNode;
  filtersDrawer?: React.ReactNode;
  canvas?: React.ReactNode;
}

export interface StudioProps extends StudioSlots {
  /**
   * Initial state used to seed the studio at mount.
   * Treated like `defaultValue` — changes after mount are ignored.
   * To replace state programmatically, call `ref.loadSerializedState()`.
   */
  initialState?: Partial<StudioState>;
  /**
   * Called on every state change. Use this to sync derived values
   * (mode, title, pages) into your own React state for toolbar rendering.
   * `canUndo` / `canRedo` are not part of `StudioState`; read them from the ref:
   * ```ts
   * onStateChange={(state) => {
   *   setMode(state.mode);
   *   setCanUndo(ref.current?.canUndo() ?? false);
   * }}
   * ```
   * @param {StudioState} state - The new Studio state snapshot.
   */
  onStateChange?: (state: StudioState) => void;
  /**
   * Sidebar layout variant.
   * - `'stacked'` (default): each panel has its own independent collapse strip.
   * - `'tabbed'`: a single tab rail shows all panels; at most one panel is open at a time.
   */
  sidebarLayout?: 'stacked' | 'tabbed';
  /**
   * Side of the canvas the sidebar panels are anchored to.
   * - `'left'` (default): sidebar is on the left.
   * - `'right'`: sidebar is on the right.
   */
  sidebarSide?: 'left' | 'right';
  /**
   * LLM configuration for the AI chat assistant.
   * When provided, a floating AI button appears in the bottom-right corner
   * that opens the `StudioChatPanel` as a slide-in overlay.
   * If not provided, the AI panel is not rendered.
   */
  aiConfig?: StudioAIConfig | null;
  /**
   * Controls how the table widget's data source is determined.
   * - `'explicit'` (default): a data source picker is shown at the top of the
   *   table setup panel. The user must choose a source before adding columns.
   * - `'implicit'`: no source picker is shown. The source is inferred from the
   *   first column added (Tableau / Power BI style). Removing all columns
   *   resets the source so a different one can be chosen.
   */
  tableSourceMode?: 'explicit' | 'implicit';
  /**
   * Runtime feature flags controlling which UI features are available to end users.
   * All flags default to `true` when not specified.
   * @example
   * ```tsx
   * // Embed in view-only mode with no AI or edit UI:
   * <Studio featureFlags={{ compose: false, aiChat: false }} />
   * ```
   */
  featureFlags?: StudioFeatureFlags;
  /**
   * Locale text overrides. Pass a full translation object or a partial override
   * to customise individual strings.
   * @example
   * ```tsx
   * import { ptBRLocaleText } from '@mui/x-studio/locales/pt-BR';
   * <Studio localeText={ptBRLocaleText} />
   * ```
   */
  localeText?: Partial<StudioLocaleText>;
  /**
   * Canvas width (in px) below which all widgets stack to full width in view mode.
   * Individual pages can override this via `StudioPage.stackBreakpoint`.
   * Set to `0` to disable responsive stacking entirely.
   * @default 600
   */
  stackBreakpoint?: number;
  /** Props forwarded to slot sub-components. */
  slotProps?: {
    /**
     * Extra props forwarded to the internally-rendered `StudioChatPanel`.
     * `aiConfig`, `open`, `onClose`, and `overlay` are managed by `Studio` and cannot be overridden here.
     */
    chatPanel?: Omit<StudioChatPanelProps, 'aiConfig' | 'open' | 'onClose' | 'overlay'>;
    /**
     * Extra props forwarded to the internally-rendered `StudioCanvas`.
     * Only applies when no custom `canvas` slot is provided.
     * Use `slotProps.canvas.slotProps.widgetCard` to customise every widget card.
     */
    canvas?: StudioCanvasProps;
  };
}
/* eslint-enable react/no-unused-prop-types */

// ── Internal content (needs context) ─────────────────────────────────────────

// Memoized so it doesn't re-render when Studio re-renders for unrelated reasons.
const StudioContent = React.memo(function StudioContent(
  props: StudioSlots & {
    sidebarLayout?: 'stacked' | 'tabbed';
    sidebarSide?: 'left' | 'right';
    stackBreakpoint?: number;
    aiConfig?: StudioAIConfig | null;
    slotProps?: {
      chatPanel?: Omit<StudioChatPanelProps, 'aiConfig' | 'open' | 'onClose' | 'overlay'>;
      canvas?: StudioCanvasProps;
    };
  },
) {
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

  const composePanelTitle = selectedWidget?.title ?? selectedField?.label ?? localeText.composeDrawerTitle;
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  useStudioKeyboardShortcuts();

  const [chatOpen, setChatOpen] = React.useState(false);

  const showCompose = features.compose;
  const showFilters = features.filters;
  const showDataManagement = features.dataManagement;

  const sidebar =
    sidebarLayout === 'tabbed' ? (
      <TabbedSidebar
        side={sidebarSide}
        panels={[
          ...(mode === 'edit' && showCompose
            ? [
                ...(showDataManagement
                  ? [
                      {
                        drawer: 'data' as const,
                        label: localeText.dataDrawerTitle,
                        icon: <StorageIcon fontSize="small" />,
                        children: dataDrawer ?? <StudioDataDrawer />,
                      },
                    ]
                  : []),
                {
                  drawer: 'compose' as const,
                  label: localeText.composeDrawerTitle,
                  title: composePanelTitle,
                  icon: <TuneIcon fontSize="small" />,
                  onBack: composeOnBack,
                  children: composeDrawer ?? <StudioComposeDrawer />,
                },
              ]
            : []),
          ...(showFilters
            ? [
                {
                  drawer: 'filters' as const,
                  label: localeText.filtersDrawerTitle,
                  icon: <FilterListIcon fontSize="small" />,
                  children: filtersDrawer ?? <StudioFiltersDrawer />,
                },
              ]
            : []),
        ]}
      />
    ) : sidebarSide === 'right' ? (
      // Right side: render panels in reverse order so they read Data → Compose → Filters
      // from right to left (Data closest to the screen edge, Filters adjacent to the canvas).
      <React.Fragment>
        {showFilters && (
          <DrawerPanel side={sidebarSide} drawer="filters" title={localeText.filtersDrawerTitle} icon={<FilterListIcon fontSize="small" />}>
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
          <DrawerPanel side={sidebarSide} drawer="data" title={localeText.dataDrawerTitle} icon={<StorageIcon fontSize="small" />}>
            {dataDrawer ?? <StudioDataDrawer />}
          </DrawerPanel>
        )}
      </React.Fragment>
    ) : (
      <React.Fragment>
        {mode === 'edit' && showCompose && showDataManagement && (
          <DrawerPanel side={sidebarSide} drawer="data" title={localeText.dataDrawerTitle} icon={<StorageIcon fontSize="small" />}>
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
          <DrawerPanel side={sidebarSide} drawer="filters" title={localeText.filtersDrawerTitle} icon={<FilterListIcon fontSize="small" />}>
            {filtersDrawer ?? <StudioFiltersDrawer />}
          </DrawerPanel>
        )}
      </React.Fragment>
    );

  return (
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

          <Box
            ref={canvasScrollRef}
            sx={{
              flexGrow: 1,
              minWidth: 0,
              overflow: 'auto',
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
            }}
          >
            <Box sx={{ minWidth: MIN_CANVAS_WIDTH, minHeight: '100%' }}>
              {canvas ?? <StudioCanvas stackBreakpoint={stackBreakpoint} {...slotProps?.canvas} />}
            </Box>
          </Box>

          {sidebarSide === 'right' && sidebar}
        </CanvasScrollContext.Provider>
      </Box>

      {/* AI chat button + panel */}
      {features.aiChat && aiConfig?.endpoint && (
        <React.Fragment>
          <Tooltip title={chatOpen ? localeText.aiAssistantCloseTooltip : localeText.aiAssistantOpenTooltip} placement="left">
            <IconButton
              onClick={() => setChatOpen((prev) => !prev)}
              color={chatOpen ? 'primary' : 'default'}
              aria-label={chatOpen ? localeText.aiAssistantCloseTooltip : localeText.aiAssistantOpenTooltip}
              sx={{
                position: 'absolute',
                bottom: 20,
                right: 20,
                zIndex: (theme) => theme.zIndex.speedDial,
                bgcolor: 'background.paper',
                boxShadow: 4,
                '&:hover': { bgcolor: 'action.hover' },
                width: 48,
                height: 48,
              }}
            >
              <AutoAwesomeIcon />
            </IconButton>
          </Tooltip>
          <React.Suspense fallback={null}>
            <StudioChatPanel {...slotProps?.chatPanel} aiConfig={aiConfig} open={chatOpen} onClose={() => setChatOpen(false)} overlay />
          </React.Suspense>
        </React.Fragment>
      )}
    </Box>
  );
});

// ── Public component ──────────────────────────────────────────────────────────

/**
 * The Studio dashboard builder component.
 *
 * @example
 * ```tsx
 * const studioRef = React.useRef<StudioHandle>(null);
 *
 * <Studio
 *   ref={studioRef}
 *   initialState={INITIAL_STATE}
 *   onStateChange={(state) => {
 *     setMode(state.mode);
 *     setCanUndo(studioRef.current?.canUndo() ?? false);
 *   }}
 * />
 * ```
 */
export const Studio = React.memo(
  // react-doctor-disable-next-line react-doctor/no-react19-deprecated-apis
  React.forwardRef<StudioHandle, StudioProps>(function Studio(props, ref) {
    const { initialState, onStateChange, tableSourceMode, featureFlags, localeText, ...slots } = props;
    const aiConfig = (slots as { aiConfig?: StudioAIConfig | null }).aiConfig;

    // Controller is created once at mount and never replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const controller = React.useMemo(() => new StudioController(initialState), []);

    // Wire onStateChange — re-subscribe whenever the callback identity changes.
    const onStateChangeRef = React.useRef(onStateChange);
    React.useLayoutEffect(() => {
      onStateChangeRef.current = onStateChange;
    });

    React.useEffect(() => {
      // Fire once on mount so consumers can seed their local state from the initial value.
      onStateChangeRef.current?.(controller.getState());
      return controller.subscribe((state) => {
        onStateChangeRef.current?.(state);
      });
    }, [controller]);

    // Expose imperative handle to the parent via ref.
    React.useImperativeHandle(
      ref,
      () => ({
        undo: () => controller.undo(),
        redo: () => controller.redo(),
        canUndo: () => controller.canUndo(),
        canRedo: () => controller.canRedo(),
        setMode: (mode) => controller.setMode(mode),
        setActivePage: (pageId) => controller.setActivePage(pageId),
        getState: () => controller.getState(),
        serializeState: () => controller.serializeState(),
        loadSerializedState: (data) => controller.loadSerializedState(data),
        setDataSourceAdapter: (sourceId, adapter) =>
          controller.setDataSourceAdapter(sourceId, adapter),
      }),
      [controller],
    );

    return (
      <StudioProvider
        controller={controller}
        tableSourceMode={tableSourceMode}
        featureFlags={featureFlags}
        localeText={localeText}
        aiConfig={aiConfig}
      >
        <StudioContent {...slots} />
      </StudioProvider>
    );
    // Note: sidebarSide is included in {...slots} via the StudioProps spread
  }),
);
