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

describe('RowResizeHandle — keyboard splitter protocol', () => {
  it('ArrowRight/ArrowUp grows the left span by one column and commits', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowRight');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 13);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 13, 11);

    onDragMove.mockClear();
    onDragEnd.mockClear();
    pressKey(handle, 'ArrowUp');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 13);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 13, 11);
  });

  it('ArrowLeft/ArrowDown shrinks the left span by one column and commits', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'ArrowLeft');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 11);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 11, 13);

    onDragMove.mockClear();
    onDragEnd.mockClear();
    pressKey(handle, 'ArrowDown');
    expect(onDragMove).toHaveBeenCalledWith('a', 'b', 11);
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 11, 13);
  });

  it('Home commits the minimum left span; End commits the maximum', () => {
    const { handle, onDragEnd } = setup({ leftSpan: 12, rightSpan: 12 });
    pressKey(handle, 'Home');
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 6, 18);

    onDragEnd.mockClear();
    pressKey(handle, 'End');
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 18, 6);
  });

  it('is a no-op at the minimum clamp boundary', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 6, rightSpan: 18 });
    pressKey(handle, 'ArrowLeft');
    pressKey(handle, 'Home');
    expect(onDragMove).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('is a no-op at the maximum clamp boundary', () => {
    const { handle, onDragMove, onDragEnd } = setup({ leftSpan: 18, rightSpan: 6 });
    pressKey(handle, 'ArrowRight');
    pressKey(handle, 'End');
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
    expect(onDragEnd).toHaveBeenCalledWith('a', 'b', 4, 20);

    onDragEnd.mockClear();
    pressKey(handle, 'End');
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
