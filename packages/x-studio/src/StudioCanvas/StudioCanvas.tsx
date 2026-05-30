'use client';
import * as React from 'react';
import { Box, Paper, Typography } from '@mui/material';

import { useStudioController, useStudioSelector, selectMode, selectActivePage } from '../context';
import { StudioWidgetCard } from '../StudioWidgetCard';
import type { StudioWidgetCardProps } from '../StudioWidgetCard';
import { createDefaultWidget, widgetKindRequiresDataSource } from '../internals/widgetUtils';
import { StudioQuickFilterBar } from './StudioQuickFilterBar';
import { StudioDateRangeBar } from './StudioDateRangeBar';

export interface StudioCanvasProps {
  /**
   * Canvas width (in px) below which all widgets stack to full width in view mode.
   * This is the global default; individual pages can override it via `StudioPage.stackBreakpoint`.
   * Set to `0` to disable responsive stacking entirely.
   * @default 600
   */
  stackBreakpoint?: number;
  slotProps?: {
    /** Forwarded to every `StudioWidgetCard` rendered on the canvas. */
    widgetCard?: Partial<Omit<StudioWidgetCardProps, 'widgetId' | 'isFirstRow' | 'pageTheme'>>;
  };
}

// Plain JS DnD insertion point component — must live at module level
function InsertionPoint({
  rowIndex,
  colIndex,
  onDrop,
  orientation,
  mode,
}: {
  rowIndex: number;
  colIndex: number;
  onDrop: (
    data: any,
    rowIndex: number,
    colIndex: number,
    orientation: 'horizontal' | 'vertical',
  ) => void;
  orientation: 'vertical' | 'horizontal';
  mode: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = React.useState(false);
  // Keep a ref to the latest position values so the effect can capture them
  // without listing them as deps (position never causes listener re-registration).
  const posRef = React.useRef({ rowIndex, colIndex, orientation });
  posRef.current = { rowIndex, colIndex, orientation };

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- setIsOver calls are in separate DOM event handlers, not cascading setState
  React.useEffect(() => {
    // No-op in view mode
    if (mode !== 'edit') {
      return undefined;
    }
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    function handleDragOver(event: DragEvent) {
      event.preventDefault();
      setIsOver(true);
    }
    function handleDragLeave(event: DragEvent) {
      // Ignore if the pointer moved to a child element (e.g. the indicator line)
      if (node?.contains(event.relatedTarget as Node)) {
        return;
      }
      setIsOver(false);
    }
    function handleDropEvent(event: DragEvent) {
      setIsOver(false);
      try {
        const data = JSON.parse(event.dataTransfer?.getData('application/json') || '{}');
        const { rowIndex: r, colIndex: c, orientation: o } = posRef.current;
        onDrop(data, r, c, o);
      } catch {
        /* ignore invalid JSON */
      }
    }
    node.addEventListener('dragover', handleDragOver);
    node.addEventListener('dragleave', handleDragLeave);
    node.addEventListener('drop', handleDropEvent);
    return () => {
      node.removeEventListener('dragover', handleDragOver);
      node.removeEventListener('dragleave', handleDragLeave);
      node.removeEventListener('drop', handleDropEvent);
    };
    // onDrop is now a stable useCallback; mode changes require listener re-registration.
    // rowIndex/colIndex/orientation are read from posRef so excluded from deps.
    // react-doctor-disable-next-line react-doctor/prefer-use-effect-event
  }, [onDrop, mode]);
  // Only show the line when hovered, otherwise invisible and non-interfering
  return (
    <Box
      ref={ref}
      sx={{
        position: 'relative',
        ...(orientation === 'vertical'
          ? {
              width: 8,
              minWidth: 8,
              alignSelf: 'stretch',
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: 'center',
            }
          : {
              width: '100%',
              height: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'stretch',
            }),
        zIndex: isOver ? 2 : 1,
      }}
    >
      {isOver && orientation === 'vertical' && (
        <Box
          sx={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: 2,
            bgcolor: 'primary.main',
            borderRadius: 1,
            transform: 'translateX(-50%)',
            boxShadow: 2,
          }}
        />
      )}
      {isOver && orientation === 'horizontal' && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: 8,
            right: 8,
            height: 2,
            bgcolor: 'primary.main',
            borderRadius: 1,
            transform: 'translateY(-50%)',
            boxShadow: 2,
          }}
        />
      )}
    </Box>
  );
}

