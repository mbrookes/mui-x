import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useStudioDraggable } from './useStudioDraggable';
import { DRAG_TYPE_CANVAS_WIDGET } from './studioWidgetDndTypes';

// Capture the config passed to pragmatic-dnd's `draggable` so the test can drive
// `onDragStart`/`onDrop` directly (jsdom has no real pointer drag). The mock returns a
// spy cleanup so we can assert the draggable is unregistered on unmount / `canDrag` flip.
const cleanupSpy = vi.fn();
const registrations: unknown[] = [];
let lastDraggableConfig: {
  getInitialData?: () => Record<string, unknown>;
  onDragStart?: () => void;
  onDrop?: () => void;
} | null = null;

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: {
    getInitialData?: () => Record<string, unknown>;
    onDragStart?: () => void;
    onDrop?: () => void;
  }) => {
    lastDraggableConfig = config;
    registrations.push(config);
    return cleanupSpy;
  },
}));

const { render } = createRenderer();

function Draggable({
  canDrag,
  onDragStart,
  onDrop,
  widgetId = 'w1',
}: {
  canDrag: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  widgetId?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useStudioDraggable({
    ref,
    canDrag,
    getData: () => ({ type: DRAG_TYPE_CANVAS_WIDGET, widgetId, sourcePageId: 'p1' }),
    onDragStart,
    onDrop,
  });
  return <div ref={ref} />;
}

describe('useStudioDraggable', () => {
  beforeEach(() => {
    cleanupSpy.mockClear();
    registrations.length = 0;
    lastDraggableConfig = null;
  });

  it('runs onDrop on unmount when a drag is still in flight (regression: leaked drag state)', () => {
    const onDragStart = vi.fn();
    const onDrop = vi.fn();
    const { unmount } = render(<Draggable canDrag onDragStart={onDragStart} onDrop={onDrop} />);

    // Simulate a drag that starts but never receives a drop event before teardown.
    act(() => {
      lastDraggableConfig?.onDragStart?.();
    });
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();

    act(() => {
      unmount();
    });

    // The effect cleanup must both unregister the draggable and run the drop handler so
    // side effects the caller set up in onDragStart (body flags, inline styles) are released.
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('runs onDrop when canDrag flips off mid-drag (e.g. leaving edit mode)', () => {
    const onDrop = vi.fn();
    const { setProps } = render(<Draggable canDrag onDragStart={vi.fn()} onDrop={onDrop} />);

    act(() => {
      lastDraggableConfig?.onDragStart?.();
    });
    expect(onDrop).not.toHaveBeenCalled();

    // Flipping canDrag off re-runs the effect, whose cleanup should release the drag.
    act(() => {
      setProps({ canDrag: false });
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('does not run onDrop on unmount when no drag is in flight', () => {
    const onDrop = vi.fn();
    const { unmount } = render(<Draggable canDrag onDragStart={vi.fn()} onDrop={onDrop} />);

    act(() => {
      unmount();
    });
    expect(onDrop).not.toHaveBeenCalled();
  });

  // ── Registration-time capture ────────────────────────────────────────────────
  //
  // pragmatic-drag-and-drop takes `getInitialData`/`onDragStart`/`onDrop` ONCE, when the
  // draggable is registered, and `react-hooks/exhaustive-deps` cannot see into that call —
  // so a stale closure over a prop here is invisible to lint AND to review by pattern
  // matching. The registration effect deliberately depends only on `[ref, canDrag]` (so it
  // doesn't churn on every render), which makes reading every callback through a ref the
  // property the whole design rests on.

  it('serializes the LATEST drag data, not the data captured at registration', () => {
    const { setProps } = render(<Draggable canDrag onDragStart={vi.fn()} onDrop={vi.fn()} />);
    expect(lastDraggableConfig?.getInitialData?.()).toMatchObject({ widgetId: 'w1' });

    // The registration effect must NOT re-run here — this only passes because `getData` is
    // read through a ref at drag time. (The count is not asserted absolutely:
    // `createRenderer` renders under StrictMode, which double-invokes the mount effect.)
    const registrationsAtMount = registrations.length;
    setProps({ widgetId: 'w2' });
    expect(registrations).toHaveLength(registrationsAtMount);
    expect(lastDraggableConfig?.getInitialData?.()).toMatchObject({ widgetId: 'w2' });
  });

  it('calls the LATEST onDragStart/onDrop, not the ones captured at registration', () => {
    const firstStart = vi.fn();
    const firstDrop = vi.fn();
    const { setProps } = render(<Draggable canDrag onDragStart={firstStart} onDrop={firstDrop} />);

    const registrationsAtMount = registrations.length;
    const secondStart = vi.fn();
    const secondDrop = vi.fn();
    setProps({ onDragStart: secondStart, onDrop: secondDrop });
    expect(registrations).toHaveLength(registrationsAtMount);

    act(() => {
      lastDraggableConfig?.onDragStart?.();
      lastDraggableConfig?.onDrop?.();
    });

    expect(firstStart).not.toHaveBeenCalled();
    expect(firstDrop).not.toHaveBeenCalled();
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(secondDrop).toHaveBeenCalledTimes(1);
  });

  it('runs the LATEST onDrop when torn down mid-drag', () => {
    const firstDrop = vi.fn();
    const { setProps, unmount } = render(
      <Draggable canDrag onDragStart={vi.fn()} onDrop={firstDrop} />,
    );

    act(() => {
      lastDraggableConfig?.onDragStart?.();
    });

    // The card re-renders mid-drag (the canvas re-renders constantly during one) and hands
    // the hook a new `onDrop`. The teardown release path must use that one, or it would
    // clear the drag session of whatever the component looked like at registration.
    const secondDrop = vi.fn();
    setProps({ onDrop: secondDrop });

    act(() => {
      unmount();
    });

    expect(firstDrop).not.toHaveBeenCalled();
    expect(secondDrop).toHaveBeenCalledTimes(1);
  });

  it('does not run onDrop twice when a normal drop precedes teardown', () => {
    const onDrop = vi.fn();
    const { unmount } = render(<Draggable canDrag onDragStart={vi.fn()} onDrop={onDrop} />);

    act(() => {
      lastDraggableConfig?.onDragStart?.();
      lastDraggableConfig?.onDrop?.();
    });
    expect(onDrop).toHaveBeenCalledTimes(1);

    act(() => {
      unmount();
    });
    // Teardown after a completed drop must not fire onDrop a second time.
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});
