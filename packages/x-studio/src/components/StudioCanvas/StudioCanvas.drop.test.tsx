import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioWidget, StudioWidgetConfig, StudioDataSource } from '../../models';
import { StudioCanvas } from './StudioCanvas';
import {
  DRAG_TYPE_CANVAS_WIDGET,
  DRAG_TYPE_COMPOSE_WIDGET,
  type StudioDragItem,
} from './studioWidgetDndTypes';

/**
 * Finding 4.1: `StudioPageRows.handleDrop` (the geometry/splice logic behind every
 * canvas drag-and-drop move/insert) had no coverage — existing tests exercise pure
 * helpers, remounting, and controller-level span cleanup, but nothing drives a drop
 * through the actual `InsertionPoint`/`WidgetGap`/`useStudioDropTarget` wiring.
 *
 * jsdom cannot fire real pragmatic-drag-and-drop pointer gestures, so
 * `@atlaskit/pragmatic-drag-and-drop/element/adapter` is mocked: `dropTargetForElements`
 * records `{ element, canDrop, onDrop }` into a registry keyed by element (instead of
 * wiring real native listeners), and `draggable` is stubbed as a no-op registrar (widget
 * cards and compose-drawer items call `useStudioDraggable`, which isn't exercised here).
 * `x-studio`'s vitest project overrides the monorepo-wide `isolate: false` with
 * `isolate: true` (see `vitest.config.jsdom.mts`), so this per-file `vi.mock` cannot leak
 * into other test files.
 *
 * A synthetic drop mirrors pragmatic's real contract: `canDrop` is checked first, and
 * `onDrop` only runs if it returned true.
 */

interface RegisteredTarget {
  element: Element;
  canDrop: (arg: { source: { data: unknown } }) => boolean;
  onDrop: (arg: { source: { data: unknown } }) => void;
}

const { registry } = vi.hoisted(() => ({ registry: new Map<Element, RegisteredTarget>() }));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  dropTargetForElements: (opts: {
    element: Element;
    canDrop: (arg: { source: { data: unknown } }) => boolean;
    onDrop: (arg: { source: { data: unknown } }) => void;
  }) => {
    registry.set(opts.element, opts);
    return () => {
      registry.delete(opts.element);
    };
  },
  draggable: () => () => {},
  monitorForElements: () => () => {},
}));

const { render } = createRenderer();

function makeWidget(id: string, kind: StudioWidget['kind'] = 'text'): StudioWidget {
  const config: StudioWidgetConfig =
    kind === 'text' ? ({ textBody: id } as StudioWidgetConfig) : ({} as StudioWidgetConfig);
  return { id, kind, title: id, config };
}

function makeSource(id: string): StudioDataSource {
  return { id, label: id, fields: [{ id: 'value', label: 'Value', type: 'string' }], rows: [] };
}

/** Registered targets sorted into DOM document order. */
function sortedTargets(): RegisteredTarget[] {
  return Array.from(registry.values()).sort((a, b) => {
    const pos = a.element.compareDocumentPosition(b.element);
    // eslint-disable-next-line no-bitwise
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    // eslint-disable-next-line no-bitwise
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  });
}

/** `WidgetGap` roots carry `data-gap`; `InsertionPoint` roots don't. */
function gaps(): RegisteredTarget[] {
  return sortedTargets().filter((t) => (t.element as HTMLElement).hasAttribute('data-gap'));
}

function insertionPoints(): RegisteredTarget[] {
  return sortedTargets().filter((t) => !(t.element as HTMLElement).hasAttribute('data-gap'));
}

/** Emulates pragmatic's real contract: `canDrop` gates whether `onDrop` runs. Returns whether it dropped. */
function fireDrop(target: RegisteredTarget, item: StudioDragItem): boolean {
  const arg = { source: { data: item as unknown as Record<string, unknown> } };
  if (!target.canDrop(arg)) {
    return false;
  }
  target.onDrop(arg);
  return true;
}

function canvasMoveItem(widgetId: string, sourcePageId: string): StudioDragItem {
  return { type: DRAG_TYPE_CANVAS_WIDGET, widgetId, sourcePageId };
}

function composeItem(kind: StudioWidget['kind']): StudioDragItem {
  return { type: DRAG_TYPE_COMPOSE_WIDGET, kind };
}

beforeEach(() => {
  registry.clear();
  delete document.body.dataset.studioDraggingWidgetId;
});

afterEach(() => {
  delete document.body.dataset.studioDraggingWidgetId;
});

