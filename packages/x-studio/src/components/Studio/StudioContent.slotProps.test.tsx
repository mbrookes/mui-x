import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioContent } from './StudioContent';

/**
 * Pins finding 1.7b: `StudioContent` used to spread `slotProps?.canvas` onto
 * `StudioCanvas` and then unconditionally overwrite `onBackgroundClick` with its own
 * `() => setChatOpen(false)`, silently clobbering any consumer-supplied callback.
 * The fix composes both: the built-in chat-close behavior runs first, then the
 * consumer's callback (if any).
 */

const { render } = createRenderer();

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'text', title: id, config: { textBody: 'hello' } as StudioWidgetConfig };
}

function setup(onBackgroundClick?: () => void) {
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] },
        },
        widgets: { w1: makeWidget('w1') },
      },
    },
  });
  const view = render(<StudioContent slotProps={{ canvas: { onBackgroundClick } }} />, { wrapper });
  return { ...view, controller };
}

/** The `StudioCanvas` root Box: `<main>` -> 480px-floor wrapper Box -> canvas root Box. */
function getCanvasRoot(): HTMLElement {
  const main = screen.getByRole('main');
  return main.firstElementChild?.firstElementChild as HTMLElement;
}

describe('StudioContent canvas slotProps composition (finding 1.7b)', () => {
  it('calls the consumer-supplied onBackgroundClick alongside the built-in chat-close behavior', () => {
    const onBackgroundClick = vi.fn();
    setup(onBackgroundClick);

    fireEvent.mouseDown(getCanvasRoot());

    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no consumer onBackgroundClick is supplied', () => {
    setup(undefined);

    expect(() => fireEvent.mouseDown(getCanvasRoot())).not.toThrow();
  });
});
