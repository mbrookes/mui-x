import * as React from 'react';
import { createRenderer, screen, fireEvent, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RowResizeHandle } from './RowResizeHandle';

/**
 * `RowResizeHandle` has zero test coverage (finding 4.2) and its `pointercancel`/
 * `lostpointercapture` teardown paths didn't exist before this file was written
 * (finding 1.9) — before that fix, a cancelled drag left `dragRef`/`active` stuck
 * forever (see cases 11-13 below, which fail without the `onPointerCancel`/
 * `onLostPointerCapture` wiring on the root Box).
 *
 * `RowResizeHandle` renders with safe context defaults (`useStudioLocaleText`/
 * `useStudioAnnounce` both fall back without a provider), so no wrapper is needed.
 *
 * jsdom implements neither pointer capture nor real layout, so:
 *  - `setPointerCapture`/`releasePointerCapture` are stubbed on `HTMLElement.prototype`.
 *  - The handle is rendered inside a three-sibling structure (left box / gap div
 *    containing the handle / right box) with `getBoundingClientRect` stubbed
 *    directly on the two flanking boxes, mirroring how `handlePointerDown` looks
 *    up `gap.previousElementSibling`/`gap.nextElementSibling`.
 */

const { render } = createRenderer();

interface HarnessProps {
  leftSpan?: number;
  rightSpan?: number;
  leftMinSpan?: number;
  rightMinSpan?: number;
  onDragMove: (leftId: string, rightId: string, leftSpanLive: number) => void;
  onDragEnd: (leftId: string, rightId: string, leftSpan: number, rightSpan: number) => void;
  onDragCancel: (leftId: string, rightId: string) => void;
}

