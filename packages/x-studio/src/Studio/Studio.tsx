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
} from '../context';
import type { StudioMode, StudioState } from '../models';
import { StudioController } from '../store';
import type { SerializedStudioState, MigrationResult } from '../store/statePersistence';
import { DrawerPanel } from '../internals/DrawerPanel';
import { StudioCanvas } from '../StudioCanvas';
import { StudioDataDrawer } from '../StudioDataDrawer';
import { StudioComposeDrawer } from '../StudioComposeDrawer';
import { StudioFiltersDrawer } from '../StudioFiltersDrawer';

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
}

// ── Slots / Props ─────────────────────────────────────────────────────────────

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
   */
  onStateChange?: (state: StudioState) => void;
}

// ── Internal content (needs context) ─────────────────────────────────────────

// Memoized so it doesn't re-render when Studio re-renders for unrelated reasons.
const StudioContent = React.memo(function StudioContent(props: StudioSlots) {
  const { canvas, composeDrawer, dataDrawer, filtersDrawer } = props;
  const mode = useStudioSelector((state) => state.mode);
  const controller = useStudioController();
  const canvasScrollRef = React.useRef<HTMLDivElement>(null);

  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);
  const selectedSourceId = useStudioSelector((state) => state.shell.selectedSourceId);
  const selectedWidget = useStudioSelector((state) =>
    state.shell.selectedWidgetId ? state.widgets[state.shell.selectedWidgetId] : null,
  );
  const selectedField = useStudioSelector((state) => {
    const { selectedSourceId: srcId, selectedFieldId: fldId } = state.shell;
    if (!srcId || !fldId) {
      return null;
    }
    return state.dataSources[srcId]?.fields.find((f) => f.id === fldId) ?? null;
  });

  const composeTitle = selectedWidget?.title ?? selectedField?.label ?? 'Compose';
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  React.useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      if (target.isContentEditable) {
        return true;
      }

      return Boolean(
        target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      // Redo: Cmd+Shift+Z or Ctrl+Y
      if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) {
        if (controller.canRedo()) {
          event.preventDefault();
          controller.redo();
        }
        return;
      }

      // Undo: Cmd+Z / Ctrl+Z (no shift)
      if (key === 'z' && !event.shiftKey) {
        if (controller.canUndo()) {
          event.preventDefault();
          controller.undo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [controller]);

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

        <CanvasScrollContext.Provider value={canvasScrollRef}>
          <Box
            ref={canvasScrollRef}
            sx={{
              flexGrow: 1,
              minWidth: 0,
              overflowY: 'auto',
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
            }}
          >
            {canvas ?? <StudioCanvas />}
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

