'use client';
import * as React from 'react';
import type { SxProps, Theme } from '@mui/material';
import { Box, Paper, Typography } from '@mui/material';

import {
  useStudioController,
  useStudioSelector,
  selectMode,
  selectActivePage,
  selectWidgets,
} from '../../context';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { StudioWidgetCard } from '../StudioWidgetCard';
import type { StudioWidgetCardProps } from '../StudioWidgetCard';
import { createDefaultWidget, widgetKindRequiresDataSource } from '../../internals/widgetUtils';
import type { StudioWidget } from '../../models/widgetTypes';
import type { StudioPage } from '../../models/widgetTypes';
import { StudioQuickFilterBar } from './StudioQuickFilterBar';
import { StudioDateRangeBar } from './StudioDateRangeBar';
import {
  DRAG_TYPE_CANVAS_WIDGET,
  DRAG_TYPE_COMPOSE_WIDGET,
  type StudioDragItem,
} from './studioWidgetDndTypes';
import { GRID_COLS, MIN_SPAN } from './canvasGridConstants';
import { InsertionPoint } from './InsertionPoint';
import { WidgetGap } from './WidgetGap';

/** Minimum column span for a KPI widget without a sparkline (narrower is fine without the chart). */
const KPI_NO_SPARKLINE_MIN_SPAN = 4;

/** Return the minimum resize column span for a widget based on its kind and config. */
function getWidgetMinSpan(widget: StudioWidget | undefined): number {
  if (widget?.kind === 'kpi' && !widget.config.kpiSparkline) {
    return KPI_NO_SPARKLINE_MIN_SPAN;
  }
  return MIN_SPAN;
}

export interface StudioCanvasProps {
  /**
   * Canvas width (in px) below which all widgets stack to full width in view mode.
   * This is the global default; individual pages can override it via `StudioPage.stackBreakpoint`.
   * Set to `0` to disable responsive stacking entirely.
   * @default 600
   */
  stackBreakpoint?: number;
  /** Custom styles applied to the canvas root element. */
  sx?: SxProps<Theme>;
  slotProps?: {
    /** Forwarded to every `StudioWidgetCard` rendered on the canvas. */
    widgetCard?: Partial<Omit<StudioWidgetCardProps, 'widgetId' | 'isFirstRow' | 'pageTheme'>>;
  };
}

