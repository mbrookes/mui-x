'use client';

import * as React from 'react';
import { Box } from '@mui/material';

import { MIN_SPAN } from './canvasGridConstants';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { useStudioAnnounce } from '../../internals/StudioLiveRegion';
import { useStudioSelector } from '../../context';
import type { StudioState } from '../../models';
import type { StudioWidgetKind } from '../../models/baseTypes';
import { useWidgetKindLabels } from '../StudioComposeDrawer/StudioComposeDrawerLabels';
import { lookup } from '../../utils/safeLookup';

interface RowResizeHandleProps {
  leftId: string;
  rightId: string;
  leftSpan: number;
  rightSpan: number;
  leftMinSpan?: number;
  rightMinSpan?: number;
  onDragMove: (leftId: string, rightId: string, leftSpanLive: number) => void;
  onDragEnd: (leftId: string, rightId: string, leftSpan: number, rightSpan: number) => void;
  /**
   * Called when an in-progress pointer drag is cancelled (`pointercancel`, or a
   * `lostpointercapture` that isn't the tail end of a normal pointerup) instead of
   * completed. Rollback only — never commits a span change, so a cancelled gesture
   * never lands on the undo stack.
   */
  onDragCancel: (leftId: string, rightId: string) => void;
}

// Between-widget column resize handle — sits in the gap between two flex siblings
export function RowResizeHandle({
  leftId,
  rightId,
  leftSpan,
  rightSpan,
  leftMinSpan = MIN_SPAN,
  rightMinSpan = MIN_SPAN,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: RowResizeHandleProps) {
  const totalSpan = leftSpan + rightSpan;
  const localeText = useStudioLocaleText();
  const announce = useStudioAnnounce();
  // Titles of the two widgets this handle sits between. A dashboard row can hold several
  // handles and a page several rows, so a bare "Resize columns" name repeated N times tells
  // a screen-reader user nothing about which boundary they have landed on. Read from the
  // store rather than threaded through props so the name stays correct after a rename.
  // `widgetId` is doc-authored, hence the prototype-chain-safe `lookup` (see `selectors.ts`).
  const selectLeftTitle = React.useMemo(
    () => (state: StudioState) => lookup(state.doc.widgets, leftId)?.title ?? '',
    [leftId],
  );
  const selectRightTitle = React.useMemo(
    () => (state: StudioState) => lookup(state.doc.widgets, rightId)?.title ?? '',
    [rightId],
  );
  // Kinds, so an UNTITLED neighbour still contributes something to the accessible name.
  // Selected as separate primitives rather than one `{ title, kind }` object per side:
  // `useStudioSelector` compares by reference, so a freshly allocated object every render
  // would defeat its bail-out.
  const selectLeftKind = React.useMemo(
    () => (state: StudioState) => lookup(state.doc.widgets, leftId)?.kind,
    [leftId],
  );
  const selectRightKind = React.useMemo(
    () => (state: StudioState) => lookup(state.doc.widgets, rightId)?.kind,
    [rightId],
  );
  const widgetKindLabels = useWidgetKindLabels();
  const describeNeighbour = (title: string, kind: StudioWidgetKind | undefined): string => {
    if (title) {
      return title;
    }
    if (!kind) {
      return '';
    }
    // "Untitled Chart" — the same translated phrasing the edit dialog and the card header
    // use for a widget with no title, rather than dropping the neighbour from the name.
    return localeText.widgetUntitledLabel(lookup(widgetKindLabels, kind) ?? kind);
  };
  const leftStoredTitle = useStudioSelector(selectLeftTitle);
  const rightStoredTitle = useStudioSelector(selectRightTitle);
  const leftKind = useStudioSelector(selectLeftKind);
  const rightKind = useStudioSelector(selectRightKind);
  const leftTitle = describeNeighbour(leftStoredTitle, leftKind);
  const rightTitle = describeNeighbour(rightStoredTitle, rightKind);
  const dragRef = React.useRef<{
    combinedLeft: number;
    combinedWidth: number;
    totalSpan: number;
  } | null>(null);
  const [active, setActive] = React.useState(false);
  // Uncommitted span of an in-progress KEYBOARD resize. `null` = no keyboard session.
  // A pointer drag pushes exactly ONE undoable mutation for the whole gesture; the
  // keyboard path used to push one PER ARROW KEYPRESS, so nudging a widget five columns
  // buried five entries on the undo stack and forced five Ctrl+Z to undo one intent.
  // Mirror the pointer model instead: each keypress only previews (`onDragMove`), and
  // the session commits once when it ends (blur, or Enter), or rolls back on Escape.
  const [pendingLeft, setPendingLeft] = React.useState<number | null>(null);

  const minLeft = leftMinSpan;
  // A pair whose two minimum spans exceed its combined span cannot be resized at all:
  // `totalSpan - rightMinSpan` drops BELOW `leftMinSpan`, `stepSpan`'s
  // `max(minLeft, min(maxLeft, …))` collapses to the constant `minLeft`, and every arrow
  // key and pointer drag silently becomes a no-op — with `aria-valuemin > aria-valuemax`
  // advertising an impossible range to assistive tech. `MAX_PER_ROW` on the drop paths
  // removes the way users used to reach this (a 5th widget in a row), but a raised minimum
  // can still create it after the fact — toggling a KPI's sparkline on lifts its min-span
  // from 4 to 6. Report the state honestly (`aria-disabled`, a non-inverted range) and
  // refuse the gesture rather than pretending to accept it.
  const isResizable = totalSpan - rightMinSpan >= leftMinSpan;
  const maxLeft = Math.max(leftMinSpan, totalSpan - rightMinSpan);
  // What the handle currently represents — the uncommitted keyboard value while a
  // keyboard session is open, otherwise the committed span.
  const effectiveLeft = pendingLeft ?? leftSpan;
  // `leftSpan` is a prop derived from the doc; clamp before publishing it as
  // `aria-valuenow` so it can never sit outside the min/max the same element advertises.
  const ariaValueNow = Math.max(minLeft, Math.min(maxLeft, effectiveLeft));

  // Keyboard step: preview only. Never calls `onDragEnd`, so nothing reaches the undo stack
  // until the session is flushed below.
  const stepSpan = React.useCallback(
    (nextLeft: number) => {
      if (!isResizable) {
        return;
      }
      const clamped = Math.max(minLeft, Math.min(maxLeft, nextLeft));
      if (clamped === effectiveLeft) {
        return;
      }
      setPendingLeft(clamped);
      onDragMove(leftId, rightId, clamped);
      announce(localeText.canvasResizeAnnouncement(clamped, totalSpan));
    },
    [
      isResizable,
      minLeft,
      maxLeft,
      effectiveLeft,
      leftId,
      rightId,
      totalSpan,
      onDragMove,
      announce,
      localeText,
    ],
  );

  // End a keyboard session: commit the accumulated span as ONE mutation, or roll back if it
  // ended up back where it started (committing an identical span would push an undo entry
  // for a no-op).
  const flushKeyboard = React.useCallback(() => {
    if (pendingLeft === null) {
      return;
    }
    setPendingLeft(null);
    if (pendingLeft === leftSpan) {
      onDragCancel(leftId, rightId);
      return;
    }
    onDragEnd(leftId, rightId, pendingLeft, totalSpan - pendingLeft);
  }, [pendingLeft, leftSpan, leftId, rightId, totalSpan, onDragEnd, onDragCancel]);

  const cancelKeyboard = React.useCallback(() => {
    if (pendingLeft === null) {
      return;
    }
    setPendingLeft(null);
    onDragCancel(leftId, rightId);
  }, [pendingLeft, leftId, rightId, onDragCancel]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          event.preventDefault();
          stepSpan(effectiveLeft - 1);
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          event.preventDefault();
          stepSpan(effectiveLeft + 1);
          break;
        case 'Home':
          event.preventDefault();
          stepSpan(minLeft);
          break;
        case 'End':
          event.preventDefault();
          stepSpan(maxLeft);
          break;
        case 'Enter':
          event.preventDefault();
          flushKeyboard();
          break;
        case 'Escape':
          event.preventDefault();
          cancelKeyboard();
          break;
        default:
          break;
      }
    },
    [stepSpan, flushKeyboard, cancelKeyboard, effectiveLeft, minLeft, maxLeft],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Nothing to redistribute — see `isResizable`. Starting the gesture would let the
      // pointer move the divider visually and then commit a span the clamp can't honour.
      if (!isResizable) {
        return;
      }
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
      const combinedWidth = rightRect.right - leftRect.left;
      // Guard the divisor. Both boxes measure 0 wide whenever the row is laid out but not
      // painted — a `display: none` ancestor, a not-yet-measured virtualised row, or a
      // zero-width container — and every span computation below divides by this. A 0 (or
      // non-finite) width makes `fraction` NaN/±Infinity, `Math.round(NaN)` NaN, and both
      // `Math.min`/`Math.max` propagate it, so `onDragEnd` would commit `NaN` spans straight
      // into the doc: the row's flex-grow values become NaN and the whole row collapses,
      // undoably but invisibly. Refuse to start the gesture instead.
      if (!Number.isFinite(combinedWidth) || combinedWidth <= 0) {
        return;
      }
      // A pointer gesture supersedes any half-finished keyboard session. Dropping the pending
      // value is not enough: the parent's `liveDrag` is what actually drives the row's flex
      // values and the column-divider overlay, and it was set by the keyboard session's
      // `onDragMove`. Without the matching `onDragCancel` the row stayed pinned to the
      // abandoned preview until this drag's first `pointermove` happened to overwrite it —
      // and if the gesture ended without ever moving, forever. Roll the session back
      // explicitly, then let this drag's own geometry decide the final spans.
      cancelKeyboard();
      dragRef.current = {
        combinedLeft: leftRect.left,
        combinedWidth,
        totalSpan,
      };
      setActive(true);
      handle.setPointerCapture(event.pointerId);
    },
    [isResizable, totalSpan, cancelKeyboard],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const fraction = (event.clientX - drag.combinedLeft) / drag.combinedWidth;
      const minFrac = leftMinSpan / drag.totalSpan;
      const maxFrac = (drag.totalSpan - rightMinSpan) / drag.totalSpan;
      const clamped = Math.max(minFrac, Math.min(maxFrac, fraction));
      // Snap at midpoint: jump to the next column when the mouse crosses 50% between columns
      const leftSpanLive = Math.max(
        leftMinSpan,
        Math.min(drag.totalSpan - rightMinSpan, Math.round(clamped * drag.totalSpan)),
      );
      onDragMove(leftId, rightId, leftSpanLive);
    },
    [leftId, rightId, leftMinSpan, rightMinSpan, onDragMove],
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
      const minFrac = leftMinSpan / drag.totalSpan;
      const maxFrac = (drag.totalSpan - rightMinSpan) / drag.totalSpan;
      const clamped = Math.max(minFrac, Math.min(maxFrac, fraction));
      const snappedLeft = Math.max(
        leftMinSpan,
        Math.min(drag.totalSpan - rightMinSpan, Math.round(clamped * drag.totalSpan)),
      );
      const snappedRight = drag.totalSpan - snappedLeft;
      onDragEnd(leftId, rightId, snappedLeft, snappedRight);
    },
    [leftId, rightId, leftMinSpan, rightMinSpan, onDragEnd],
  );

  // Rollback path for `pointercancel` / `lostpointercapture` — never commits a span
  // change (that would push a spurious entry onto the undo stack for a gesture the
  // user didn't complete). Idempotent: a normal pointerup already nulls `dragRef`
  // before releasing capture, so the `lostpointercapture` event that follows
  // `releasePointerCapture` hits this no-op guard instead of double-firing.
  const abortDrag = React.useCallback(() => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    setActive(false);
    onDragCancel(leftId, rightId);
  }, [leftId, rightId, onDragCancel]);

  // Unmount teardown. Every other exit from an open session is an event ON this element —
  // blur / Enter / Escape for keyboard, pointerup / pointercancel / lostpointercapture for
  // pointer — and none of them fire when the handle is simply removed from the tree, e.g. an
  // AI mutation streaming in a `setWidgetLayout` that collapses the row while the user is
  // mid-nudge. The parent's `liveDrag` would then keep the row rendering uncommitted spans
  // and the grid-line overlay with no control left to clear them.
  //
  // Rolls back rather than commits: the geometry the gesture was measured against is gone,
  // so committing its spans would write a value the user never confirmed into a row that has
  // already changed shape. Kept in a ref updated each render so the effect can stay
  // mount-only and still see the live session state.
  const cleanupRef = React.useRef<(() => void) | undefined>(undefined);
  cleanupRef.current = () => {
    if (pendingLeft === null && !dragRef.current) {
      return;
    }
    dragRef.current = null;
    onDragCancel(leftId, rightId);
  };
  React.useEffect(() => () => cleanupRef.current?.(), []);

  const resizeLabel = localeText.canvasResizeColumnsAriaLabel;
  const flankingTitles = [leftTitle, rightTitle].filter(Boolean).join(' / ');

  return (
    <Box
      data-resize-handle
      role="separator"
      aria-orientation="vertical"
      // The translated action name, disambiguated by the widgets it sits between so each
      // handle on the page gets a distinct accessible name. Composed with punctuation only —
      // no untranslated words are introduced — matching how `StudioQuickFilterBar` builds
      // "FieldLabel: summary". An untitled neighbour contributes its translated kind
      // ("Untitled Chart", via `describeNeighbour`) rather than dropping out; the bare
      // action name is only reached when a neighbour is missing from the doc entirely.
      aria-label={flankingTitles ? `${resizeLabel}: ${flankingTitles}` : resizeLabel}
      aria-valuemin={minLeft}
      aria-valuemax={maxLeft}
      // Reflects the uncommitted keyboard value while a keyboard session is open, so a
      // screen reader tracks the preview rather than the last committed span.
      aria-valuenow={ariaValueNow}
      // A bare "14" tells a screen-reader user nothing — 14 of what? Publish the same
      // human-readable, translated "Column resized to N of M" string the live region
      // announces on each step, so the value is intelligible on focus, not only on change.
      aria-valuetext={localeText.canvasResizeAnnouncement(ariaValueNow, totalSpan)}
      // Focusable (so it stays discoverable and its state is readable) but inoperable when
      // the pair's minimums leave nothing to redistribute.
      aria-disabled={isResizable ? undefined : true}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      // Leaving the handle ends any open keyboard session — a Tab away must not strand an
      // uncommitted preview (the canvas would keep rendering `liveDrag` forever).
      onBlur={flushKeyboard}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={abortDrag}
      onLostPointerCapture={abortDrag}
      sx={{
        position: 'absolute',
        inset: 0,
        cursor: 'col-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
        '&:hover .rh-bar, &[data-active] .rh-bar, &:focus-visible .rh-bar': {
          opacity: 1,
          bgcolor: 'primary.main',
        },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
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
