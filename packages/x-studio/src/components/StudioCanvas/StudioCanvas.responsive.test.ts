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

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {}

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
});
