import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useStudioDraggable } from './useStudioDraggable';
import { DRAG_TYPE_CANVAS_WIDGET } from './studioWidgetDndTypes';

// Capture the config passed to pragmatic-dnd's `draggable` so the test can drive
// `onDragStart`/`onDrop` directly (jsdom has no real pointer drag). The mock returns a
// spy cleanup so we can assert the draggable is unregistered on unmount / `canDrag` flip.
const cleanupSpy = vi.fn();
let lastDraggableConfig: {
  onDragStart?: () => void;
  onDrop?: () => void;
} | null = null;

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: { onDragStart?: () => void; onDrop?: () => void }) => {
    lastDraggableConfig = config;
    return cleanupSpy;
  },
}));

const { render } = createRenderer();

function Draggable({
  canDrag,
  onDragStart,
  onDrop,
}: {
  canDrag: boolean;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useStudioDraggable({
    ref,
    canDrag,
    getData: () => ({ type: DRAG_TYPE_CANVAS_WIDGET, widgetId: 'w1', sourcePageId: 'p1' }),
    onDragStart,
    onDrop,
  });
  return <div ref={ref} />;
}

describe('useStudioDraggable', () => {
  beforeEach(() => {
    cleanupSpy.mockClear();
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
