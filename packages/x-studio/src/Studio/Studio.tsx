'use client';

import * as React from 'react';
import { Box } from '@mui/material';
import FilterListIcon from '@mui/icons-material/FilterList';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';

import {
  StudioProvider,
  CanvasScrollContext,
  useStudioController,
  useStudioSelector,
  selectMode,
  selectShell,
  selectWidgets,
  selectDataSources,
} from '../context';
import type { StudioDataSourceAdapter, StudioMode, StudioState } from '../models';
import { StudioController } from '../store';
import type { SerializedStudioState, MigrationResult } from '../store/statePersistence';
import { DrawerPanel } from '../internals/DrawerPanel';
import { useStudioKeyboardShortcuts } from '../internals/useStudioKeyboardShortcuts';
import { StudioCanvas } from '../StudioCanvas';
import { StudioDataDrawer } from '../StudioDataDrawer';
import { StudioComposeDrawer } from '../StudioComposeDrawer';
import { StudioFiltersDrawer } from '../StudioFiltersDrawer';

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
}
/* eslint-enable react/no-unused-prop-types */

// ── Internal content (needs context) ─────────────────────────────────────────

// Memoized so it doesn't re-render when Studio re-renders for unrelated reasons.
const StudioContent = React.memo(function StudioContent(props: StudioSlots) {
  const { canvas, composeDrawer, dataDrawer, filtersDrawer } = props;
  const mode = useStudioSelector(selectMode);
  const controller = useStudioController();
  const canvasScrollRef = React.useRef<HTMLDivElement>(null);

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

  const composeTitle = selectedWidget?.title ?? selectedField?.label ?? 'Compose';
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  useStudioKeyboardShortcuts();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        <CanvasScrollContext.Provider value={canvasScrollRef}>
          {mode === 'edit' && (
            <DrawerPanel drawer="data" title="Data" icon={<StorageIcon fontSize="small" />}>
              {dataDrawer ?? <StudioDataDrawer />}
            </DrawerPanel>
          )}
          {mode === 'edit' && (
            <DrawerPanel
              drawer="compose"
              title={composeTitle}
              icon={<TuneIcon fontSize="small" />}
              onBack={composeOnBack}
            >
              {composeDrawer ?? <StudioComposeDrawer />}
            </DrawerPanel>
          )}
          <DrawerPanel drawer="filters" title="Filters" icon={<FilterListIcon fontSize="small" />}>
            {filtersDrawer ?? <StudioFiltersDrawer />}
          </DrawerPanel>

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
              {canvas ?? <StudioCanvas />}
            </Box>
          </Box>
        </CanvasScrollContext.Provider>
      </Box>
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
    const { initialState, onStateChange, ...slots } = props;

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
      <StudioProvider controller={controller}>
        <StudioContent {...slots} />
      </StudioProvider>
    );
  }),
);