// Between-widget column resize handle — sits in the gap between two flex siblings
function RowResizeHandle({
  leftId,
  rightId,
  leftSpan,
  rightSpan,
  onDragMove,
  onDragEnd,
}: {
  leftId: string;
  rightId: string;
  leftSpan: number;
  rightSpan: number;
  onDragMove: (leftId: string, rightId: string, leftSpanLive: number) => void;
  onDragEnd: (leftId: string, rightId: string, leftSpan: number, rightSpan: number) => void;
}) {
  const totalSpan = leftSpan + rightSpan;
  const dragRef = React.useRef<{
    combinedLeft: number;
    combinedWidth: number;
    totalSpan: number;
  } | null>(null);
  const [active, setActive] = React.useState(false);

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      // The handle sits inside a gap element; find the widget boxes on either side
      const gap = handle.parentElement;
      if (!gap) {
        return;
      }
      const leftBox = gap.previousElementSibling as HTMLElement | null;
      const rightBox = gap.nextElementSibling as HTMLElement | null;
      if (!leftBox || !rightBox) {
        return;
      }
      const leftRect = leftBox.getBoundingClientRect();
      const rightRect = rightBox.getBoundingClientRect();
      dragRef.current = {
        combinedLeft: leftRect.left,
        combinedWidth: rightRect.right - leftRect.left,
        totalSpan,
      };
      setActive(true);
      handle.setPointerCapture(event.pointerId);
    },
    [totalSpan],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const fraction = (event.clientX - drag.combinedLeft) / drag.combinedWidth;
      const minFrac = 3 / drag.totalSpan;
      const clamped = Math.max(minFrac, Math.min(1 - minFrac, fraction));
      // Snap at midpoint: jump to the next column when the mouse crosses 50% between columns
      const leftSpanLive = Math.max(
        3,
        Math.min(drag.totalSpan - 3, Math.round(clamped * drag.totalSpan)),
      );
      onDragMove(leftId, rightId, leftSpanLive);
    },
    [leftId, rightId, onDragMove],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      dragRef.current = null;
      setActive(false);
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      const fraction = (event.clientX - drag.combinedLeft) / drag.combinedWidth;
      const minFrac = 3 / drag.totalSpan;
      const clamped = Math.max(minFrac, Math.min(1 - minFrac, fraction));
      const snappedLeft = Math.max(
        3,
        Math.min(drag.totalSpan - 3, Math.round(clamped * drag.totalSpan)),
      );
      const snappedRight = drag.totalSpan - snappedLeft;
      onDragEnd(leftId, rightId, snappedLeft, snappedRight);
    },
    [leftId, rightId, onDragEnd],
  );

  return (
    <Box
      data-resize-handle
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      sx={{
        position: 'absolute',
        inset: 0,
        cursor: 'col-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
        '&:hover .rh-bar, &[data-active] .rh-bar': { opacity: 1, bgcolor: 'primary.main' },
      }}
      data-active={active ? '' : undefined}
    >
      <Box
        className="rh-bar"
        sx={{
          width: 3,
          height: '36%',
          minHeight: 20,
          borderRadius: 4,
          bgcolor: active ? 'primary.main' : 'action.disabled',
          opacity: active ? 1 : 0,
          transition: 'opacity 0.15s, background-color 0.15s',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}

export const StudioCanvas = React.memo(function StudioCanvas(props: StudioCanvasProps) {
  const { slotProps, stackBreakpoint: stackBreakpointProp = 600 } = props;
  const mode = useStudioSelector(selectMode);
  // Defer page transitions so the browser stays responsive while new page widgets mount.
  // useSyncExternalStore updates are synchronous, so startTransition alone doesn't help;
  // useDeferredValue explicitly schedules the expensive new-page render at low priority.
  const liveActivePage = useStudioSelector(selectActivePage);
  const activePage = React.useDeferredValue(liveActivePage);
  const widgetRows = activePage?.widgetRows;
  const widgetColSpans = activePage?.widgetColSpans;
  const pageTheme = activePage?.theme;
  const controller = useStudioController();
  const canvasRef = React.useRef<HTMLDivElement>(null);

  // Effective breakpoint: per-page override takes priority over the prop.
  const effectiveBreakpoint =
    activePage?.stackBreakpoint !== undefined ? activePage.stackBreakpoint : stackBreakpointProp;

  // Track canvas width to determine when to stack widgets in view mode.
  const [canvasWidth, setCanvasWidth] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (mode === 'edit' || effectiveBreakpoint === 0) {
      return undefined;
    }
    const node = canvasRef.current;
    if (!node) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setCanvasWidth(entry.contentRect.width);
      }
    });
    observer.observe(node);
    // Set initial width
    setCanvasWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [mode, effectiveBreakpoint]);

  const isStacked =
    mode !== 'edit' &&
    effectiveBreakpoint > 0 &&
    canvasWidth !== null &&
    canvasWidth < effectiveBreakpoint;

  // Live resize: maps widgetId → continuous (float) span during a between-widget drag.
  const [liveDrag, setLiveDrag] = React.useState<{
    leftId: string;
    rightId: string;
    leftSpanLive: number;
    totalSpan: number;
  } | null>(null);

  // ── Auto-scroll while dragging near the top/bottom viewport edge ────────────
  React.useEffect(() => {
    if (mode !== 'edit') {
      return undefined;
    }

    const EDGE_ZONE = 80; // px from viewport top/bottom that triggers scroll
    const MAX_SPEED = 16; // px per frame at the very edge

    let rafId: number | null = null;
    let scrollEl: Element | null = null;
    let scrollDir = 0; // -1 up, 0 none, +1 down

    function findScrollParent(el: Element | null): Element | null {
      while (el && el !== document.documentElement) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === 'auto' || overflowY === 'scroll') {
          return el;
        }
        el = el.parentElement;
      }
      return document.scrollingElement ?? document.documentElement;
    }

    function step() {
      if (scrollDir !== 0 && scrollEl) {
        scrollEl.scrollTop += scrollDir * MAX_SPEED;
        rafId = requestAnimationFrame(step);
      }
    }

    function onDragOver(event: DragEvent) {
      if (!scrollEl) {
        scrollEl = findScrollParent(canvasRef.current);
      }
      const { clientY } = event;
      const viewH = window.innerHeight;
      if (clientY < EDGE_ZONE) {
        const newDir = -1;
        if (scrollDir !== newDir) {
          scrollDir = newDir;
          if (rafId === null) {
            rafId = requestAnimationFrame(step);
          }
        }
      } else if (clientY > viewH - EDGE_ZONE) {
        const newDir = 1;
        if (scrollDir !== newDir) {
          scrollDir = newDir;
          if (rafId === null) {
            rafId = requestAnimationFrame(step);
          }
        }
      } else {
        scrollDir = 0;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }
    }

    function stopScroll() {
      scrollDir = 0;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    const node = canvasRef.current;
    if (!node) {
      return undefined;
    }
    node.addEventListener('dragover', onDragOver);
    node.addEventListener('drop', stopScroll);
    // Must store a reference to the dragleave handler so it can be removed in cleanup.
    function handleDragLeave(evt: DragEvent) {
      // Only stop if leaving the canvas entirely (not moving between children)
      if (!node!.contains(evt.relatedTarget as Node)) {
        stopScroll();
      }
    }
    node.addEventListener('dragleave', handleDragLeave);

    return () => {
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('drop', stopScroll);
      node.removeEventListener('dragleave', handleDragLeave);
      stopScroll();
    };
  }, [mode]);

  // Keep the latest widgetRows/colSpans in a ref so the stable handleDrop closure
  // can read current data without being recreated on every drop.
  const widgetRowsRef = React.useRef(widgetRows);
  widgetRowsRef.current = widgetRows;
  const widgetColSpansRef = React.useRef(widgetColSpans);
  widgetColSpansRef.current = widgetColSpans;

  // Stable drop handler — useCallback with only [controller] as dep.
  const handleDrop = React.useCallback(
    (data: any, rowIndex: number, colIndex: number, orientation: 'horizontal' | 'vertical') => {
      const currentRows = widgetRowsRef.current;
      const activePageId = controller.getState().dashboard.activePageId;

      if (data?.type === 'compose-widget' && data.kind) {
        const sources = Object.values(controller.getState().dataSources);
        if (widgetKindRequiresDataSource(data.kind) && sources.length === 0) {
          return;
        }
        const newWidget = createDefaultWidget(data.kind, sources[0]);
        const rows = currentRows.map((r) => [...r]);
        if (orientation === 'horizontal') {
          rows.splice(rowIndex, 0, [newWidget.id]);
        } else {
          const row = rows[rowIndex] ?? [];
          row.splice(colIndex, 0, newWidget.id);
          rows[rowIndex] = row;
        }
        const state = controller.getState();
        const targetPage = state.pages[activePageId];
        controller.updateState({
          widgets: { ...state.widgets, [newWidget.id]: newWidget },
          pages: {
            ...state.pages,
            [activePageId]: { ...targetPage, widgetRows: rows },
          },
          shell: { ...state.shell, selectedWidgetId: newWidget.id },
        });
      } else if (data?.type === 'canvas-widget' && data.widgetId) {
        const widgetId: string = data.widgetId;
        const rows = currentRows.map((r) => r.filter((id) => id !== widgetId));
        if (orientation === 'horizontal') {
          rows.splice(rowIndex, 0, [widgetId]);
        } else {
          const row = rows[rowIndex] ?? [];
          row.splice(colIndex, 0, widgetId);
          rows[rowIndex] = row;
        }
        const cleaned = rows.filter((r) => r.length > 0);

        // Determine the destination row after cleaning
        const destRow = cleaned.find((r) => r.includes(widgetId)) ?? [];
        const isNewSingleton = destRow.length === 1;

        // Clear the moved widget's colSpan if it lands alone in a row, or if
        // its span would push the row total beyond 12 columns.
        let nextColSpans = widgetColSpansRef.current;
        if (isNewSingleton) {
          if (nextColSpans?.[widgetId] != null) {
            const { [widgetId]: removedSpan, ...rest } = nextColSpans;
            void removedSpan;
            nextColSpans = Object.keys(rest).length > 0 ? rest : undefined;
          }
        } else if (nextColSpans?.[widgetId] != null) {
          // Check if the destination row's total spans exceed 12
          const destSpanTotal = destRow.reduce((sum, id) => {
            const s = nextColSpans?.[id];
            return sum + (s ?? 0);
          }, 0);
          if (destSpanTotal > 12) {
            const { [widgetId]: removedSpan, ...rest } = nextColSpans;
            void removedSpan;
            nextColSpans = Object.keys(rest).length > 0 ? rest : undefined;
          }
        }

        const state = controller.getState();
        controller.updateState({
          pages: {
            ...state.pages,
            [activePageId]: {
              ...state.pages[activePageId],
              widgetRows: cleaned,
              widgetColSpans: nextColSpans,
            },
          },
          shell: { ...state.shell, selectedWidgetId: widgetId },
        });
      }
    },
    [controller],
  );

  if (!widgetRows || widgetRows.length === 0) {
    return (
      <Box ref={canvasRef} sx={{ p: mode === 'edit' ? 0 : '8px' }}>
        <Paper
          variant="outlined"
          sx={{
            alignItems: 'center',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            minHeight: 420,
            p: 4,
            borderStyle: 'dashed',
            justifyContent: 'center',
          }}
        >
          <Typography variant="h6" color="text.secondary">
            Canvas is empty
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            {mode === 'edit'
              ? 'Use the Compose panel to add widgets or drag them here.'
              : 'Switch to Edit mode to add widgets.'}
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box
      ref={canvasRef}
      sx={{
        width: '100%',
        p: mode === 'edit' ? 0 : '8px',
        backgroundColor: pageTheme?.pageBackground ?? undefined,
        minHeight: '100%',
      }}
      onMouseDown={(event) => {
        // Deselect when clicking the canvas background (not a widget card)
        const target = event.target as HTMLElement;
        if (!target.closest('[data-widget-card]')) {
          controller.setSelectedWidget(null);
        }
      }}
    >
      {/* Date range bar — shown in both modes when the page has date/datetime fields */}
      <StudioDateRangeBar />

      {/* Quick filter bar — view mode only, shown when page filters are active */}
      {mode !== 'edit' && <StudioQuickFilterBar />}

      {/* Insertion point above the first row — inset by the vertical drop zone width (16px) on each side */}
      {mode === 'edit' && (
        <InsertionPoint
          rowIndex={0}
          colIndex={0}
          onDrop={handleDrop}
          orientation="horizontal"
          mode={mode}
        />
      )}
      {widgetRows.map((row, rowIndex) => (
        <Box key={row.join('-')} sx={rowIndex > 0 && mode !== 'edit' ? { mt: 1 } : undefined}>
          <Box
            sx={{
              display: 'flex',
              flexWrap: mode === 'edit' ? 'nowrap' : 'wrap',
              gap: mode === 'edit' ? 0 : 1,
              width: '100%',
              alignItems: 'stretch',
              position: 'relative',
            }}
          >
            {/* Insertion point before first widget in row */}
            {mode === 'edit' && (
              <InsertionPoint
                rowIndex={rowIndex}
                colIndex={0}
                onDrop={handleDrop}
                orientation="vertical"
                mode={mode}
              />
            )}
            {row.map((widgetId, colIndex) => {
              // Compute flex value, using live drag for the two resizing widgets
              const storedSpan = widgetColSpans?.[widgetId] ?? null;
              let liveSpan: number | null = null;
              if (liveDrag) {
                if (widgetId === liveDrag.leftId) {
                  liveSpan = liveDrag.leftSpanLive;
                } else if (widgetId === liveDrag.rightId) {
                  liveSpan = liveDrag.totalSpan - liveDrag.leftSpanLive;
                }
              }
              const span = liveSpan ?? storedSpan;

              // Edit mode: use flex-grow proportional to column span (flex-basis: 0).
              // Insertion points have a fixed 8px width each; percentage-based flex-basis
              // would sum to 100% *before* those, causing overflow.  Flex-grow distributes
              // only the remaining space after fixed items, so the row fills correctly.
              // Default flex-grow: 12/rowLength so unsized widgets match the same ratio.
              // View mode: use percentage flex-basis (no insertion points present).
              // Stacked mode: force full width regardless of stored span.
              const defaultFlexGrow = Math.round(12 / row.length);
              let flexValue: string | number;
              if (isStacked) {
                flexValue = '0 0 100%';
              } else if (mode === 'edit') {
                flexValue = `${span ?? defaultFlexGrow} 0 0`;
              } else if (span != null) {
                flexValue = `0 0 ${(span / 12) * 100}%`;
              } else {
                flexValue = 1;
              }
              let maxWidth: string | undefined;
              if (isStacked) {
                maxWidth = '100%';
              } else if (mode !== 'edit' && span != null) {
                maxWidth = `${(span / 12) * 100}%`;
              }

              // Spans for the resize handle on the right of this widget
              const nextId = row[colIndex + 1];
              const nextStoredSpan = nextId ? (widgetColSpans?.[nextId] ?? null) : null;
              const myEffectiveSpan = storedSpan ?? defaultFlexGrow;
              const nextEffectiveSpan = nextId
                ? (nextStoredSpan ?? Math.round(12 / row.length))
                : 0;

              const isResizing =
                liveDrag && (widgetId === liveDrag.leftId || widgetId === liveDrag.rightId);

              return (
                <React.Fragment key={widgetId}>
                  <Box
                    sx={{
                      flex: flexValue,
                      maxWidth: maxWidth ?? undefined,
                      minWidth: mode === 'edit' ? 0 : 280,
                      display: 'flex',
                      flexDirection: 'column',
                      // Outline during active resize drag
                      outline: isResizing ? '2px solid' : 'none',
                      outlineColor: 'primary.main',
                      outlineOffset: -1,
                      borderRadius: 1,
                      transition: isResizing ? 'none' : 'flex 0.1s ease',
                    }}
                  >
                    <StudioWidgetCard
                      widgetId={widgetId}
                      isFirstRow={rowIndex === 0}
                      pageTheme={pageTheme}
                      {...slotProps?.widgetCard}
                    />
                  </Box>
                  {/* Gap: insertion point (DnD) + resize handle (between consecutive widgets) */}
                  {mode === 'edit' && (
                    <Box
                      data-gap
                      sx={{
                        position: 'relative',
                        flexShrink: 0,
                        width: 8,
                        alignSelf: 'stretch',
                      }}
                    >
                      <InsertionPoint
                        rowIndex={rowIndex}
                        colIndex={colIndex + 1}
                        onDrop={handleDrop}
                        orientation="vertical"
                        mode={mode}
                      />
                      {/* Resize handle only between consecutive widgets (not after the last) */}
                      {colIndex < row.length - 1 && (
                        <RowResizeHandle
                          leftId={widgetId}
                          rightId={nextId}
                          leftSpan={myEffectiveSpan}
                          rightSpan={nextEffectiveSpan}
                          onDragMove={(lId, rId, leftSpanLive) => {
                            setLiveDrag({
                              leftId: lId,
                              rightId: rId,
                              leftSpanLive,
                              totalSpan: myEffectiveSpan + nextEffectiveSpan,
                            });
                          }}
                          onDragEnd={(lId, rId, snappedLeft, snappedRight) => {
                            setLiveDrag(null);
                            controller.setAdjacentWidgetColSpans(
                              lId,
                              snappedLeft,
                              rId,
                              snappedRight,
                            );
                          }}
                        />
                      )}
                    </Box>
                  )}
                </React.Fragment>
              );
            })}
            {/* Column grid lines overlay — shown during a resize drag on this row.
                Lines are offset to align with the widget area, accounting for the
                8px insertion point at the left and the 8px gap(s) within and after. */}
            {liveDrag &&
              row.includes(liveDrag.leftId) &&
              Array.from({ length: 11 }).map((_, i) => (
                <Box
                  key={i}
                  sx={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    // Widget area starts at 8px (left IP) and ends at rowWidth − 8px (trailing gap).
                    // Internal gaps add (row.length − 1) × 8px; total fixed = (row.length + 1) × 8px.
                    left: `calc(8px + ${(i + 1) / 12} * (100% - ${(row.length + 1) * 8}px))`,
                    width: '1px',
                    bgcolor: 'divider',
                    opacity: 0.6,
                    pointerEvents: 'none',
                    zIndex: 15,
                  }}
                />
              ))}
          </Box>
          {/* Insertion point below this row */}
          {mode === 'edit' && (
            <InsertionPoint
              rowIndex={rowIndex + 1}
              colIndex={0}
              onDrop={handleDrop}
              orientation="horizontal"
              mode={mode}
            />
          )}
        </Box>
      ))}
    </Box>
  );
});
