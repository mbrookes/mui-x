import * as React from 'react';
import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetCard } from './StudioWidgetCard';

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => {},
}));

const { render } = createRenderer();

const RETRY_LABEL = DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip;

// Flipped by the tests rather than decremented by the component: StrictMode renders twice,
// so a self-resetting one-shot thrower would "recover" on its own and prove nothing.
let explode = false;

function FlakyWidget() {
  if (explode) {
    throw new Error('custom widget exploded');
  }
  return <div data-testid="custom-widget-content">rendered</div>;
}

const FLAKY_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'flaky',
  label: 'Flaky',
  component: FlakyWidget,
};

function flakyWidget(config: StudioWidgetConfig = {} as StudioWidgetConfig): StudioWidget {
  return { id: 'w1', kind: 'flaky', title: 'Flaky widget', config };
}

function setup(widget: StudioWidget) {
  const { wrapper } = createStudioHarness({
    initialState: {
      doc: {
        widgets: { [widget.id]: widget },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] },
        },
      },
    },
    providerProps: { customWidgets: [FLAKY_WIDGET_DEF] },
  });
  return render(<StudioWidgetCard widgetId={widget.id} pageId="page-1" />, { wrapper });
}

describe('<StudioWidgetCard /> error containment', () => {
  let errorSpy: { mockRestore: () => void };

  beforeEach(() => {
    explode = false;
    // React logs every boundary-caught error to console.error.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    explode = false;
    errorSpy.mockRestore();
  });

  // Regression (H5a): the card's boundary took `resetKey={JSON.stringify(widget.config)}`, so
  // a widget that threw once stayed on the error overlay for the rest of the session unless
  // the user edited its config — impossible under `StudioDashboard`, which ships no
  // config-editing UI. The overlay now offers a Retry that clears the latched state.
  it('recovers a latched widget error through the overlay Retry button', async () => {
    explode = true;
    setup(flakyWidget());

    // Widget content is deferred to after first paint (see `showContent`), hence `findBy*`.
    expect(await screen.findByText('custom widget exploded')).not.toBe(null);
    // The card chrome survives the widget body's failure.
    expect(screen.getByText('Flaky widget')).not.toBe(null);

    explode = false;
    fireEvent.click(screen.getByRole('button', { name: RETRY_LABEL }));

    expect(screen.getByTestId('custom-widget-content')).not.toBe(null);
    expect(screen.queryByText('custom widget exploded')).toBe(null);
  });

  // Regression (H5b): `StudioCustomWidgetDef.defaultConfig` is arbitrary consumer data copied
  // verbatim into a new widget's `config` (see `AddWidgetView`). `JSON.stringify` throws on a
  // cyclic value, and it ran while computing the boundary's own prop — i.e. in this card's
  // render phase, ABOVE the boundary — so the throw escaped to the top and unmounted the
  // entire `<Studio>` tree. That is precisely the crash the boundary exists to prevent.
  it('renders a widget whose config is cyclic without crashing the tree', async () => {
    const config = { textBody: 'note' } as unknown as Record<string, unknown>;
    config.self = config;

    setup(flakyWidget(config as unknown as StudioWidgetConfig));

    expect(screen.getByText('Flaky widget')).not.toBe(null);
    expect(await screen.findByTestId('custom-widget-content')).not.toBe(null);
  });

  it('renders a widget whose config carries a BigInt without crashing the tree', async () => {
    const config = { threshold: BigInt('9007199254740993') } as unknown as StudioWidgetConfig;

    setup(flakyWidget(config));

    expect(screen.getByText('Flaky widget')).not.toBe(null);
    expect(await screen.findByTestId('custom-widget-content')).not.toBe(null);
  });

  // The automatic path still has to work for the ordinary case: an actual config edit
  // clears a latched error with no user interaction at all.
  it('clears a latched widget error when the config is edited', async () => {
    explode = true;
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          widgets: { w1: flakyWidget() },
          pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] } },
        },
      },
      providerProps: { customWidgets: [FLAKY_WIDGET_DEF] },
    });
    render(<StudioWidgetCard widgetId="w1" pageId="page-1" />, { wrapper });

    expect(await screen.findByText('custom widget exploded')).not.toBe(null);

    explode = false;
    act(() => {
      controller.updateWidgetConfig('w1', { textBody: 'fixed' } as Partial<StudioWidgetConfig>);
    });

    expect(screen.getByTestId('custom-widget-content')).not.toBe(null);
  });
});