export const StudioCanvas = React.memo(function StudioCanvas(props: StudioCanvasProps) {
  const { slotProps, stackBreakpoint: stackBreakpointProp = 600, sx } = props;
  const mode = useStudioSelector(selectMode);
  const features = useStudioFeatures();
  // Defer page transitions so the browser stays responsive while new page widgets mount.
  // useSyncExternalStore updates are synchronous, so startTransition alone doesn't help;
  // useDeferredValue explicitly schedules the expensive new-page render at low priority.
  const liveActivePage = useStudioSelector(selectActivePage);
  const activePage = React.useDeferredValue(liveActivePage);
  const widgetRows = activePage?.widgetRows;
  const widgetColSpans = activePage?.widgetColSpans;
  const pageTheme = activePage?.theme;
  const widgets = useStudioSelector(selectWidgets);
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

  // isHalfStacked: canvas is between 1× and 2× the stack breakpoint — double each widget's
  // column span (capped at GRID_COLS) so 4-wide becomes 2-up before going to 1-up.
  const isHalfStacked =
    mode !== 'edit' &&
    effectiveBreakpoint > 0 &&
    canvasWidth !== null &&
    canvasWidth >= effectiveBreakpoint &&
    canvasWidth < effectiveBreakpoint * 2;

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
    (data: StudioDragItem, rowIndex: number, colIndex: number, orientation: 'horizontal' | 'vertical') => {
      const currentRows = widgetRowsRef.current;
      const activePageId = controller.getState().dashboard.activePageId;

      if (data.type === DRAG_TYPE_COMPOSE_WIDGET && data.kind) {
        const sources = Object.values(controller.getState().dataSources);
        if (widgetKindRequiresDataSource(data.kind) && sources.length === 0) {
          return;
        }
        const newWidget = createDefaultWidget(data.kind);
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
      } else if (data.type === DRAG_TYPE_CANVAS_WIDGET && data.widgetId) {
        const widgetId: string = data.widgetId;
        const sourcePageId: string | undefined = data.sourcePageId;
        const isCrossPage = sourcePageId != null && sourcePageId !== activePageId;

        // Build the target page rows: start from currentRows (already the target page)
        // and place the widget in the correct position.
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
          if (destSpanTotal > GRID_COLS) {
            const { [widgetId]: removedSpan, ...rest } = nextColSpans;
            void removedSpan;
            nextColSpans = Object.keys(rest).length > 0 ? rest : undefined;
          }
        }

        const state = controller.getState();

        // When dropping onto a different page, also remove the widget from the source page.
        const sourcePageUpdate: Record<string, StudioPage> = {};
        if (isCrossPage && sourcePageId && state.pages[sourcePageId]) {
          const srcRows = (state.pages[sourcePageId].widgetRows ?? []).flatMap((r) => {
            const row = r.filter((id) => id !== widgetId);
            return row.length > 0 ? [row] : [];
          });
          sourcePageUpdate[sourcePageId] = {
            ...state.pages[sourcePageId],
            widgetRows: srcRows,
          };
        }

        controller.updateState({
          pages: {
            ...state.pages,
            ...sourcePageUpdate,
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
      <Box
        ref={canvasRef}
        sx={[{ p: mode === 'edit' ? 0 : '8px' }, ...(Array.isArray(sx) ? sx : [sx])]}
      >
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
    <React.Fragment>
      <Box
        ref={canvasRef}
        sx={[
          {
            width: '100%',
            p: mode === 'edit' ? 0 : '8px',
            backgroundColor: pageTheme?.pageBackground ?? undefined,
            minHeight: '100%',
          },
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
        onMouseDown={(event) => {
          // Deselect when clicking the canvas background (not a widget card)
          const target = event.target as HTMLElement;
          if (!target.closest('[data-widget-card]')) {
            controller.setSelectedWidget(null);
          }
        }}
      >
        {/* Date range bar — shown in both modes when the page has date/datetime fields */}
        {features.quickFilter && <StudioDateRangeBar />}

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
            widgetRowsRef={widgetRowsRef}
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
                  widgetRowsRef={widgetRowsRef}
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
                //
                // View mode: three responsive tiers based on canvasWidth vs stackBreakpoint (B):
                //   • canvasWidth ≥ 2B  → normal spans (e.g. 25% for a 6-col widget)
                //   • B ≤ canvasWidth < 2B → isHalfStacked: double each span (capped at GRID_COLS)
                //                           so 4-wide widgets become 2-up before going full-width
                //   • canvasWidth < B   → isStacked: all widgets full-width (1-up)
                //
                // Flex-basis is gap-adjusted so N equal-width items + (N−1)×8px gaps = 100%.
                // Formula: calc(pct% − 8×(1−pct/100)px) where pct = effectiveSpan/GRID_COLS×100.
                const defaultFlexGrow = Math.round(GRID_COLS / row.length);
                // Compute the effective span for this responsive tier.
                let effectiveViewSpan: number | null = null;
                if (span != null) {
                  if (isStacked) {
                    effectiveViewSpan = GRID_COLS; // 100%
                  } else if (isHalfStacked) {
                    effectiveViewSpan = Math.min(span * 2, GRID_COLS);
                  } else {
                    effectiveViewSpan = span;
                  }
                }
                // Gap-adjusted flex value for view mode.
                const viewFlexBasis = (s: number): string => {
                  const pct = (s / GRID_COLS) * 100;
                  const gapAdj = 8 * (1 - s / GRID_COLS);
                  return gapAdj > 0.001 ? `calc(${pct}% - ${gapAdj}px)` : `${pct}%`;
                };
                let flexValue: string | number;
                if (mode === 'edit') {
                  flexValue = `${span ?? defaultFlexGrow} 0 0`;
                } else if (effectiveViewSpan != null) {
                  flexValue = `0 0 ${viewFlexBasis(effectiveViewSpan)}`;
                } else {
                  flexValue = 1;
                }
                let maxWidth: string | undefined;
                if (mode !== 'edit' && effectiveViewSpan != null) {
                  maxWidth = viewFlexBasis(effectiveViewSpan);
                }

                // Spans for the resize handle on the right of this widget
                const nextId = row[colIndex + 1];
                const nextStoredSpan = nextId ? (widgetColSpans?.[nextId] ?? null) : null;
                const myEffectiveSpan = storedSpan ?? defaultFlexGrow;
                const nextEffectiveSpan = nextId
                  ? (nextStoredSpan ?? Math.round(GRID_COLS / row.length))
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
                    {/* Gap: DnD drop zone + resize handle (between/after widgets) */}
                    {mode === 'edit' && (
                      <WidgetGap
                        rowIndex={rowIndex}
                        colIndex={colIndex + 1}
                        onDrop={handleDrop}
                        showResizeHandle={colIndex < row.length - 1}
                        leftId={widgetId}
                        rightId={nextId}
                        leftSpan={myEffectiveSpan}
                        rightSpan={nextEffectiveSpan}
                        leftMinSpan={getWidgetMinSpan(widgets[widgetId])}
                        rightMinSpan={nextId ? getWidgetMinSpan(widgets[nextId]) : MIN_SPAN}
                        widgetRowsRef={widgetRowsRef}
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
                            getWidgetMinSpan(widgets[widgetId]),
                            nextId ? getWidgetMinSpan(widgets[nextId]) : MIN_SPAN,
                          );
                        }}
                      />
                    )}
                  </React.Fragment>
                );
              })}
              {/* Column grid lines overlay — shown during a resize drag on this row.
                Lines are offset to align with the widget area, accounting for the
                8px leading InsertionPoint and the 8px WidgetGap after each widget.
                For a multi-widget row, columns that fall inside widget j must also
                skip j WidgetGaps to the left of that widget, so the horizontal
                offset is (j+1)*8px rather than a constant 8px. */}
              {liveDrag &&
                row.includes(liveDrag.leftId) &&
                (() => {
                  // Build cumulative span array: cumSpans[j] = total span before widget j.
                  const flexGrowDefault = Math.round(GRID_COLS / row.length);
                  let acc = 0;
                  const cumSpans = row.map((wId) => {
                    const start = acc;
                    if (wId === liveDrag.leftId) {
                      acc += liveDrag.leftSpanLive;
                    } else if (wId === liveDrag.rightId) {
                      acc += liveDrag.totalSpan - liveDrag.leftSpanLive;
                    } else {
                      acc += widgetColSpans?.[wId] ?? flexGrowDefault;
                    }
                    return start;
                  });
                  return Array.from({ length: GRID_COLS - 1 }).map((_, i) => {
                    const col = i + 1;
                    // Find the widget index j that this column boundary falls within.
                    // j = the last widget whose cumulative start span ≤ col.
                    let j = 0;
                    for (let k = 1; k < cumSpans.length; k++) {
                      if (cumSpans[k] <= col) {
                        j = k;
                      }
                    }
                    return (
                      <Box
                        key={i}
                        sx={{
                          position: 'absolute',
                          top: 0,
                          bottom: 0,
                          // Correct offset: (j+1) fixed-width items (1 IP + j gaps) before widget j,
                          // plus the proportional column fraction across the total flex area.
                          left: `calc(${(j + 1) * 8}px + ${col / GRID_COLS} * (100% - ${(row.length + 1) * 8}px))`,
                          width: '1px',
                          bgcolor: 'divider',
                          opacity: 0.6,
                          pointerEvents: 'none',
                          zIndex: 15,
                        }}
                      />
                    );
                  });
                })()}
            </Box>
            {/* Insertion point below this row */}
            {mode === 'edit' && (
              <InsertionPoint
                rowIndex={rowIndex + 1}
                colIndex={0}
                onDrop={handleDrop}
                orientation="horizontal"
                mode={mode}
                widgetRowsRef={widgetRowsRef}
              />
            )}
          </Box>
        ))}
      </Box>
    </React.Fragment>
  );
});
