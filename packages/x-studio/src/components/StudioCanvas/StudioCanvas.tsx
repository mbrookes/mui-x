'use client';
import * as React from 'react';
import type { SxProps, Theme } from '@mui/material';
import { Box, Paper, Typography } from '@mui/material';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

import { useResizeObserver } from '@mui/x-internals/useResizeObserver';
import {
  useStudioController,
  useStudioSelector,
  selectMode,
  selectActivePage,
  selectPages,
  selectWidgets,
  selectDataSources,
  useCustomWidgetMap,
} from '../../context';
import { useStudioFeatures, useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { useStudioAnnounce } from '../../internals/StudioLiveRegion';
import { StudioWidgetErrorBoundary } from '../../internals/StudioWidgetErrorBoundary';
import { StudioWidgetCard } from '../StudioWidgetCard';
import type { StudioWidgetCardProps } from '../StudioWidgetCard';
import { createWidgetForKind, resolveWidgetRequiresDataSource } from '../../internals/widgetUtils';
import type { StudioWidget, StudioPage } from '../../models/widgetTypes';
import { isWidgetOfKind } from '../../models';
import type { StudioCustomWidgetDef } from '../../models';
import type { StudioMode } from '../../models/baseTypes';
import { StudioDateRangeBar } from './StudioDateRangeBar';
import {
  DRAG_TYPE_CANVAS_WIDGET,
  DRAG_TYPE_COMPOSE_WIDGET,
  type StudioDragItem,
} from './studioWidgetDndTypes';
import { GRID_COLS, MAX_PER_ROW, MIN_SPAN } from './canvasGridConstants';
import { resolveResizePair, resolveRowColSpans } from './rowColSpans';
import { InsertionPoint } from './InsertionPoint';
import { WidgetGap } from './WidgetGap';
import { useStudioDropTarget } from './useStudioDropTarget';
import { sanitizeCssColor } from '../../internals/cssValueValidation';
import { lookup } from '../../utils/safeLookup';

/**
 * The narrower minimum a sparkline-less KPI would PREFER (BL-155): without the chart it
 * still reads fine at a sixth of a row. It is a preference, not a floor — see
 * {@link getWidgetMinSpan}.
 */
const KPI_NO_SPARKLINE_MIN_SPAN = 4;

/**
 * The minimum resize column span for a widget, based on its kind and config.
 *
 * Floored at the reducer's `MIN_SPAN`. This function is the canvas's resize
 * VOCABULARY — it feeds `resolveResizePair`, which sets `RowResizeHandle`'s `minLeft`,
 * its published `aria-valuemin`, and the value announced by `canvasResizeAnnouncement` —
 * while the DOCUMENT's floor is the shared reducer's `MIN_SPAN` (6), applied by
 * `clampSpan` on every write and again at the load boundary. Returning the unfloored
 * `KPI_NO_SPARKLINE_MIN_SPAN` (4) made the canvas offer a span the document cannot hold:
 * the handle let the user drag a sparkline-less KPI to 4, announced "4 of 24", published
 * `aria-valuemin="4"` — and `setAdjacentWidgetColSpans('k1', 4, 'w2', 20, 4, 6)` then
 * committed `{ k1: 6, w2: 18 }`, because it floors each caller minimum at `MIN_SPAN` for
 * exactly this reason. The controller's floor is correct; this was the wrong end of the
 * pair. It is also an a11y defect — `aria-valuemin` was announcing a bound the widget
 * cannot actually take.
 *
 * The KPI preference is kept rather than deleted so the intent survives if `MIN_SPAN` ever
 * drops; do NOT "fix" the mismatch by lowering the reducer's `MIN_SPAN` instead.
 */
export function getWidgetMinSpan(widget: StudioWidget | undefined): number {
  const preferred =
    widget && isWidgetOfKind(widget, 'kpi') && !widget.config.kpiSparkline
      ? KPI_NO_SPARKLINE_MIN_SPAN
      : MIN_SPAN;
  return Math.max(preferred, MIN_SPAN);
}

/**
 * Evaluates a custom widget kind's `shouldHide` callback, treating a throw as "don't hide".
 *
 * `shouldHide` is arbitrary consumer code and it runs during LAYOUT RESOLUTION — in this
 * component's own render body, above every error boundary that wraps the widget itself.
 * A boundary rendered below the call site cannot contain it, so the throw would escape to
 * the canvas-wide boundary in `StudioContent` and replace every widget on every page with
 * a single error overlay. Containing it here keeps one consumer's bad predicate from
 * taking down the whole dashboard; "visible" is the safe default because a hidden widget
 * cannot be recovered from by the user, whereas a spuriously visible one can.
 */
function safeShouldHide(
  shouldHide: NonNullable<StudioCustomWidgetDef['shouldHide']>,
  args: Parameters<NonNullable<StudioCustomWidgetDef['shouldHide']>>[0],
): boolean {
  try {
    return shouldHide(args) === true;
  } catch {
    return false;
  }
}

/**
 * Splice `widgetId` into `rows[rowIndex]` at `colIndex`, respecting `MAX_PER_ROW`.
 *
 * Mutates `rows` in place (callers always pass a fresh copy). When the target row is
 * already full, the widget goes onto a brand-new row directly below instead of
 * overflowing — mirroring the fallback `moveWidgetInLayout` (keyboard) and
 * `duplicateWidget` already use, and closing the one layout-mutating path that enforced no
 * cap at all. `WidgetGap`/`InsertionPoint` refuse the drop before it gets here (see
 * `wouldOverflowRow`), so under the real UI this branch is unreachable; it stands as
 * defense in depth for programmatic drops and for a drop target belonging to another
 * Studio instance whose rows this canvas never saw.
 */
function insertIntoRow(
  rows: string[][],
  rowIndex: number,
  colIndex: number,
  widgetId: string,
): void {
  const row = rows[rowIndex] ?? [];
  if (row.length >= MAX_PER_ROW) {
    rows.splice(rowIndex + 1, 0, [widgetId]);
    return;
  }
  row.splice(colIndex, 0, widgetId);
  rows[rowIndex] = row;
}

/** State describing an in-progress resize drag between two adjacent widgets in a row. */
export interface LiveDragState {
  leftId: string;
  rightId: string;
  leftSpanLive: number;
  totalSpan: number;
}

/**
 * Compute the CSS `left` values for the column-divider overlay lines shown while a
 * resize drag is active on a row. One value is returned per grid-column boundary
 * (`GRID_COLS - 1` of them); each string is a `left` calc() expression relative to
 * the row's flex container.
 */
export function computeGridLineLefts(
  row: string[],
  widgetColSpans: Record<string, number> | undefined,
  liveDrag: LiveDragState,
): string[] {
  // Same resolution the row itself renders from (missing entry = equal share, row scaled
  // back into `GRID_COLS` when it overflows), so the divider lines can't drift from the
  // widget edges they're supposed to mark. See `rowColSpans.ts` for the single meaning.
  const resolved = resolveRowColSpans(row, widgetColSpans);
  let acc = 0;
  const cumSpans = row.map((wId, index) => {
    const start = acc;
    if (wId === liveDrag.leftId) {
      acc += liveDrag.leftSpanLive;
    } else if (wId === liveDrag.rightId) {
      acc += liveDrag.totalSpan - liveDrag.leftSpanLive;
    } else {
      acc += resolved[index];
    }
    return start;
  });
  return Array.from({ length: GRID_COLS - 1 }).map((_, i) => {
    const col = i + 1;
    let j = 0;
    for (let k = 1; k < cumSpans.length; k += 1) {
      if (cumSpans[k] <= col) {
        j = k;
      }
    }
    return `calc(${(j + 1) * 8}px + ${col / GRID_COLS} * (100% - ${(row.length + 1) * 8}px))`;
  });
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
  /** Called when the user clicks the canvas background (not on a widget). */
  onBackgroundClick?: () => void;
  slotProps?: {
    /** Forwarded to every `StudioWidgetCard` rendered on the canvas. */
    widgetCard?: Partial<Omit<StudioWidgetCardProps, 'widgetId' | 'isFirstRow' | 'pageTheme'>>;
  };
}

// ── StudioPageRows ──────────────────────────────────────────────────────────
// Per-page widget layout renderer. Each mounted page gets its own instance so
// that per-page state (liveDrag, refs, handleDrop) is isolated. Inactive pages
// are hidden via display:none on the wrapping Box in StudioCanvas but remain
// mounted, preventing data-pipeline teardown on tab switch.

interface StudioPageRowsProps {
  page: StudioPage;
  pageId: string;
  mode: StudioMode;
  widgets: ReturnType<typeof selectWidgets>;
  dataSources: ReturnType<typeof selectDataSources>;
  customWidgetMap: ReturnType<typeof useCustomWidgetMap>;
  canvasWidth: number | null;
  stackBreakpointProp: number;
  slotProps?: StudioCanvasProps['slotProps'];
  controller: ReturnType<typeof useStudioController>;
  announce: (message: string) => void;
  localeText: ReturnType<typeof useStudioLocaleText>;
}

function StudioPageRows({
  page,
  pageId,
  mode,
  widgets,
  dataSources,
  customWidgetMap,
  canvasWidth,
  stackBreakpointProp,
  slotProps,
  controller,
  announce,
  localeText,
}: StudioPageRowsProps) {
  const widgetRows = page.widgetRows;
  const widgetColSpans = page.widgetColSpans;
  const pageTheme = page.theme;

  const effectiveBreakpoint =
    page.stackBreakpoint !== undefined ? page.stackBreakpoint : stackBreakpointProp;

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

  const [liveDrag, setLiveDrag] = React.useState<{
    leftId: string;
    rightId: string;
    leftSpanLive: number;
    totalSpan: number;
  } | null>(null);

  const widgetRowsRef = React.useRef(widgetRows);
  // Assigned in an effect rather than during render (matching `ColorSwatch`): a
  // render-phase ref write is a side effect in the render body, which React may discard
  // (a render that never commits) or run twice. Every reader — `handleDrop` here, and
  // `isAdjacentToDraggingWidget`/`wouldOverflowRow`/`isRedundantHorizontalDrop` inside
  // `InsertionPoint`/`WidgetGap`'s `canDrop`/`onDrop` — runs from a pointer gesture,
  // which can only reach them after a commit, so the last COMMITTED render's rows are
  // the correct ones to see. No reader touches `.current` during render.
  React.useEffect(() => {
    widgetRowsRef.current = widgetRows;
  });

  const handleDrop = React.useCallback(
    (
      data: StudioDragItem,
      rowIndex: number,
      colIndex: number,
      orientation: 'horizontal' | 'vertical',
    ) => {
      const currentRows = widgetRowsRef.current;

      if (data.type === DRAG_TYPE_COMPOSE_WIDGET && data.kind) {
        const sources = Object.values(controller.getState().runtime.dataSources);
        // `resolveWidgetRequiresDataSource`/`createWidgetForKind` (not the kind-derived
        // `widgetKindRequiresDataSource` + a bare `createDefaultWidget`) so a dropped CUSTOM
        // kind is created exactly as the picker's click path creates it: its documented
        // `requiresDataSource` default of `false` is honored, and its `label`/`defaultConfig`
        // reach the new widget instead of being silently dropped.
        const def = customWidgetMap.get(data.kind);
        if (resolveWidgetRequiresDataSource(data.kind, def) && sources.length === 0) {
          // The drop target highlighted, so the gesture LOOKED accepted; bailing without a
          // word left a screen-reader (and every) user with no signal that nothing happened.
          // The success branch below announces, so the failure branch must too.
          announce(localeText.composeNoDataSources);
          return;
        }
        const newWidget = createWidgetForKind(data.kind, customWidgetMap);
        // Canvas-side geometry: splice the new widget into the target page's rows at
        // the drop position. The reducer owns the actual state transform + span cleanup.
        const rows = currentRows.map((r) => [...r]);
        if (orientation === 'horizontal') {
          rows.splice(rowIndex, 0, [newWidget.id]);
        } else {
          insertIntoRow(rows, rowIndex, colIndex, newWidget.id);
        }
        controller.insertWidgetAt(newWidget, pageId, rows);
        announce(localeText.canvasWidgetAddedAnnouncement);
      } else if (data.type === DRAG_TYPE_CANVAS_WIDGET && data.widgetId) {
        const widgetId: string = data.widgetId;
        const sourcePageId: string | undefined = data.sourcePageId;

        // Canvas-side geometry: build the target page's final rows by placing the
        // widget at the drop position (removing any prior occurrence first). The
        // reducer's `enforceLayoutColSpans` governs ALL span cleanup — stale singleton
        // spans, overflowing rows, and the source page's leftover span — so no manual
        // span-pruning happens here.
        //
        // Same-row rightward move fix: the removal below shifts every
        // later index in the widget's original row left by one BEFORE we splice at
        // `colIndex`. For a same-row move, `colIndex` was computed against the
        // PRE-removal row, so if the target gap sits after the widget's original
        // position it's now one slot too far right — row [a,b,c] dragging `a` onto the
        // gap between b/c (colIndex 2) would filter to [b,c] then splice(2,...) →
        // [b,c,a] instead of the intended [b,a,c]. Detect that case (only possible for
        // a vertical/into-row drop) and decrement the insertion index by one so it
        // lands against the POST-removal array the way the pre-removal gap index
        // visually pointed to. Leftward moves (removal index > insertion index) and
        // cross-row moves (widget not found in the target row) are unaffected.
        const originalColIndex =
          orientation === 'vertical' ? (currentRows[rowIndex]?.indexOf(widgetId) ?? -1) : -1;
        const adjustedColIndex =
          originalColIndex !== -1 && colIndex > originalColIndex ? colIndex - 1 : colIndex;

        const rows = currentRows.map((r) => r.filter((id) => id !== widgetId));
        if (orientation === 'horizontal') {
          rows.splice(rowIndex, 0, [widgetId]);
        } else {
          insertIntoRow(rows, rowIndex, adjustedColIndex, widgetId);
        }
        const cleaned = rows.filter((r) => r.length > 0);

        controller.moveWidget(widgetId, sourcePageId ?? pageId, pageId, cleaned);
        announce(localeText.canvasWidgetMovedAnnouncement);
      }
    },
    [controller, announce, localeText, pageId, customWidgetMap],
  );

  if (!widgetRows || widgetRows.length === 0) {
    return null;
  }

  return (
    <React.Fragment>
      {/* Insertion point above the first row */}
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
      {widgetRows.map((row, rowIndex) => {
        // In view mode, omit the row entirely when every widget in it opts into hiding.
        if (
          mode !== 'edit' &&
          row.length > 0 &&
          row.every((widgetId) => {
            // `widgetId` is doc-authored: guard the record index against inherited keys
            // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function
            // off `Object.prototype` instead of "not found" — the `!widget` check below would
            // not catch a truthy inherited function (prototype-chain key lookup fix).
            const widget = lookup(widgets, widgetId);
            if (!widget) {
              return true;
            }
            const customDef = customWidgetMap.get(widget.kind);
            if (!customDef?.shouldHide) {
              return false;
            }
            // `widget.sourceId` is doc-authored (host/AI-writable): guard the record index
            // against inherited keys ("toString"/"constructor"/…) so a bare bracket lookup
            // can't resolve a function off `Object.prototype` instead of "not found".
            const dataSource = lookup(dataSources, widget.sourceId);
            // Consumer callback evaluated during layout resolution — see `safeShouldHide`.
            return safeShouldHide(customDef.shouldHide, { widget, dataSource });
          })
        ) {
          return null;
        }
        // One span resolution for the whole row, shared by edit mode's flex-grow, view
        // mode's flex-basis, the resize handles and the divider overlay. Before this, each
        // of those sites decided independently what a MISSING `widgetColSpans` entry meant
        // — and view mode's answer (`flex: 1`, auto rather than a percentage basis)
        // disagreed with the others, so an over-budget row rendered three-across in edit
        // mode and wrapped the unspanned widget onto its own line in view mode. See
        // `rowColSpans.ts`.
        const resolvedSpans = resolveRowColSpans(row, widgetColSpans);
        return (
          // Keyed by the row's index within the page, not its membership (`row.join('-')`):
          // the row's identity shouldn't need to encode which widgets it currently holds.
          // Adding/moving/removing a widget elsewhere in the row previously changed this key
          // and remounted every sibling widget in the row, discarding their local component
          // state (see StudioWidgetCard, keyed by `widgetId` below, which no longer remounts
          // on ordinary layout edits as a result).
          <Box key={rowIndex} sx={rowIndex > 0 && mode !== 'edit' ? { mt: 1 } : undefined}>
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
                // Guarded record index, consistent with the hidden-row check above and
                // `context/selectors.ts`. Doubles as this card's error-boundary reset key:
                // the store hands out a new widget object on every doc edit to it.
                const widget = lookup(widgets, widgetId);
                // The widget's effective span: an explicit `widgetColSpans` entry, or an
                // equal share of the row when it has none — resolved once for the whole row
                // above, so every consumer of "how wide is this widget" agrees. Always a
                // finite positive number (`resolveRowColSpans` rejects NaN/Infinity/≤0 from a
                // hostile serialized doc rather than letting it reach the `flex` shorthand),
                // and never `null`: the "unknown width" case that used to fall through to
                // `flex: 1` in view mode no longer exists.
                const resolvedSpan = resolvedSpans[colIndex];
                let liveSpan: number | null = null;
                if (liveDrag) {
                  if (widgetId === liveDrag.leftId) {
                    liveSpan = liveDrag.leftSpanLive;
                  } else if (widgetId === liveDrag.rightId) {
                    liveSpan = liveDrag.totalSpan - liveDrag.leftSpanLive;
                  }
                }
                const span = liveSpan ?? resolvedSpan;

                // Edit mode: use flex-grow proportional to column span (flex-basis: 0).
                // View mode: three responsive tiers based on canvasWidth vs stackBreakpoint (B):
                //   • canvasWidth ≥ 2B  → normal spans
                //   • B ≤ canvasWidth < 2B → isHalfStacked: double each span (capped at GRID_COLS)
                //   • canvasWidth < B   → isStacked: all widgets full-width
                let effectiveViewSpan: number;
                if (isStacked) {
                  effectiveViewSpan = GRID_COLS;
                } else if (isHalfStacked) {
                  effectiveViewSpan = Math.min(span * 2, GRID_COLS);
                } else {
                  effectiveViewSpan = span;
                }
                const viewFlexBasis = (s: number): string => {
                  const pct = (s / GRID_COLS) * 100;
                  const gapAdj = 8 * (1 - s / GRID_COLS);
                  return gapAdj > 0.001 ? `calc(${pct}% - ${gapAdj}px)` : `${pct}%`;
                };
                const flexValue =
                  mode === 'edit' ? `${span} 0 0` : `0 0 ${viewFlexBasis(effectiveViewSpan)}`;
                const maxWidth = mode === 'edit' ? undefined : viewFlexBasis(effectiveViewSpan);

                // Spans for the resize handle on the right of this widget. Deliberately NOT
                // `resolvedSpans[colIndex]`/`[colIndex + 1]`: those describe how the row is
                // RENDERED, while the handle decides what may be WRITTEN BACK, and a resize
                // commit bypasses the reducer's row-sum sweep entirely. See
                // `resolveResizePair`.
                const nextId = row[colIndex + 1];
                const nextMinSpan = nextId ? getWidgetMinSpan(lookup(widgets, nextId)) : MIN_SPAN;
                const resizePair = resolveResizePair(
                  row,
                  widgetColSpans,
                  colIndex,
                  getWidgetMinSpan(widget),
                  nextMinSpan,
                );

                const isResizing =
                  liveDrag && (widgetId === liveDrag.leftId || widgetId === liveDrag.rightId);

                return (
                  <React.Fragment key={widgetId}>
                    <Box
                      // The widget's resolved column span, out of `GRID_COLS`. Published as
                      // a stable attribute because it is the single number both modes lay
                      // the row out from (edit mode's flex-grow, view mode's flex-basis
                      // percentage) — the thing that used to differ between them.
                      data-widget-col-span={span}
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
                      {/* Per-widget containment boundary. `StudioWidgetCard`'s three internal
                          boundaries only cover what they wrap (the actions overlay, the header,
                          and `def.component`); everything the card computes in its own render
                          body — L2 enrichment for custom kinds, `inferKpiDateSubtitle`, the
                          `def.shouldHide` predicate — sits ABOVE them and would otherwise escape
                          to the canvas-wide boundary in `StudioContent`, replacing every widget
                          on every page with one error overlay. Wrapping at this call site is the
                          only place a boundary can sit above the card's whole render.
                          `resetKeys` are identity-compared: a doc edit to this widget or a move
                          to another page clears a latched error, and the overlay's Retry covers
                          view-only dashboards where neither ever changes. */}
                      <StudioWidgetErrorBoundary resetKeys={[widget, pageId]}>
                        <StudioWidgetCard
                          widgetId={widgetId}
                          isFirstRow={rowIndex === 0}
                          pageId={pageId}
                          pageTheme={pageTheme}
                          {...slotProps?.widgetCard}
                        />
                      </StudioWidgetErrorBoundary>
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
                        leftSpan={resizePair.leftSpan}
                        rightSpan={resizePair.rightSpan}
                        leftMinSpan={getWidgetMinSpan(widget)}
                        rightMinSpan={nextMinSpan}
                        widgetRowsRef={widgetRowsRef}
                        onDragMove={(lId, rId, leftSpanLive) => {
                          setLiveDrag({
                            leftId: lId,
                            rightId: rId,
                            leftSpanLive,
                            totalSpan: resizePair.totalSpan,
                          });
                        }}
                        onDragEnd={(lId, rId, snappedLeft, snappedRight) => {
                          setLiveDrag(null);
                          controller.setAdjacentWidgetColSpans(
                            lId,
                            snappedLeft,
                            rId,
                            snappedRight,
                            getWidgetMinSpan(widget),
                            nextMinSpan,
                          );
                        }}
                        onDragCancel={() => setLiveDrag(null)}
                      />
                    )}
                  </React.Fragment>
                );
              })}
              {/* Column grid lines overlay — shown during a resize drag on this row. */}
              {liveDrag &&
                row.includes(liveDrag.leftId) &&
                computeGridLineLefts(row, widgetColSpans, liveDrag).map((left, i) => (
                  <Box
                    key={i}
                    sx={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left,
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
                widgetRowsRef={widgetRowsRef}
              />
            )}
          </Box>
        );
      })}
    </React.Fragment>
  );
}

