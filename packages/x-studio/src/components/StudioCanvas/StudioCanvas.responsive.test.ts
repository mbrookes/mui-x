import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * Unit tests for the BL-154 responsive span calculation.
 *
 * Three tiers based on canvasWidth vs stackBreakpoint (B):
 *   canvasWidth ≥ 2B  → effectiveSpan = span (normal)
 *   B ≤ width < 2B   → effectiveSpan = min(span * 2, GRID_COLS)  (half-stacked, 2-up)
 *   width < B         → effectiveSpan = GRID_COLS               (fully stacked, 1-up)
 *
 * This math is computed inline inside `StudioCanvas`'s render (derived from the
 * `mode`/`canvasWidth`/`stackBreakpoint` props+state, not a standalone
 * function), so — per the guidance for embedded render logic — these tests
 * render the real `StudioCanvas` component and assert on the rendered widget
 * wrapper's computed `max-width`/`flex` style, rather than recomputing the
 * tiers in a hand-copied helper.
 *
 * `StudioCanvas` doesn't have real layout in jsdom, so canvasWidth is driven
 * directly through a stubbed `ResizeObserver` whose callback we invoke with a
 * synthetic `contentRect.width`.
 */

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'responsive-test-probe', title: id, config: {} as StudioWidgetConfig };
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  private callback: ResizeObserverCallback;

  /** The element passed to the most recent `observe()` call, if still observed. */
  observedTarget: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observedTarget = target;
  }

  unobserve() {
    this.observedTarget = null;
  }

  disconnect() {
    this.observedTarget = null;
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  /** Simulate the canvas being resized to `width` px. */
  fire(width: number) {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/**
 * Among every `FakeResizeObserver` ever constructed, find the one (if any) whose
 * `observedTarget` is still attached to the document. Under the finding-1.4 bug
 * (registration effect keyed on a `RefObject` whose identity never changes across
 * the empty<->populated branch swap), the original observer's `observedTarget`
 * keeps pointing at whichever branch's root was mounted when the effect first
 * ran — once that branch unmounts, the node is detached, and no live observer
 * for the current canvas root exists at all.
 */
function findConnectedObserver(): FakeResizeObserver | undefined {
  return FakeResizeObserver.instances.find(
    (instance) => instance.observedTarget && document.body.contains(instance.observedTarget),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(mode: 'edit' | 'view', stackBreakpoint: number) {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      session: { mode },
      doc: {
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'Page 1',
            // Two single-widget rows so each widget's flex-basis only depends on
            // its own span, not on siblings sharing the row.
            widgetRows: [['w1'], ['w2']],
            widgetColSpans: { w1: 6, w2: 12 },
          },
        },
        widgets: { w1: makeWidget('w1'), w2: makeWidget('w2') },
      },
    },
  });
  // `render`'s type expects a JSX-literal-shaped `ReactElement<DataAttributes>`; this file
  // stays `.ts` (no JSX) so the element is built with `React.createElement` and widened here.
  const element: React.ReactElement<any> = React.createElement(StudioCanvas, { stackBreakpoint });
  const view = render(element, { wrapper });
  return {
    ...view,
    controller,
    observer: FakeResizeObserver.instances[0] as FakeResizeObserver | undefined,
  };
}

/** Computed style of the flex/max-width wrapper `StudioCanvas` renders around a widget's card. */
function wrapperStyle(container: HTMLElement, widgetId: string): CSSStyleDeclaration {
  const paper = container.querySelector(`[data-widget-id="${widgetId}"]`);
  if (!paper) {
    throw new Error(`widget ${widgetId} not found`);
  }
  // Paper (StudioWidgetCard root) -> StudioWidgetCard's outer Box -> StudioCanvas's flex wrapper Box.
  const flexBox = paper.parentElement?.parentElement as HTMLElement;
  return getComputedStyle(flexBox);
}

/**
 * Fire a synthetic resize and flush it through. `useResizeObserver` defers the
 * actual state update via `requestAnimationFrame` in test/dev environments
 * (see `@mui/x-internals/useResizeObserver`), so firing the observer alone
 * isn't enough — the update only lands after that frame runs.
 */