function Harness({
  leftSpan = 12,
  rightSpan = 12,
  leftMinSpan,
  rightMinSpan,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: HarnessProps) {
  return (
    <div>
      <div data-testid="left-box" />
      <div data-testid="gap">
        <RowResizeHandle
          leftId="a"
          rightId="b"
          leftSpan={leftSpan}
          rightSpan={rightSpan}
          leftMinSpan={leftMinSpan}
          rightMinSpan={rightMinSpan}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        />
      </div>
      <div data-testid="right-box" />
    </div>
  );
}

function makeRect(partial: Partial<DOMRect>): DOMRect {
  return {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...partial,
  } as DOMRect;
}

type HarnessSpanProps = Pick<
  HarnessProps,
  'leftSpan' | 'rightSpan' | 'leftMinSpan' | 'rightMinSpan'
>;

/** Set up the handle with a combined rect spanning [0, 480] (24 columns => 20px/col). */
function setup(props: HarnessSpanProps = {}) {
  const onDragMove = vi.fn();
  const onDragEnd = vi.fn();
  const onDragCancel = vi.fn();
  const view = render(
    <Harness
      {...props}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    />,
  );
  const leftBox = screen.getByTestId('left-box');
  const rightBox = screen.getByTestId('right-box');
  leftBox.getBoundingClientRect = () => makeRect({ left: 0, right: 0 });
  rightBox.getBoundingClientRect = () => makeRect({ left: 480, right: 480 });
  const handle = screen.getByRole('separator');
  return { ...view, handle, onDragMove, onDragEnd, onDragCancel };
}

beforeEach(() => {
  // jsdom does not implement pointer capture.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

/**
 * `fireEvent.keyDown` requires the target to actually be `document.activeElement`
 * (see the repo's `SliderControl.test.tsx` for the same pattern) — `fireEvent.focus`
 * doesn't move `document.activeElement` in jsdom, so the native `.focus()` (wrapped
 * in `act`) is used instead.
 */
function pressKey(handle: HTMLElement, key: string) {
  act(() => {
    handle.focus();
  });
  fireEvent.keyDown(handle, { key });
}

/**
 * A keyboard resize is a SESSION, not a series of commits (finding: one undoable mutation
 * per arrow keypress, where a whole pointer drag pushes exactly one). Each key only
 * previews via `onDragMove`; the session commits once via `onDragEnd` when it ends — blur
 * or Enter — and rolls back via `onDragCancel` on Escape.
 */
describe('RowResizeHandle — keyboard splitter protocol', () => {
  it('ArrowRight/ArrowUp previews a one-column growth without committing', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowRight');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 13);
    expect(onDragEnd).not.toHaveBeenCalled();

    onDragMove.mockClear();
    // The pending value is the session's own accumulator, so a second key steps from 13.
    pressKey(handle, 'ArrowUp');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 14);
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('ArrowLeft/ArrowDown previews a one-column shrink without committing', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowLeft');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 11);
    expect(onDragEnd).not.toHaveBeenCalled();

    onDragMove.mockClear();
    pressKey(handle, 'ArrowDown');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 10);
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  // The regression this whole protocol exists for: five nudges used to be five undoable
  // mutations, so undoing one intent took five Ctrl+Z.
  it('commits a multi-keypress session as exactly ONE mutation on blur', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'ArrowRight');
    expect(onDragMove).toHaveBeenCalledTimes(3);
    expect(onDragEnd).not.toHaveBeenCalled();

    fireEvent.blur(handle);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 15, 9);
  });

  it('commits the session on Enter as well as blur, and only once', () => {
    const { handle, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'Enter');
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 13, 11);

    // The session is closed — a following blur must not commit a second time.
    fireEvent.blur(handle);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('Escape rolls the session back without committing', () => {
    const { handle, onDragEnd, onDragCancel } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'Escape');
    expect(onDragCancel).toHaveBeenCalledWith('a', 'b');
    expect(onDragEnd).not.toHaveBeenCalled();

    // And the rolled-back session leaves nothing behind for a later blur to commit.
    fireEvent.blur(handle);
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('a session that ends back at the starting span rolls back instead of committing a no-op', () => {
    const { handle, onDragEnd, onDragCancel } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'ArrowLeft');
    fireEvent.blur(handle);
    // Committing an identical span would still push an undo entry for a no-op.
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onDragCancel).toHaveBeenCalledWith('a', 'b');
  });

  it('a blur with no keyboard session fires nothing', () => {
    const { handle, onDragEnd, onDragCancel } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.blur(handle);
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onDragCancel).not.toHaveBeenCalled();
  });

  it('Home previews the minimum left span; End previews the maximum, each committed on blur', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'Home');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 6);
    fireEvent.blur(handle);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 6, 18);

    onDragEnd.mockClear();
    pressKey(handle, 'End');
    fireEvent.blur(handle);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 18, 6);
  });

  it('is a no-op at the minimum clamp boundary', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 6, rightSpan: 18 });
    pressKey(handle, 'ArrowLeft');
    pressKey(handle, 'Home');
    fireEvent.blur(handle);
    expect(onDragMove).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('is a no-op at the maximum clamp boundary', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 18, rightSpan: 6 });
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'End');
    fireEvent.blur(handle);
    expect(onDragMove).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('respects custom min spans (KPI case)', () => {
    const { handle, onDragEnd } = setup({
      leftSpan: 12,
      rightSpan: 12,
      leftMinSpan: 4,
      rightMinSpan: 4,
    });
    pressKey(handle, 'Home');
    fireEvent.blur(handle);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 4, 20);

    onDragEnd.mockClear();
    pressKey(handle, 'End');
    fireEvent.blur(handle);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 20, 4);
  });

  it('exposes the APG splitter ARIA contract', () => {
    const { handle } = setup({ leftSpan: 12, rightSpan: 12 });
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-valuemin')).toBe('6');
    expect(handle.getAttribute('aria-valuemax')).toBe('18');
    expect(handle.getAttribute('aria-valuenow')).toBe('12');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  it('tracks the uncommitted keyboard preview in aria-valuenow', () => {
    const { handle } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowRight');
    // A screen reader must follow the preview, not the last committed span — otherwise the
    // announced value contradicts what the canvas is showing for the whole session.
    expect(handle.getAttribute('aria-valuenow')).toBe('13');
  });
});

