import * as React from 'react';
import { createRenderer, screen, fireEvent, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioContent } from './StudioContent';

// The chat panel is lazy-loaded, so mocking the module it dynamically imports makes this
// stub the component `React.lazy` resolves to — the same technique
// `StudioContent.chatPanelErrorBoundary.test.tsx` uses. It surfaces the two internally
// managed props this file is about so they can be asserted from the DOM.
vi.mock('../StudioChatPanel/StudioChatPanel', () => ({
  StudioChatPanel: ({ open, focusedWidgetId }: { open: boolean; focusedWidgetId?: string }) => (
    <div data-testid="chat" data-open={String(open)} data-focused={focusedWidgetId ?? ''} />
  ),
}));

const { render } = createRenderer();

/**
 * `insightFocusedWidgetId` reaches the AI middleware's system prompt as
 * `The user is asking about widget "…"`. It was set when the user pressed a widget's insight
 * action and then never cleared, so every LATER message in the session stayed scoped to that
 * widget — after closing the panel, reopening it from the FAB, and switching pages, an
 * unrelated request still steered the model at the original widget (or at a dead id, if that
 * widget had since been deleted).
 *
 * The invariant: the focus lives exactly as long as the widget-scoped conversation it was
 * opened for — it is dropped when the panel closes, when the page changes, and when the
 * widget it names stops existing.
 */

const INSIGHT_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'insightable',
  label: 'Insightable',
  component: () => <div>widget body</div>,
  aiInsight: true,
};

function makeWidget(id: string, title: string): StudioWidget {
  return { id, kind: 'insightable', title, config: {} as StudioWidgetConfig };
}

function setup() {
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
        },
        widgets: { w1: makeWidget('w1', 'Revenue') },
      },
    },
    providerProps: { customWidgets: [INSIGHT_WIDGET_DEF] },
  });
  const view = render(<StudioContent aiConfig={{ endpoint: 'http://localhost/api' }} />, {
    wrapper,
  });
  return { ...view, controller };
}

/** Drives the real widget-card insight action: select the card, open its menu, pick Summary. */
function requestInsight(controller: ReturnType<typeof setup>['controller']) {
  act(() => {
    controller.setSelectedWidget('w1');
  });
  fireEvent.click(screen.getByRole('button', { name: 'AI insight' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Summary' }));
}

function chat() {
  return screen.getByTestId('chat');
}

describe('StudioContent widget-insight focus lifecycle', () => {
  it('opens the chat scoped to the widget whose insight action was pressed', async () => {
    const { controller } = setup();
    await screen.findByTestId('chat');

    requestInsight(controller);

    expect(chat().getAttribute('data-open')).toBe('true');
    expect(chat().getAttribute('data-focused')).toBe('w1');
  });

  it('drops the focus when the panel is closed, so a reopened panel starts unscoped', async () => {
    const { controller } = setup();
    await screen.findByTestId('chat');
    requestInsight(controller);
    expect(chat().getAttribute('data-focused')).toBe('w1');

    fireEvent.click(screen.getByRole('button', { name: 'Close AI assistant' }));
    expect(chat().getAttribute('data-open')).toBe('false');
    expect(chat().getAttribute('data-focused')).toBe('');

    // Reopening from the FAB is a fresh, dashboard-wide conversation.
    fireEvent.click(screen.getByRole('button', { name: 'Open AI assistant' }));
    expect(chat().getAttribute('data-open')).toBe('true');
    expect(chat().getAttribute('data-focused')).toBe('');
  });

  it('drops the focus when the user switches page while the panel is open', async () => {
    const { controller } = setup();
    await screen.findByTestId('chat');
    requestInsight(controller);
    expect(chat().getAttribute('data-focused')).toBe('w1');

    act(() => {
      controller.setActivePage('page-2');
    });

    // The focused widget is not on screen any more, so it must not keep scoping the chat.
    expect(chat().getAttribute('data-focused')).toBe('');
    expect(chat().getAttribute('data-open')).toBe('true');
  });

  it('drops the focus when the focused widget is deleted', async () => {
    const { controller } = setup();
    await screen.findByTestId('chat');
    requestInsight(controller);
    expect(chat().getAttribute('data-focused')).toBe('w1');

    act(() => {
      controller.removeWidget('w1');
    });

    // Otherwise a dead id is sent with every subsequent message.
    expect(chat().getAttribute('data-focused')).toBe('');
  });
});
