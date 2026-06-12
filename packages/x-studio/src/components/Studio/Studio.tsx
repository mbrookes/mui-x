'use client';

import * as React from 'react';
import { useThemeProps } from '@mui/material/styles';

import { StudioProvider } from '../../context';
import type {
  StudioDataSourceAdapter,
  StudioFeatureFlags,
  StudioMode,
  StudioState,
  StudioCustomWidgetDef,
} from '../../models';
import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioMapGeographyDefinition } from '../widgets/StudioMapWidget/geographyLoaders';
import { StudioController } from '../../store';
import type { SerializedStudioState, MigrationResult } from '../../store/statePersistence';
// StudioDrilldownDrawer is kept as an exported composable component but no longer mounted by default.
import type { StudioChatPanelProps } from '../StudioChatPanel/StudioChatPanel';
import type { StudioAIConfig } from '../StudioChatPanel/studioBackendAdapter';
import type { StudioCanvasProps } from '../StudioCanvas/StudioCanvas';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { StudioDragLayer } from '../StudioCanvas/StudioDragLayer';
import { StudioContent } from './StudioContent';

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
  /** Remove a page and its widgets from the dashboard. Supports undo. */
  removePage(pageId: string): void;
  /** Reorder pages according to the provided list of page IDs. Supports undo. */
  reorderPages(pageIds: string[]): void;
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
  /**
   * Consumer-defined custom widget kinds shown alongside built-in widgets in the widget picker.
   * Each entry registers a `kind` string, a render `component`, an optional compose-drawer
   * `setupPanel`, and optional metadata (label, icon, defaultConfig).
   * @see StudioCustomWidgetDef
   * @example
   * ```tsx
   * <Studio
   *   customWidgets={[{
   *     kind: 'alert-banner',
   *     label: 'Alert Banner',
   *     component: AlertBannerWidget,
   *     setupPanel: AlertBannerSetupPanel,
   *   }]}
   * />
   * ```
   */
  customWidgets?: StudioCustomWidgetDef[];
  /**
   * Additional map geography definitions to register alongside the built-in `'world'`,
   * `'usa'`, and `'europe'` geographies.
   *
   * Each entry defines how to load the topology, how to normalise raw data values to
   * feature IDs, and how the geography appears in the Map Setup panel (label, field label,
   * and help text).
   *
   * @example
   * ```tsx
   * import type { StudioMapGeographyDefinition } from '@mui/x-studio';
   * const geographies: Record<string, StudioMapGeographyDefinition> = {
   *   'uk-counties': {
   *     label: 'United Kingdom',
   *     fieldLabel: 'County field',
   *     fieldHint: 'A field containing UK county names.',
   *     loader: async () => {
   *       const topo = await import('./uk-counties.json');
   *       const { feature } = await import('topojson-client');
   *       return feature(topo, topo.objects.counties);
   *     },
   *     normalizer: (value) => String(value ?? '').trim().toLowerCase(),
   *   },
   * };
   * <Studio geographies={geographies} />
   * ```
   */
  geographies?: Record<string, StudioMapGeographyDefinition>;
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
  React.forwardRef<StudioHandle, StudioProps>(function Studio(inProps, ref) {
    const props = useThemeProps({ props: inProps, name: 'MuiStudio' });
    const { initialState, onStateChange, tableSourceMode, featureFlags, localeText, ...slots } =
      props;
    const aiConfig = (slots as { aiConfig?: StudioAIConfig | null }).aiConfig;
    const customWidgets = (slots as { customWidgets?: StudioCustomWidgetDef[] }).customWidgets;
    const geographies = (slots as { geographies?: Record<string, StudioMapGeographyDefinition> })
      .geographies;

    // Controller is created once at mount and never replaced.
    const controller = React.useMemo(
      () => new StudioController(initialState),
      // react-doctor-disable-next-line react-doctor/exhaustive-deps -- controller is intentionally created once
      [], // eslint-disable-line react-hooks/exhaustive-deps -- controller is intentionally created once from initialState
    );

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
        removePage: (pageId) => controller.removePage(pageId),
        reorderPages: (pageIds) => controller.reorderPages(pageIds),
        getState: () => controller.getState(),
        serializeState: () => controller.serializeState(),
        loadSerializedState: (data) => controller.loadSerializedState(data),
        setDataSourceAdapter: (sourceId, adapter) =>
          controller.setDataSourceAdapter(sourceId, adapter),
      }),
      [controller],
    );

    return (
      <DndProvider backend={HTML5Backend}>
        <StudioDragLayer />
        <StudioProvider
          controller={controller}
          tableSourceMode={tableSourceMode}
          featureFlags={featureFlags}
          localeText={localeText}
          aiConfig={aiConfig}
          customWidgets={customWidgets}
          geographies={geographies}
        >
          <StudioContent {...slots} />
        </StudioProvider>
      </DndProvider>
    );
    // Note: sidebarSide is included in {...slots} via the StudioProps spread
  }),
);