describe('RowResizeHandle — pointer midpoint snapping', () => {
  it('snaps at the column midpoint while dragging', () => {
    const { handle, onDragMove } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240 });

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 249 });
    expect(onDragMove).toHaveBeenLastCalledWith('a', 'b', 12);

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });
    expect(onDragMove).toHaveBeenLastCalledWith('a', 'b', 13);
  });

  it('clamps live span to the min/max columns at the drag extremes', () => {
    const { handle, onDragMove } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240 });

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(onDragMove).toHaveBeenLastCalledWith('a', 'b', 6);

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480 });
    expect(onDragMove).toHaveBeenLastCalledWith('a', 'b', 18);
  });

  it('commits on pointerup, releases capture, and clears active state', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 250 });
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 13, 11);
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(handle.hasAttribute('data-active')).toBe(false);

    onDragMove.mockClear();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(onDragMove).not.toHaveBeenCalled();
  });

  it('pointermove without a prior pointerdown fires no callbacks', () => {
    const { handle, onDragMove } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });
    expect(onDragMove).not.toHaveBeenCalled();
  });
});

describe('RowResizeHandle — pointercancel / lostpointercapture (finding 1.9)', () => {
  it('pointercancel aborts the drag: onDragCancel fires, onDragEnd never does', () => {
    const { handle, onDragMove, onDragEnd, onDragCancel } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });
    expect(onDragMove).toHaveBeenCalled();

    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(onDragCancel).toHaveBeenCalledTimes(1);
    expect(onDragCancel).toHaveBeenCalledWith('a', 'b');
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(handle.hasAttribute('data-active')).toBe(false);

    onDragMove.mockClear();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(onDragMove).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 });
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('lostpointercapture (without a preceding pointerup) aborts the drag the same way', () => {
    const { handle, onDragEnd, onDragCancel } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240 });

    fireEvent.lostPointerCapture(handle, { pointerId: 1 });

    expect(onDragCancel).toHaveBeenCalledTimes(1);
    expect(onDragCancel).toHaveBeenCalledWith('a', 'b');
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(handle.hasAttribute('data-active')).toBe(false);
  });

  it('is idempotent: a lostpointercapture that follows a normal pointerup does not re-fire onDragCancel', () => {
    const { handle, onDragEnd, onDragCancel } = setup({ leftSpan: 12, rightSpan: 12 });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 250 });
    expect(onDragEnd).toHaveBeenCalledTimes(1);

    // Browsers fire `lostpointercapture` right after `releasePointerCapture` — dragRef
    // is already null by this point, so the handler must no-op.
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });

    expect(onDragCancel).not.toHaveBeenCalled();
  });
});


/**
 * Every span computation divides by the combined width of the two flanking boxes. That
 * width is 0 whenever the row is laid out but unpainted (a `display: none` ancestor, a
 * not-yet-measured row, a zero-width container) — and `x / 0` propagates NaN/±Infinity
 * through `Math.round`, `Math.min` and `Math.max` all the way into `onDragEnd`, which
 * commits the NaN spans into the doc and collapses the row, undoably but invisibly.
 */
describe('RowResizeHandle — zero-width row guard', () => {
  function setupZeroWidth() {
    const onDragMove = vi.fn();
    const onDragEnd = vi.fn();
    const onDragCancel = vi.fn();
    const view = render(
      <Harness
        leftSpan={12}
        rightSpan={12}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      />,
    );
    // Both boxes collapsed onto the same x → combined width 0.
    screen.getByTestId('left-box').getBoundingClientRect = () => makeRect({ left: 0, right: 0 });
    screen.getByTestId('right-box').getBoundingClientRect = () => makeRect({ left: 0, right: 0 });
    return { ...view, handle: screen.getByRole('separator'), onDragMove, onDragEnd, onDragCancel };
  }

  it('refuses to start a drag when the two boxes have no combined width', () => {
    const { handle, onDragMove, onDragEnd } = setupZeroWidth();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    // No gesture started, so the handle never enters its active state...
    expect(handle.hasAttribute('data-active')).toBe(false);

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10 });

    // ...and nothing — least of all a NaN span — reaches the doc.
    expect(onDragMove).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('never emits a NaN span from any pointer callback', () => {
    const { handle, onDragMove, onDragEnd } = setupZeroWidth();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 0 });

    const emitted = [...onDragMove.mock.calls, ...onDragEnd.mock.calls].flatMap((args) =>
      args.filter((arg) => typeof arg === 'number'),
    );
    expect(emitted.every((n) => Number.isFinite(n))).toBe(true);
  });
});