async function resize(observer: FakeResizeObserver | undefined, width: number) {
  if (!observer) {
    throw new Error('no ResizeObserver was created — is the canvas in an enabled state?');
  }
  await act(async () => {
    observer.fire(width);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

describe('StudioCanvas responsive tiers (BL-154)', () => {
  const B = 600; // stackBreakpoint used by these tests

  it('normal tier (canvasWidth >= 2B): flex-basis reflects the stored span unmodified', async () => {
    const { container, observer } = setup('view', B);
    await resize(observer, 1400);

    // span=6 of 24 -> 25%, gap adjustment 8 * (1 - 6/24) = 6px
    expect(wrapperStyle(container, 'w1').maxWidth).toBe('calc(25% - 6px)');
    // span=12 of 24 -> 50%, gap adjustment 8 * (1 - 12/24) = 4px
    expect(wrapperStyle(container, 'w2').maxWidth).toBe('calc(50% - 4px)');
  });

  it('half-stacked tier (B <= canvasWidth < 2B): span doubles, capped at GRID_COLS', async () => {
    const { container, observer } = setup('view', B);
    await resize(observer, 900);

    // span 6 -> 12 -> 50%
    expect(wrapperStyle(container, 'w1').maxWidth).toBe('calc(50% - 4px)');
    // span 12 -> 24 (capped) -> 100%
    expect(wrapperStyle(container, 'w2').maxWidth).toBe('100%');
  });

  it('half-stacked tier at exactly canvasWidth = B is included in the tier', async () => {
    const { container, observer } = setup('view', B);
    await resize(observer, B);

    expect(wrapperStyle(container, 'w1').maxWidth).toBe('calc(50% - 4px)');
  });

  it('fully-stacked tier (canvasWidth < B): every widget goes full width', async () => {
    const { container, observer } = setup('view', B);
    await resize(observer, 400);

    expect(wrapperStyle(container, 'w1').maxWidth).toBe('100%');
    expect(wrapperStyle(container, 'w2').maxWidth).toBe('100%');
  });

  it('edit mode: tiers are not applied — no max-width clamp regardless of canvas width', () => {
    // Edit mode disables the resize observer entirely (`enabled = mode !== 'edit' && ...`),
    // so canvasWidth never leaves `null` — exercising exactly the "edit mode ignores
    // stacking" real-component behavior, not a synthetic bypass.
    const { container } = setup('edit', B);

    expect(wrapperStyle(container, 'w1').maxWidth).toBe('none');
    expect(wrapperStyle(container, 'w2').maxWidth).toBe('none');
  });

  it('breakpoint=0: stacking disabled regardless of canvas width', () => {
    // stackBreakpoint=0 also disables the resize observer (`effectiveBreakpoint !== 0`),
    // so the widget falls back to its raw span-based basis unconditionally.
    const { container } = setup('view', 0);

    expect(wrapperStyle(container, 'w1').maxWidth).toBe('calc(25% - 6px)');
    expect(wrapperStyle(container, 'w2').maxWidth).toBe('calc(50% - 4px)');
  });

  // Regression coverage for finding 1.4's ResizeObserver half: the review flags
  // that the canvas root the observer watches can, in principle, be a different
  // DOM node in the empty-state branch vs the populated branch (mutually
  // exclusive early-return branches of the same persistent `StudioCanvas`), and a
  // plain `[ref, enabled]`-keyed effect (in `@mui/x-internals/useResizeObserver`,
  // which this package can't edit) would never notice a swap and re-observe.
  // `canvasNode`/`canvasResizeRef` (a fresh `RefObject` minted whenever the
  // attached node changes) close that hole generically, independent of whether
  // today's two branches happen to share the same root element type — this test
  // pins the end-to-end behavior (a connected observer exists and stacking
  // reacts to a resize) across exactly the transition the review calls out:
  // "mount empty -> populate -> resize window".
  describe('resize observer survives an empty -> populated transition (finding 1.4)', () => {
    it('re-attaches to the populated root after the page gains its first widget, and stacking reacts to a resize', async () => {
      FakeResizeObserver.instances = [];
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          session: { mode: 'view' },
          doc: {
            pages: {
              'page-1': {
                id: 'page-1',
                title: 'Page 1',
                widgetRows: [],
                // Pre-set so the populated widget has an explicit span to clamp against
                // (an unset span skips the max-width clamp entirely — see the other
                // tests in this file — which would make the tiers unobservable here).
                widgetColSpans: { w1: 6 },
              },
            },
          },
        },
      });
      const element: React.ReactElement<any> = React.createElement(StudioCanvas, {
        stackBreakpoint: B,
      });
      const { container } = render(element, { wrapper });

      // While empty, no widget exists to hang a "connected observer" assertion off
      // of yet — just populate the page straight away.
      act(() => {
        controller.insertWidgetAt(makeWidget('w1'), 'page-1', [['w1']]);
      });

      // A live observer for the now-mounted (populated) canvas root must exist —
      // this is exactly what's missing under the bug: the original observer keeps
      // watching the unmounted empty-state root, which is no longer in the document.
      const observer = findConnectedObserver();
      expect(observer).toBeDefined();

      await resize(observer, 400);
      // width < B (600) -> fully-stacked tier -> full width regardless of span.
      expect(wrapperStyle(container, 'w1').maxWidth).toBe('100%');

      await resize(observer, 1400);
      // width >= 2B -> normal tier -> raw span-based basis: span=6 of 24 -> 25%,
      // gap adjustment 8 * (1 - 6/24) = 6px (same math as the first test above).
      expect(wrapperStyle(container, 'w1').maxWidth).toBe('calc(25% - 6px)');
    });
  });
});
