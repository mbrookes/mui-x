import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * `StudioWidgetCard`'s three internal boundaries wrap only the actions overlay, the header,
 * and `def.component`. Everything the card computes in its OWN render body sits above them,
 * so before this fix the only boundary that could catch such a throw was the canvas-wide one
 * in `StudioContent` — which replaces every widget on every page with a single error overlay,
 * and under `StudioDashboard` (`compose: false`) offers Retry as the only way out.
 *
 * The canvas now wraps each card in its own `StudioWidgetErrorBoundary`, and the two consumer
 * callbacks that run during LAYOUT resolution (above even that boundary) fall back to their
 * safe defaults instead of throwing.
 */

function OkWidget() {
  return <div>ok widget body</div>;
}

/** A kind whose `shouldHide` predicate dereferences data that may not exist. */
const THROWING_SHOULD_HIDE_DEF: StudioCustomWidgetDef = {
  kind: 'bad-hide',
  label: 'Bad hide',
  component: OkWidget,
  shouldHide: ({ dataSource }) =>
    // The finding's concrete case: a consumer reading row 0 on a source with zero rows.
    (dataSource as unknown as { rows: { foo: boolean }[] }).rows[0].foo,
};

const OK_DEF: StudioCustomWidgetDef = {
  kind: 'ok-kind',
  label: 'Ok',
  component: OkWidget,
};

function makeWidget(id: string, kind: string, title: string): StudioWidget {
  return { id, kind, title, config: {} as StudioWidgetConfig };
}

describe('StudioCanvas per-widget error containment', () => {
  let errorSpy: { mockRestore: () => void };

  beforeEach(() => {
    // React logs every boundary-caught error to console.error.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('a throwing custom `shouldHide` leaves every widget on the page rendered', async () => {
    const { wrapper } = createStudioHarness({
      initialState: {
        session: { mode: 'view' },
        doc: {
          pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['bad', 'good']] } },
          widgets: {
            bad: makeWidget('bad', 'bad-hide', 'Bad widget'),
            good: makeWidget('good', 'ok-kind', 'Good widget'),
          },
        },
      },
      providerProps: { customWidgets: [THROWING_SHOULD_HIDE_DEF, OK_DEF] },
    });

    // `shouldHide` runs in `StudioPageRows`' render — above every boundary — so before the
    // guard this render threw straight past the canvas and blanked the whole page.
    render(<StudioCanvas />, { wrapper });

    // "Don't hide" is the safe default: both cards are present and usable.
    expect(screen.getByLabelText(/Bad widget/)).not.toBe(null);
    expect(screen.getByLabelText(/Good widget/)).not.toBe(null);
    // Widget bodies mount a frame later; both render, so nothing was replaced by an overlay.
    expect((await screen.findAllByText('ok widget body')).length).toBe(2);
  });

  it('contains a throw from a card render body to that card, leaving siblings alive', async () => {
    // Stands in for anything the card computes in its own render body (L2 enrichment for
    // custom kinds, `inferKpiDateSubtitle`, the card's `aria-label`) — all of which run above
    // the card's three internal boundaries. In view mode `StudioCanvas` itself never reads
    // `title`, so the throw originates strictly inside `StudioWidgetCard`.
    const exploding = makeWidget('bad', 'ok-kind', 'placeholder');
    Object.defineProperty(exploding, 'title', {
      get() {
        throw new Error('card render exploded');
      },
    });

    const { wrapper } = createStudioHarness({
      initialState: {
        session: { mode: 'view' },
        doc: {
          pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['bad', 'good']] } },
          widgets: { bad: exploding, good: makeWidget('good', 'ok-kind', 'Good widget') },
        },
      },
      providerProps: { customWidgets: [OK_DEF] },
    });

    render(<StudioCanvas />, { wrapper });

    // The failure is confined to one card...
    expect(screen.getByText('card render exploded')).not.toBe(null);
    // ...and the sibling widget on the same row still renders its card AND its body.
    expect(screen.getByLabelText(/Good widget/)).not.toBe(null);
    expect(await screen.findByText('ok widget body')).not.toBe(null);
  });
});
