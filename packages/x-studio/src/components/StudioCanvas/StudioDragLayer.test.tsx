import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StudioDragLayer } from './StudioDragLayer';
import { DRAG_TYPE_CANVAS_WIDGET } from './studioWidgetDndTypes';

/**
 * `StudioDragLayer` registers a single pragmatic-drag-and-drop monitor that toggles
 * `x-studio-dnd-active` on `document.documentElement` for the duration of a widget drag.
 * jsdom can't fire real drags, so the adapter is mocked and the monitor's callbacks are
 * driven directly.
 */
interface RegisteredMonitor {
  canMonitor: (arg: { source: { data: unknown } }) => boolean;
  onDragStart: () => void;
  onDrop: () => void;
}

const { monitors, cleanupSpy } = vi.hoisted(() => ({
  monitors: [] as RegisteredMonitor[],
  cleanupSpy: { calls: 0 },
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  monitorForElements: (opts: RegisteredMonitor) => {
    monitors.push(opts);
    return () => {
      cleanupSpy.calls += 1;
      monitors.splice(monitors.indexOf(opts), 1);
    };
  },
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
}));

const { render } = createRenderer();

const ACTIVE_CLASS = 'x-studio-dnd-active';

describe('StudioDragLayer', () => {
  beforeEach(() => {
    monitors.length = 0;
    cleanupSpy.calls = 0;
    document.documentElement.classList.remove(ACTIVE_CLASS);
  });

  afterEach(() => {
    document.documentElement.classList.remove(ACTIVE_CLASS);
  });

  it('only monitors studio drag items', () => {
    render(<StudioDragLayer />);
    const monitor = monitors[0];

    expect(
      monitor.canMonitor({
        source: { data: { type: DRAG_TYPE_CANVAS_WIDGET, widgetId: 'w1', sourcePageId: 'p1' } },
      }),
    ).toBe(true);
    expect(monitor.canMonitor({ source: { data: { type: 'some-other-library' } } })).toBe(false);
  });

  it('toggles the cursor class for the duration of a drag', () => {
    render(<StudioDragLayer />);
    const monitor = monitors[0];

    act(() => monitor.onDragStart());
    expect(document.documentElement.classList.contains(ACTIVE_CLASS)).toBe(true);

    // Pragmatic dispatches the monitor's `onDrop` for a cancelled drag too, so this is
    // also the cancel path.
    act(() => monitor.onDrop());
    expect(document.documentElement.classList.contains(ACTIVE_CLASS)).toBe(false);
  });

  it('clears the cursor class when unmounted mid-drag', () => {
    const { unmount } = render(<StudioDragLayer />);
    const monitor = monitors[0];

    act(() => monitor.onDragStart());
    expect(document.documentElement.classList.contains(ACTIVE_CLASS)).toBe(true);

    // A host route change (or `<Studio>` being conditionally rendered away) while a widget
    // is in the air. The class lives on `<html>`, OUTSIDE this component's tree, so
    // unregistering the monitor does not undo it: it used to stay latched forever, and the
    // next Studio to mount re-injected the `cursor: move !important` rules on top of it.
    const cleanupsBefore = cleanupSpy.calls;
    act(() => unmount());

    expect(cleanupSpy.calls).toBeGreaterThan(cleanupsBefore);
    expect(document.documentElement.classList.contains(ACTIVE_CLASS)).toBe(false);
  });

  it('leaves the document untouched when unmounted while idle', () => {
    const before = document.documentElement.className;
    const { unmount } = render(<StudioDragLayer />);
    act(() => unmount());
    expect(document.documentElement.className).toBe(before);
  });
});
