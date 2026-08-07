import * as React from 'react';
import { createRenderer, act, waitFor } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MIN_SPAN } from '@mui/x-studio-schema';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioHarness } from '../../internals/test-utils';
import { StudioLiveRegionProvider } from '../../internals/StudioLiveRegion';
import type {
  StudioCustomWidgetDef,
  StudioWidget,
  StudioWidgetConfig,
  StudioDataSource,
} from '../../models';
import { StudioCanvas } from './StudioCanvas';
import { resolveResizePair } from './rowColSpans';
import {
  DRAG_TYPE_CANVAS_WIDGET,
  DRAG_TYPE_COMPOSE_WIDGET,
  type StudioDragItem,
} from './studioWidgetDndTypes';
import { clearDraggingWidgetId, setDraggingWidgetId } from './studioDragSession';
import { MAX_PER_ROW } from './canvasGridConstants';

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
    const { controller, wrapper } = createStudioHarness({
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

    // The "which widget is being dragged" flag is scoped to the Studio instance (its
    // controller), not to `document` — see `studioDragSession.ts`.
    setDraggingWidgetId(controller, 'a');
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

  // Regression tests for finding 2.11: an empty page (`widgetRows: []`, or reached by
  // deleting the last widget of a page) had no registered drop target at all — neither
  // `StudioPageRows` nor its `InsertionPoint`/`WidgetGap` children are rendered when
  // `widgetRows.length === 0`, yet the edit-mode empty-state copy explicitly invites
  // dropping ("...or drag them here") and `WidgetTypeCard` registers a real
  // `DRAG_TYPE_COMPOSE_WIDGET` draggable. `StudioCanvas` now registers a drop target
  // directly on the empty-state `Paper`.
  describe('empty-page drop target (finding 2.11)', () => {
    it('registers exactly one drop target on the empty-state Paper', () => {
      const { wrapper } = createStudioHarness({
        initialState: {
          doc: { pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } } },
        },
      });
      render(<StudioCanvas />, { wrapper });

      expect(registry.size).toBe(1);
    });

    it('dropping a compose widget type on an empty page inserts it into a fresh single row', () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: { pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } } },
          runtime: { dataSources: { s1: makeSource('s1') } },
        },
      });
      const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
      render(<StudioCanvas />, { wrapper });

      const widgetIdsBefore = new Set(Object.keys(controller.getState().doc.widgets));
      const [target] = Array.from(registry.values());
      act(() => {
        const dropped = fireDrop(target, composeItem('text'));
        expect(dropped).toBe(true);
      });

      expect(insertWidgetAtSpy).toHaveBeenCalledTimes(1);
      const newId = Object.keys(controller.getState().doc.widgets).find(
        (id) => !widgetIdsBefore.has(id),
      );
      expect(newId).toBeDefined();
      expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([[newId]]);
    });

    it('moving an existing widget from another page onto an empty page places it in a fresh single row', () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: {
            dashboard: { id: 'd', title: 'D', activePageId: 'page-2' },
            pages: {
              'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['x']] },
              'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
            },
            widgets: { x: makeWidget('x') },
          },
        },
      });
      const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
      render(<StudioCanvas />, { wrapper });

      const [target] = Array.from(registry.values());
      act(() => {
        const dropped = fireDrop(target, canvasMoveItem('x', 'page-1'));
        expect(dropped).toBe(true);
      });

      expect(moveWidgetSpy).toHaveBeenCalledWith('x', 'page-1', 'page-2', [['x']]);
      expect(controller.getState().doc.pages['page-2'].widgetRows).toEqual([['x']]);
    });

    it('a data-requiring compose kind with zero data sources is a no-op on an empty page', () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: { pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } } },
          runtime: { dataSources: {} },
        },
      });
      const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
      render(<StudioCanvas />, { wrapper });

      const widgetsBefore = controller.getState().doc.widgets;
      const [target] = Array.from(registry.values());
      act(() => {
        // canDrop is true (data-source gating happens inside the drop handler, not
        // canDrop) but the drop must still be a no-op.
        const dropped = fireDrop(target, composeItem('kpi'));
        expect(dropped).toBe(true);
      });

      expect(insertWidgetAtSpy).not.toHaveBeenCalled();
      expect(controller.getState().doc.widgets).toEqual(widgetsBefore);
    });

    it('is not a drop target in view mode', () => {
      const { wrapper } = createStudioHarness({
        initialState: {
          session: { mode: 'view' },
          doc: { pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } } },
        },
      });
      render(<StudioCanvas />, { wrapper });

      const [target] = Array.from(registry.values());
      const dropped = fireDrop(target, composeItem('text'));
      expect(dropped).toBe(false);
    });
  });

  // Regression tests for finding 1.4: `useStudioDropTarget`'s registration effect
  // used to depend on `[ref]` only. `emptyDropRef` is a plain `React.useRef` whose
  // identity never changes, but the empty-state `Paper` it attaches to is rendered
  // by a branch of `StudioCanvas` that's mutually exclusive with the populated
  // branch — so the very first empty<->populated transition after mount left the
  // effect referencing whatever `emptyDropRef.current` was (or wasn't) the first
  // time it ran, and the drop target never (re)registered. `useStudioDropTarget`
  // now accepts a `watch` value (here, `isEmptyPage`) that forces the effect to
  // re-run and re-read `ref.current` on every branch swap.
  describe('empty-page drop target survives a populated -> empty transition (finding 1.4)', () => {
    it('registers the empty-state drop target after the last widget is removed, and a drop still works', () => {
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

      // While populated, nothing is registered on the (unmounted) empty-state Paper.
      expect(registry.size).toBeGreaterThan(0);
      const populatedTargets = new Set(registry.keys());

      // Delete the last widget on the page — the canvas swaps from the populated
      // branch to the empty-state branch.
      act(() => {
        controller.removeWidget('a');
      });
      expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([]);

      // Every populated-branch target (InsertionPoint/WidgetGap) unmounted, and
      // exactly the new empty-state target is registered in its place — this is
      // the assertion that fails without the fix (registry stays empty forever,
      // since the drop-target effect never re-ran to pick up the newly-attached
      // `emptyDropRef.current`).
      for (const target of populatedTargets) {
        expect(registry.has(target)).toBe(false);
      }
      expect(registry.size).toBe(1);

      const [emptyTarget] = Array.from(registry.values());
      act(() => {
        const dropped = fireDrop(emptyTarget, composeItem('text'));
        expect(dropped).toBe(true);
      });

      expect(insertWidgetAtSpy).toHaveBeenCalledTimes(1);
      const newId = Object.keys(controller.getState().doc.widgets).find((id) => id !== 'a');
      expect(newId).toBeDefined();
      expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([[newId]]);
    });

    it('keeps working across repeated populated <-> empty transitions', () => {
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: {
            pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a']] } },
            widgets: { a: makeWidget('a') },
          },
        },
      });
      render(<StudioCanvas />, { wrapper });

      act(() => {
        controller.removeWidget('a');
      });
      expect(registry.size).toBe(1);

      // Re-populate, then empty it again — the drop target must still track the
      // branch correctly the second time around, not just the first transition.
      act(() => {
        const [b] = ['b'];
        controller.insertWidgetAt(makeWidget(b), 'page-1', [[b]]);
      });
      expect(registry.size).toBeGreaterThan(0);
      expect(
        Array.from(registry.values()).every(
          (t) => !(t.element as HTMLElement).matches('[role="status"]'),
        ),
      ).toBe(true);

      act(() => {
        controller.removeWidget('b');
      });
      expect(registry.size).toBe(1);
      const [emptyTarget] = Array.from(registry.values());
      expect((emptyTarget.element as HTMLElement).getAttribute('role')).toBe('status');
    });
  });

  // ── Finding H2: MAX_PER_ROW was enforced on the keyboard and duplicate paths, but the
  // mouse drop path spliced into a row with no cap at all. A fifth widget drops every
  // span to `round(24/5) = 5` (below MIN_SPAN), which inverts every divider's
  // `minLeft`/`maxLeft` and wedges every resize handle in the row permanently.
  describe('row capacity (finding H2)', () => {
    /** A page whose single row is already at `MAX_PER_ROW`. */
    function fullRowHarness() {
      const ids = Array.from({ length: MAX_PER_ROW }, (_, i) => `w${i}`);
      return {
        ids,
        ...createStudioHarness({
          initialState: {
            doc: {
              pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [ids, ['spare']] } },
              widgets: Object.fromEntries(
                [...ids, 'spare'].map((id) => [id, makeWidget(id)]),
              ) as Record<string, StudioWidget>,
            },
          },
        }),
      };
    }

    it('refuses a compose drop into a row already holding MAX_PER_ROW widgets', () => {
      const { controller, wrapper } = fullRowHarness();
      const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
      render(<StudioCanvas />, { wrapper });

      // The full row's own gaps and its leading vertical insertion point.
      const fullRowGaps = gaps().slice(0, MAX_PER_ROW);
      const item = composeItem('text');
      for (const gap of fullRowGaps) {
        expect(fireDrop(gap, item)).toBe(false);
      }
      expect(insertWidgetAtSpy).not.toHaveBeenCalled();
    });

    it('refuses moving a widget in from another row, but still allows reordering inside the row', () => {
      const { ids, controller, wrapper } = fullRowHarness();
      const moveWidgetSpy = vi.spyOn(controller, 'moveWidget');
      render(<StudioCanvas />, { wrapper });

      const fullRowGaps = gaps().slice(0, MAX_PER_ROW);
      // An outsider would grow the row past its cap — rejected.
      expect(fireDrop(fullRowGaps[0], canvasMoveItem('spare', 'page-1'))).toBe(false);
      expect(moveWidgetSpy).not.toHaveBeenCalled();

      // A widget ALREADY in the row is a reorder, not an addition: the row's length is
      // unchanged, so it must stay droppable. (The gaps immediately flanking the dragged
      // widget are separately disabled by `isAdjacentToDraggingWidget`; this is a
      // non-adjacent one.)
      act(() => {
        expect(fireDrop(fullRowGaps[MAX_PER_ROW - 1], canvasMoveItem(ids[0], 'page-1'))).toBe(true);
      });
      expect(moveWidgetSpy).toHaveBeenCalledTimes(1);
      const rows = controller.getState().doc.pages['page-1'].widgetRows;
      expect(rows[0]).toHaveLength(MAX_PER_ROW);
    });

    it('a drop that bypasses canDrop splits into a new row instead of overflowing', () => {
      const { ids, controller, wrapper } = fullRowHarness();
      render(<StudioCanvas />, { wrapper });

      // Bypass the `canDrop` gate the way a programmatic (or cross-instance) drop would,
      // exercising `insertIntoRow`'s defense-in-depth fallback directly.
      const fullRowGaps = gaps().slice(0, MAX_PER_ROW);
      act(() => {
        fullRowGaps[1].onDrop({
          source: { data: canvasMoveItem('spare', 'page-1') as unknown as Record<string, unknown> },
        });
      });

      const rows = controller.getState().doc.pages['page-1'].widgetRows;
      // Every row is within the cap, and nothing was lost.
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(MAX_PER_ROW);
      }
      expect(rows.flat().sort()).toEqual([...ids, 'spare'].sort());

      // ...and no divider anywhere in the resulting layout is wedged: `RowResizeHandle`
      // computes `minLeft = leftMinSpan`, `maxLeft = totalSpan - rightMinSpan`, so an
      // over-dense row would hand it `6 > 4` and make every arrow key a no-op forever.
      const spans = controller.getState().doc.pages['page-1'].widgetColSpans;
      for (const row of rows) {
        for (let i = 0; i < row.length - 1; i += 1) {
          const pair = resolveResizePair(row, spans, i, MIN_SPAN, MIN_SPAN);
          expect(pair.totalSpan - MIN_SPAN).toBeGreaterThanOrEqual(MIN_SPAN);
        }
      }
    });
  });

  // ── Finding M12: `handleDrop` bailed silently when a data-requiring widget kind was
  // dropped with zero data sources. The drop target had highlighted, so the gesture looked
  // accepted; the success branch announced and the failure branch said nothing at all.
  describe('failed drops announce (finding M12)', () => {
    function liveRegionText(): string {
      const region = document.querySelector('[aria-live="polite"]');
      return region?.textContent ?? '';
    }

    it('announces when a data-requiring kind is dropped with no data sources', async () => {
      const { wrapper } = createStudioHarness({
        initialState: {
          doc: {
            pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a']] } },
            widgets: { a: makeWidget('a') },
          },
          runtime: { dataSources: {} },
        },
      });
      render(
        <StudioLiveRegionProvider>
          <StudioCanvas />
        </StudioLiveRegionProvider>,
        { wrapper },
      );

      const ips = insertionPoints();
      act(() => {
        expect(fireDrop(ips[ips.length - 1], composeItem('kpi'))).toBe(true);
      });

      await waitFor(() => {
        expect(liveRegionText()).toBe(DEFAULT_STUDIO_LOCALE_TEXT.composeNoDataSources);
      });
    });

    it('announces the same refusal on an empty page', async () => {
      const { wrapper } = createStudioHarness({
        initialState: {
          doc: { pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } } },
          runtime: { dataSources: {} },
        },
      });
      render(
        <StudioLiveRegionProvider>
          <StudioCanvas />
        </StudioLiveRegionProvider>,
        { wrapper },
      );

      const [target] = Array.from(registry.values());
      act(() => {
        expect(fireDrop(target, composeItem('kpi'))).toBe(true);
      });

      await waitFor(() => {
        expect(liveRegionText()).toBe(DEFAULT_STUDIO_LOCALE_TEXT.composeNoDataSources);
      });
    });
  });

  // ── Finding M22: the drag session used to be `document.body.dataset`, a document-level
  // singleton. Two Studios on one page share widget ids, so dragging `w1` in instance A
  // disabled the gaps flanking instance B's untouched copy of `w1`.
  describe('multi-instance drag state (finding M22)', () => {
    function twoWidgetHarness() {
      return createStudioHarness({
        initialState: {
          doc: {
            pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1', 'w2']] } },
            widgets: { w1: makeWidget('w1'), w2: makeWidget('w2') },
          },
        },
      });
    }

    it("a drag in one Studio leaves a second Studio's identical rows fully droppable", () => {
      const instanceA = twoWidgetHarness();
      const instanceB = twoWidgetHarness();
      const { container: containerA } = render(<StudioCanvas />, { wrapper: instanceA.wrapper });
      const { container: containerB } = render(<StudioCanvas />, { wrapper: instanceB.wrapper });

      setDraggingWidgetId(instanceA.controller, 'w1');
      const arg = {
        source: { data: canvasMoveItem('w1', 'page-1') as unknown as Record<string, unknown> },
      };

      // Partitioning the registered drop targets by which instance rendered them is the
      // whole point of the test, and a drop target has no accessible role to query by —
      // hence the container containment checks.
      /* eslint-disable testing-library/no-container */
      const inA = (t: RegisteredTarget) => containerA.contains(t.element);
      const inB = (t: RegisteredTarget) => containerB.contains(t.element);
      /* eslint-enable testing-library/no-container */
      const [gapAfterW1InA] = gaps().filter(inA);
      const [gapAfterW1InB] = gaps().filter(inB);

      // A knows `w1` is mid-drag, so the gap right after it is a no-op target.
      expect(gapAfterW1InA.canDrop(arg)).toBe(false);
      // B is not part of that gesture and must not be affected by it.
      expect(gapAfterW1InB.canDrop(arg)).toBe(true);

      clearDraggingWidgetId(instanceA.controller);
      expect(gapAfterW1InA.canDrop(arg)).toBe(true);
    });
  });

  // ── Custom widget kinds: the drop path must create them exactly like the picker does.
  // `WidgetTypeCard` registers a `DRAG_TYPE_COMPOSE_WIDGET` draggable for EVERY picker entry,
  // built-in and custom alike, so a custom kind has two creation paths. The click path
  // resolved `def.requiresDataSource ?? false` and passed `{ title: def.label, customConfig:
  // def.defaultConfig }`; both drop paths called the kind-derived
  // `widgetKindRequiresDataSource` (`kind !== 'text'`, i.e. `true` for every custom kind) and
  // a bare `createDefaultWidget(kind)`. So a dropped custom widget lost its `defaultConfig`
  // and got the raw kind string as its title (unrecoverable for a kind with no `setupPanel`),
  // and a source-less custom kind was click-addable but its drop was refused.
  describe('custom widget kinds: drop path matches the picker (createWidgetForKind)', () => {
    const weatherDef: StudioCustomWidgetDef = {
      kind: 'weather-tile',
      label: 'Weather tile',
      description: 'Current conditions',
      defaultConfig: { units: 'metric', city: 'Paris' },
      component: () => <div>weather</div>,
    };
    const feedDef: StudioCustomWidgetDef = {
      kind: 'live-feed',
      label: 'Live feed',
      requiresDataSource: true,
      component: () => <div>feed</div>,
    };
    const providerProps = { customWidgets: [weatherDef, feedDef] };

    function populatedHarness(dataSources: Record<string, StudioDataSource> = {}) {
      return createStudioHarness({
        initialState: {
          doc: {
            pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a']] } },
            widgets: { a: makeWidget('a') },
          },
          runtime: { dataSources },
        },
        providerProps,
      });
    }

    function emptyHarness(dataSources: Record<string, StudioDataSource> = {}) {
      return createStudioHarness({
        initialState: {
          doc: { pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } } },
          runtime: { dataSources },
        },
        providerProps,
      });
    }

    /** The single widget the drop just added. */
    function addedWidget(controller: StudioHarness['controller'], before: Set<string>) {
      const widgets = controller.getState().doc.widgets;
      const id = Object.keys(widgets).find((wid) => !before.has(wid));
      expect(id).toBeDefined();
      return widgets[id!];
    }

    it('applies the def label and defaultConfig when dropped onto a populated page', () => {
      // A data source exists so the assertions below isolate title/`defaultConfig` from the
      // `requiresDataSource` default (covered separately).
      const { controller, wrapper } = populatedHarness({ s1: makeSource('s1') });
      render(<StudioCanvas />, { wrapper });

      const before = new Set(Object.keys(controller.getState().doc.widgets));
      const ips = insertionPoints();
      act(() => {
        expect(fireDrop(ips[ips.length - 1], composeItem('weather-tile'))).toBe(true);
      });

      const added = addedWidget(controller, before);
      expect(added.kind).toBe('weather-tile');
      expect(added.title).toBe('Weather tile');
      expect((added.config as StudioWidgetConfig).customConfig).toEqual({
        units: 'metric',
        city: 'Paris',
      });
    });

    it('applies the def label and defaultConfig when dropped onto an empty page', () => {
      const { controller, wrapper } = emptyHarness({ s1: makeSource('s1') });
      render(<StudioCanvas />, { wrapper });

      const before = new Set(Object.keys(controller.getState().doc.widgets));
      const [target] = Array.from(registry.values());
      act(() => {
        expect(fireDrop(target, composeItem('weather-tile'))).toBe(true);
      });

      const added = addedWidget(controller, before);
      expect(added.title).toBe('Weather tile');
      expect((added.config as StudioWidgetConfig).customConfig).toEqual({
        units: 'metric',
        city: 'Paris',
      });
    });

    it('accepts a source-less custom kind with zero data sources (populated page)', () => {
      const { controller, wrapper } = populatedHarness();
      const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
      render(<StudioCanvas />, { wrapper });

      const ips = insertionPoints();
      act(() => {
        expect(fireDrop(ips[ips.length - 1], composeItem('weather-tile'))).toBe(true);
      });

      expect(insertWidgetAtSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts a source-less custom kind with zero data sources (empty page)', () => {
      const { controller, wrapper } = emptyHarness();
      const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
      render(<StudioCanvas />, { wrapper });

      const [target] = Array.from(registry.values());
      act(() => {
        expect(fireDrop(target, composeItem('weather-tile'))).toBe(true);
      });

      expect(insertWidgetAtSpy).toHaveBeenCalledTimes(1);
    });

    it('still refuses a custom kind that declares requiresDataSource with zero sources', () => {
      const { controller, wrapper } = populatedHarness();
      const insertWidgetAtSpy = vi.spyOn(controller, 'insertWidgetAt');
      render(<StudioCanvas />, { wrapper });

      const ips = insertionPoints();
      act(() => {
        expect(fireDrop(ips[ips.length - 1], composeItem('live-feed'))).toBe(true);
      });

      expect(insertWidgetAtSpy).not.toHaveBeenCalled();
    });

    it('leaves built-in kinds untouched (no title/customConfig injection)', () => {
      const { controller, wrapper } = populatedHarness({ s1: makeSource('s1') });
      render(<StudioCanvas />, { wrapper });

      const before = new Set(Object.keys(controller.getState().doc.widgets));
      const ips = insertionPoints();
      act(() => {
        expect(fireDrop(ips[ips.length - 1], composeItem('kpi'))).toBe(true);
      });

      const added = addedWidget(controller, before);
      expect(added.kind).toBe('kpi');
      expect(added.title).toBe('');
      expect((added.config as StudioWidgetConfig).customConfig).toBeUndefined();
    });
  });
});