export const StudioCanvas = React.memo(function StudioCanvas(props: StudioCanvasProps) {
  const { slotProps, stackBreakpoint: stackBreakpointProp = 600, sx, onBackgroundClick } = props;
  const mode = useStudioSelector(selectMode);
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const announce = useStudioAnnounce();
  const activePage = useStudioSelector(selectActivePage);
  const activePageId = activePage?.id;
  const pages = useStudioSelector(selectPages);
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const customWidgetMap = useCustomWidgetMap();
  const controller = useStudioController();
  // Finding 1.4: the canvas root is rendered by one of two mutually exclusive
  // branches below (empty-state vs populated) of this same persistent, memoized
  // component. A plain `React.useRef` never changes identity when the branch
  // flips, so anything that reads `.current` inside a `[ref]`-keyed effect (or a
  // `[ref, enabled]`-keyed one, like the shared `useResizeObserver`) would keep
  // referencing whatever node was mounted the first time that effect ran — dead
  // after the very first empty<->populated transition. A callback ref + state
  // makes the "current canvas node" a reactive value instead, so anything derived
  // from it (the resize-observer ref below, the initial-width effect, auto-scroll)
  // naturally re-runs on every attach/detach, including branch swaps.
  const [canvasNode, setCanvasNode] = React.useState<HTMLDivElement | null>(null);
  const canvasRefCallback = React.useCallback((node: HTMLDivElement | null) => {
    setCanvasNode(node);
  }, []);
  // A fresh RefObject whenever `canvasNode` changes, so `useResizeObserver`'s own
  // `[ref, enabled]`-keyed effect (which we can't edit — it lives in x-internals)
  // is forced to re-run and observe the newly-attached node instead of a stale one.
  const canvasResizeRef = React.useMemo(() => ({ current: canvasNode }), [canvasNode]);

  // Track which pages have ever been active — mount them once and keep alive.
  // Inactive pages use clip-path:inset(100%) + position:absolute (NOT display:none).
  // display:none restarts CSS animations on reveal. visibility:hidden avoids that but
  // SVG presentation attributes (visibility="visible") can override it, causing bleed-
  // through. clip-path creates an unoverridable clipping context for all descendants.
  const [mountedPageIds, setMountedPageIds] = React.useState<ReadonlySet<string>>(
    () => new Set(activePageId ? [activePageId] : []),
  );
  React.useEffect(() => {
    if (activePageId) {
      setMountedPageIds((prev) =>
        prev.has(activePageId) ? prev : new Set([...prev, activePageId]),
      );
    }
  }, [activePageId]);

  // Effective breakpoint for the resize observer (uses active page's override or the prop).
  const effectiveBreakpoint =
    activePage?.stackBreakpoint !== undefined ? activePage.stackBreakpoint : stackBreakpointProp;

  // Track canvas width to determine when to stack widgets in view mode.
  const [canvasWidth, setCanvasWidth] = React.useState<number | null>(null);
  const enabled = mode !== 'edit' && effectiveBreakpoint !== 0;
  useResizeObserver(
    canvasResizeRef,
    (entries) => {
      const entry = entries[0];
      if (entry) {
        setCanvasWidth(entry.contentRect.width);
      }
    },
    enabled,
  );
  // Set initial width on mount/mode-change/branch-swap (useResizeObserver only fires
  // on subsequent resizes — though re-observing a newly-attached node via
  // `canvasResizeRef` above also delivers an immediate size callback in practice,
  // `canvasNode` is included here too so this stays correct even if that changes).
  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    if (canvasNode) {
      setCanvasWidth(canvasNode.getBoundingClientRect().width);
    }
  }, [enabled, canvasNode]);

  // ── Auto-scroll the canvas's scroll container while dragging near its edges ──
  React.useEffect(() => {
    if (mode !== 'edit' || process.env.NODE_ENV === 'test') {
      return undefined;
    }

    function findScrollParent(el: Element | null): HTMLElement {
      while (el && el !== document.documentElement) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === 'auto' || overflowY === 'scroll') {
          return el as HTMLElement;
        }
        el = el.parentElement;
      }
      return (document.scrollingElement as HTMLElement) ?? document.documentElement;
    }

    return autoScrollForElements({ element: findScrollParent(canvasNode) });
  }, [mode, canvasNode]);

  // ── Empty-page drop target ──────────────────────────────────
  // `StudioPageRows` (and its `InsertionPoint`/`WidgetGap` drop targets) is never
  // rendered for an empty page — it returns `null` for `widgetRows.length === 0`,
  // and the branch below short-circuits before `StudioPageRows` is even reached.
  // Yet the edit-mode empty-state copy explicitly invites dropping ("...or drag
  // them here"), and `WidgetTypeCard` registers a real `DRAG_TYPE_COMPOSE_WIDGET`
  // draggable. Without a drop target here, dragging a widget type (or an existing
  // widget from another page) onto an empty page was a dead drop. Register one
  // directly on the empty-state Paper so the invitation is actually honored; this
  // mirrors `StudioPageRows.handleDrop`'s two branches but always produces a
  // single fresh row, since there is nothing to splice into.
  const emptyDropRef = React.useRef<HTMLDivElement>(null);
  const canDropOnEmptyPage = React.useCallback(() => mode === 'edit', [mode]);
  const handleEmptyPageDrop = React.useCallback(
    (data: StudioDragItem) => {
      if (!activePageId) {
        return;
      }
      if (data.type === DRAG_TYPE_COMPOSE_WIDGET && data.kind) {
        const sources = Object.values(controller.getState().runtime.dataSources);
        // Same shared resolution/creation as `StudioPageRows.handleDrop` and the picker's
        // click path — see the comment there.
        const def = customWidgetMap.get(data.kind);
        if (resolveWidgetRequiresDataSource(data.kind, def) && sources.length === 0) {
          // Announce the refusal — the empty-state Paper highlighted on hover, so a silent
          // bail reads as "the drop worked and produced nothing". Mirrors `handleDrop`.
          announce(localeText.composeNoDataSources);
          return;
        }
        const newWidget = createWidgetForKind(data.kind, customWidgetMap);
        controller.insertWidgetAt(newWidget, activePageId, [[newWidget.id]]);
        announce(localeText.canvasWidgetAddedAnnouncement);
      } else if (data.type === DRAG_TYPE_CANVAS_WIDGET && data.widgetId) {
        const widgetId: string = data.widgetId;
        const sourcePageId: string | undefined = data.sourcePageId;
        controller.moveWidget(widgetId, sourcePageId ?? activePageId, activePageId, [[widgetId]]);
        announce(localeText.canvasWidgetMovedAnnouncement);
      }
    },
    [activePageId, controller, announce, localeText, customWidgetMap],
  );
  const isEmptyPage = !activePage?.widgetRows?.length;
  const isOverEmptyPage = useStudioDropTarget({
    ref: emptyDropRef,
    canDrop: canDropOnEmptyPage,
    onDrop: handleEmptyPageDrop,
    // Finding 1.4: the empty-state `Paper` this ref attaches to is only rendered
    // in the `isEmptyPage` branch below — a different DOM node than the populated
    // branch's root. Re-run the registration effect on every empty<->populated
    // transition so it re-reads `emptyDropRef.current` instead of staying wired to
    // whatever (or nothing) was mounted when the effect first ran.
    watch: isEmptyPage,
  });

  // Tier3 #10: the empty-state UI used to be a separate early-return branch that rendered
  // ONLY the empty-state `Paper`, skipping the `mountedPageIds` keep-alive container below
  // entirely. Since that container is what keeps every OTHER previously-visited page mounted
  // (via absolute-position + clip-path rather than `display:none`), deleting the last widget
  // on page A while page B was mounted tore B's widgets/pipeline down and restarted its
  // animations on return — defeating the very keep-alive design this component documents.
  // Fix: always render the same keep-alive structure; the empty-state `Paper` is layered
  // alongside it (the active page's own `StudioPageRows` naturally renders nothing for an
  // empty page — see its `widgetRows.length === 0` guard — so nothing else needs to change).
  return (
    <Box
      ref={canvasRefCallback}
      sx={[
        {
          position: 'relative',
          width: '100%',
          p: mode === 'edit' ? 0 : '8px',
          backgroundColor: isEmptyPage
            ? undefined
            : sanitizeCssColor(activePage?.theme?.pageBackground),
          minHeight: '100%',
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      onMouseDown={(event) => {
        // Deselect + notify only when the pointer actually went down on the canvas background.
        //
        // "Background" is decided in two steps, because the DOM check alone is not sufficient.
        //
        // 1. Portals. React 17+ dispatches events along the REACT tree, not the DOM tree, so a
        //    mousedown inside a portal rendered by a canvas descendant (every MUI Menu/Select
        //    /Dialog/Popover, the DataGrid column menu and filter panel, the widget edit and
        //    expand dialogs) bubbles into this handler even though its node lives under
        //    `document.body`. None of MUI's overlay components stop `mousedown`. A portal node
        //    is by construction never a DOM descendant of the canvas root, so one containment
        //    check covers all of them at once — and every genuine background click passes it,
        //    since the pointer really is over this element. Without it, choosing an option from
        //    any of those menus deselected the widget being configured and, via
        //    `onBackgroundClick`, closed the AI chat — aborting an in-flight streamed answer.
        // 2. Non-card in-tree chrome. The date-range bar renders inside this root but is not a
        //    widget card, so its own (non-portalled) controls need an explicit exclusion.
        const target = event.target as HTMLElement;
        if (!event.currentTarget.contains(target)) {
          return;
        }
        if (
          !target.closest('[data-widget-card]') &&
          !target.closest('[data-studio-date-range-bar]')
        ) {
          controller.setSelectedWidget(null);
          onBackgroundClick?.();
        }
      }}
    >
      {/* Date range bar — shown in both modes when the page has date/datetime fields.
          Wrapped with a stable data attribute so the canvas background-click handler can
          exclude interactions with it (see onMouseDown above). */}
      {features.quickFilter && (
        <Box data-studio-date-range-bar="">
          <StudioDateRangeBar />
        </Box>
      )}

      {isEmptyPage && (
        <Paper
          ref={emptyDropRef}
          variant="outlined"
          role="status"
          sx={{
            alignItems: 'center',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            minHeight: 420,
            p: 4,
            borderStyle: 'dashed',
            borderColor: isOverEmptyPage ? 'primary.main' : undefined,
            backgroundColor: isOverEmptyPage ? 'action.hover' : undefined,
            justifyContent: 'center',
          }}
        >
          <Typography variant="h6" color="text.secondary">
            {localeText.canvasEmptyTitle}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            {mode === 'edit'
              ? localeText.canvasEmptyEditModeHint
              : localeText.canvasEmptyViewModeHint}
          </Typography>
        </Paper>
      )}

      {/* Positioning context for the inactive pages. It sits inside the canvas padding, so an
          inactive page's `position: absolute; width: 100%` resolves to the same content width
          as the in-flow active page. Without it the absolute pages would size to the canvas
          padding box (a few px wider), and switching back to a page would resize its charts —
          which x-charts animates, producing a visible flash. Always rendered (even when the
          active page is empty) so every OTHER mounted page stays alive — see Tier3 #10 above. */}
      <Box sx={{ position: 'relative' }}>
        {Object.values(pages).map((page) => {
          if (!mountedPageIds.has(page.id)) {
            return null;
          }
          const isInactivePage = page.id !== activePageId;
          return (
            <Box
              key={page.id}
              // Finding 2.26: an inactive page is only visually hidden (clip-path +
              // zero height + pointerEvents:none below) — none of that removes it from
              // the tab order or the accessibility tree, so Tab could still reach a
              // hidden page's controls (e.g. a `RowResizeHandle`) that a sighted mouse
              // user could never interact with. `inert` removes the whole subtree from
              // both the tab order and the a11y tree in one step; `aria-hidden` is kept
              // alongside it for the (older) browsers/AT combinations that don't yet
              // honor `inert` for accessibility-tree exclusion.
              {...(isInactivePage ? { inert: true, 'aria-hidden': true } : {})}
              sx={
                isInactivePage
                  ? {
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      // Collapse the box to zero height and clip its content. Without this an
                      // absolutely-positioned inactive page keeps its full natural height and
                      // still contributes to the scroll container's scrollHeight, so a taller
                      // previously-visited page leaves a screenful of empty space below a
                      // shorter active page.
                      height: 0,
                      overflow: 'hidden',
                      // clip-path creates a clipping context for all descendants — unlike
                      // visibility:hidden, it cannot be overridden by SVG elements that
                      // have visibility="visible" as a presentation attribute.
                      clipPath: 'inset(100%)',
                      pointerEvents: 'none',
                    }
                  : undefined
              }
            >
              <StudioPageRows
                page={page}
                pageId={page.id}
                mode={mode}
                widgets={widgets}
                dataSources={dataSources}
                customWidgetMap={customWidgetMap}
                canvasWidth={canvasWidth}
                stackBreakpointProp={stackBreakpointProp}
                slotProps={slotProps}
                controller={controller}
                announce={announce}
                localeText={localeText}
              />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});
