'use client';
import * as React from 'react';
import { Box, Paper, Typography } from '@mui/material';

import { useStudioController, useStudioSelector, selectMode, selectActivePage } from '../context';
import { StudioWidgetCard } from '../StudioWidgetCard';
import type { StudioWidgetCardProps } from '../StudioWidgetCard';
import { createDefaultWidget, widgetKindRequiresDataSource } from '../internals/widgetUtils';

export interface StudioCanvasProps {
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

export const StudioCanvas = React.memo(function StudioCanvas(props: StudioCanvasProps) {
  const { slotProps } = props;
  const mode = useStudioSelector(selectMode);
  const activePage = useStudioSelector(selectActivePage);
  const widgetRows = activePage?.widgetRows;
  const widgetColSpans = activePage?.widgetColSpans;
  const pageTheme = activePage?.theme;
  const controller = useStudioController();
  const canvasRef = React.useRef<HTMLDivElement>(null);

  // Live resize: tracks which widget is being dragged and what column span
  // the user has snapped to, before the pointer is released.
  const [dragSpanOverride, setDragSpanOverride] = React.useState<{
    widgetId: string;
    span: number;
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
    node.addEventListener('dragleave', (evt: DragEvent) => {
      // Only stop if leaving the canvas entirely (not moving between children)
      if (!node.contains(evt.relatedTarget as Node)) {
        stopScroll();
      }
    });

    return () => {
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('drop', stopScroll);
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
            const { [widgetId]: _removed, ...rest } = nextColSpans;
            void _removed;
            nextColSpans = Object.keys(rest).length > 0 ? rest : undefined;
          }
        } else if (nextColSpans?.[widgetId] != null) {
          // Check if the destination row's total spans exceed 12
          const destSpanTotal = destRow.reduce((sum, id) => {
            const s = nextColSpans?.[id];
            return sum + (s ?? 0);
          }, 0);
          if (destSpanTotal > 12) {
            const { [widgetId]: _removed, ...rest } = nextColSpans;
            void _removed;
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
        <Box key={rowIndex} sx={rowIndex > 0 && mode !== 'edit' ? { mt: 1 } : undefined}>
          <Box
            sx={{
              display: 'flex',
              flexWrap: mode === 'edit' ? 'nowrap' : 'wrap',
              gap: mode === 'edit' ? 0 : 1,
              width: '100%',
              alignItems: 'stretch',
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
              const span =
                dragSpanOverride?.widgetId === widgetId
                  ? dragSpanOverride.span
                  : (widgetColSpans?.[widgetId] ?? null);
              const pct = span != null ? `${(span / 12) * 100}%` : undefined;
              const isSingleInRow = row.length === 1;
              return (
                <React.Fragment key={widgetId}>
                  <Box
                    sx={{
                      flex: pct ? `0 0 ${pct}` : 1,
                      maxWidth: pct ?? undefined,
                      minWidth: mode === 'edit' ? 0 : 280,
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <StudioWidgetCard
                      widgetId={widgetId}
                      isFirstRow={rowIndex === 0}
                      isSingleInRow={isSingleInRow}
                      pageTheme={pageTheme}
                      canvasRef={canvasRef}
                      rowWidgetIds={row}
                      onResizeDrag={(liveSpan) =>
                        setDragSpanOverride(
                          liveSpan != null ? { widgetId, span: liveSpan } : null,
                        )
                      }
                      {...slotProps?.widgetCard}
                    />
                  </Box>
                  {/* Insertion point after this widget */}
                  {mode === 'edit' && (
                    <InsertionPoint
                      rowIndex={rowIndex}
                      colIndex={colIndex + 1}
                      onDrop={handleDrop}
                      orientation="vertical"
                      mode={mode}
                    />
                  )}
                </React.Fragment>
              );
            })}
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