describe('StudioCanvas drag-and-drop geometry (finding 4.1)', () => {
  it('new-row horizontal drop: moves the widget to a fresh row and drops its now-empty old row', () => {
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a'], ['b', 'c']] },
          },
          widgets: { a: makeWidget('a'), b: makeWidget('b'), c: makeWidget('c') },
        },
      },
    });
    const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
    render(<StudioCanvas />, { wrapper });

    // Last insertion point in DOM order is always "below the last row" (horizontal).
    const ips = insertionPoints();
    const belowLastRow = ips[ips.length - 1];
    act(() => {
      const dropped = fireDrop(belowLastRow, canvasMoveItem('a', 'page-1'));
      expect(dropped).toBe(true);
    });

    expect(moveWidgetSpy).toHaveBeenCalledWith('a', 'page-1', 'page-1', [['b', 'c'], ['a']]);
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['b', 'c'], ['a']]);
  });

  it('into-row vertical drop: splices a new widget into an existing row at the gap index', () => {
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a', 'b']] },
          },
          widgets: { a: makeWidget('a'), b: makeWidget('b') },
        },
      },
    });
    const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
    render(<StudioCanvas />, { wrapper });

    const widgetIdsBefore = new Set(Object.keys(controller.getState().doc.widgets));
    // Gaps sorted in DOM order for row ['a','b']: [between a&b, after b].
    const betweenAB = gaps()[0];
    act(() => {
      const dropped = fireDrop(betweenAB, composeItem('text'));
      expect(dropped).toBe(true);
    });

    expect(insertWidgetAtSpy).toHaveBeenCalledTimes(1);
    const newId = Object.keys(controller.getState().doc.widgets).find(
      (id) => !widgetIdsBefore.has(id),
    );
    expect(newId).toBeDefined();
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a', newId, 'b']]);
  });

  it('prior-occurrence removal: moving a widget already elsewhere in the row set removes it from its old spot first', () => {
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a', 'b'], ['c']] },
          },
          widgets: { a: makeWidget('a'), b: makeWidget('b'), c: makeWidget('c') },
        },
      },
    });
    const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
    render(<StudioCanvas />, { wrapper });

    const betweenAB = gaps()[0];
    act(() => {
      const dropped = fireDrop(betweenAB, canvasMoveItem('c', 'page-1'));
      expect(dropped).toBe(true);
    });

    expect(moveWidgetSpy).toHaveBeenCalledWith('c', 'page-1', 'page-1', [['a', 'c', 'b']]);
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a', 'c', 'b']]);
  });

  it('cross-page move: moving a widget from an unmounted source page updates both pages', () => {
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          dashboard: { id: 'd', title: 'D', activePageId: 'page-2' },
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['x']] },
            'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['a', 'b']] },
          },
          widgets: { x: makeWidget('x'), a: makeWidget('a'), b: makeWidget('b') },
        },
      },
    });
    const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
    render(<StudioCanvas />, { wrapper });

    // Only page-2 (active) is mounted, so the registry only has page-2's targets.
    const betweenAB = gaps()[0];
    act(() => {
      const dropped = fireDrop(betweenAB, canvasMoveItem('x', 'page-1'));
      expect(dropped).toBe(true);
    });

    expect(moveWidgetSpy).toHaveBeenCalledWith('x', 'page-1', 'page-2', [['a', 'x', 'b']]);
    const state = controller.getState();
    expect(state.doc.pages['page-2'].widgetRows).toEqual([['a', 'x', 'b']]);
    expect(state.doc.pages['page-1'].widgetRows).toEqual([]);
  });

  it('compose drop accepted: a data-source-exempt kind (text) is inserted with zero data sources', () => {
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a']] } },
          widgets: { a: makeWidget('a') },
        },
        runtime: { dataSources: {} },
      },
    });
    const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
    render(<StudioCanvas />, { wrapper });

    const widgetIdsBefore = new Set(Object.keys(controller.getState().doc.widgets));
    const ips = insertionPoints();
    const belowLastRow = ips[ips.length - 1];
    act(() => {
      const dropped = fireDrop(belowLastRow, composeItem('text'));
      expect(dropped).toBe(true);
    });

    expect(insertWidgetAtSpy).toHaveBeenCalledTimes(1);
    const newId = Object.keys(controller.getState().doc.widgets).find(
      (id) => !widgetIdsBefore.has(id),
    );
    expect(newId).toBeDefined();
    expect(controller.getState().doc.widgets[newId!].kind).toBe('text');
  });

  it('compose drop rejected: a data-requiring kind with zero data sources is a no-op', () => {
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a']] } },
          widgets: { a: makeWidget('a') },
        },
        runtime: { dataSources: {} },
      },
    });
    const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
    render(<StudioCanvas />, { wrapper });

    const widgetsBefore = controller.getState().doc.widgets;
    const ips = insertionPoints();
    const belowLastRow = ips[ips.length - 1];
    act(() => {
      // canDrop is true (data-source gating happens inside handleDrop, not canDrop) but
      // the drop must still be a no-op.
      const dropped = fireDrop(belowLastRow, composeItem('kpi'));
      expect(dropped).toBe(true);
    });

    expect(insertWidgetAtSpy).not.toHaveBeenCalled();
    expect(controller.getState().doc.widgets).toEqual(widgetsBefore);
  });

  it('compose drop accepted when a data source exists for a data-requiring kind', () => {
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a']] } },
          widgets: { a: makeWidget('a') },
        },
        runtime: { dataSources: { s1: makeSource('s1') } },
      },
    });
    const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
    render(<StudioCanvas />, { wrapper });

    const ips = insertionPoints();
    const belowLastRow = ips[ips.length - 1];
    act(() => {
      fireDrop(belowLastRow, composeItem('kpi'));
    });

    expect(insertWidgetAtSpy).toHaveBeenCalledTimes(1);
  });

  it('canDrop guards: an active drag disables adjacent-to-self gaps and redundant same-row insertion points', () => {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a'], ['b']] },
          },
          widgets: { a: makeWidget('a'), b: makeWidget('b') },
        },
      },
    });
    render(<StudioCanvas />, { wrapper });

    document.body.dataset.studioDraggingWidgetId = 'a';
    const draggingItem = canvasMoveItem('a', 'page-1');
    const arg = { source: { data: draggingItem as unknown as Record<string, unknown> } };

    const ips = insertionPoints();
    const gs = gaps();
    // DOM order for [['a'],['b']]: IP(h,r0) IP(v,r0,c0) Gap(r0,c1) IP(h,r1) IP(v,r1,c0)
    // Gap(r1,c1) IP(h,r2)
    expect(ips).toHaveLength(5);
    expect(gs).toHaveLength(2);
    const [ipAboveR0, ipBeforeA, ipBelowR0BeforeR1, ipBeforeB, ipBelowR1] = ips;
    const [gapAfterA, gapAfterB] = gs;

    // Adjacent-to-self / redundant same-row targets are disabled.
    expect(gapAfterA.canDrop(arg)).toBe(false);
    expect(ipBeforeA.canDrop(arg)).toBe(false);
    expect(ipAboveR0.canDrop(arg)).toBe(false);
    expect(ipBelowR0BeforeR1.canDrop(arg)).toBe(false);

    // Unrelated targets remain droppable.
    expect(ipBeforeB.canDrop(arg)).toBe(true);
    expect(gapAfterB.canDrop(arg)).toBe(true);
    expect(ipBelowR1.canDrop(arg)).toBe(true);
  });

  // Regression tests for finding 1.12: `handleDrop`'s `DRAG_TYPE_CANVAS_WIDGET`
  // branch removed the dragged widget from its row BEFORE splicing at the gap's
  // pre-removal `colIndex`. For a same-row RIGHTWARD move, the removal shifts every
  // later id left by one, so the insertion index ends up one slot too far right.
  describe('same-row move geometry (finding 1.12)', () => {
    it('rightward: dragging the first widget onto the gap between the 2nd and 3rd lands it in the middle, not last', () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: {
            pages: {
              'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a', 'b', 'c']] },
            },
            widgets: { a: makeWidget('a'), b: makeWidget('b'), c: makeWidget('c') },
          },
        },
      });
      const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
      render(<StudioCanvas />, { wrapper });

      // Gaps in DOM order for row ['a','b','c']: [after a, after b (i.e. between b
      // and c), after c].
      const gapBetweenBAndC = gaps()[1];
      act(() => {
        const dropped = fireDrop(gapBetweenBAndC, canvasMoveItem('a', 'page-1'));
        expect(dropped).toBe(true);
      });

      // Before the fix this produced ['b', 'c', 'a'] — filtering 'a' out first
      // shifted 'c' left into the slot the pre-removal gap index pointed at.
      expect(moveWidgetSpy).toHaveBeenCalledWith('a', 'page-1', 'page-1', [['b', 'a', 'c']]);
      expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['b', 'a', 'c']]);
    });

    it('rightward to the very end: dragging the first widget onto the last gap lands it last', () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: {
            pages: {
              'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a', 'b', 'c']] },
            },
            widgets: { a: makeWidget('a'), b: makeWidget('b'), c: makeWidget('c') },
          },
        },
      });
      const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
      render(<StudioCanvas />, { wrapper });

      const gapAfterC = gaps()[2];
      act(() => {
        const dropped = fireDrop(gapAfterC, canvasMoveItem('a', 'page-1'));
        expect(dropped).toBe(true);
      });

      expect(moveWidgetSpy).toHaveBeenCalledWith('a', 'page-1', 'page-1', [['b', 'c', 'a']]);
      expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['b', 'c', 'a']]);
    });

    it('leftward moves are unaffected: dragging the last widget onto the first gap still lands correctly', () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: {
            pages: {
              'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a', 'b', 'c']] },
            },
            widgets: { a: makeWidget('a'), b: makeWidget('b'), c: makeWidget('c') },
          },
        },
      });
      const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
      render(<StudioCanvas />, { wrapper });

      const gapBetweenAAndB = gaps()[0];
      act(() => {
        const dropped = fireDrop(gapBetweenAAndB, canvasMoveItem('c', 'page-1'));
        expect(dropped).toBe(true);
      });

      expect(moveWidgetSpy).toHaveBeenCalledWith('c', 'page-1', 'page-1', [['a', 'c', 'b']]);
      expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a', 'c', 'b']]);
    });
  });
});
