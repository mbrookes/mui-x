import * as React from 'react';
import { createRenderer, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import { createDefaultWidget } from '@mui/x-studio-schema';
import { StudioProvider } from '../context';
import { useStudioKeyboardShortcuts } from './useStudioKeyboardShortcuts';

const { render } = createRenderer();

/**
 * Regression coverage for Tier-1 finding 1.3: the undo/redo keyboard shortcuts registered a
 * bare `window` keydown listener per instance with no scoping, so two mounted Studio instances
 * both undid from a single Ctrl+Z. The listener is now scoped to each instance's root DOM node.
 */

function Instance({ controller, testId }: { controller: StudioController; testId: string }) {
  return (
    <StudioProvider controller={controller}>
      <ShortcutScope testId={testId} />
    </StudioProvider>
  );
}

function ShortcutScope({ testId }: { testId: string }) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  useStudioKeyboardShortcuts(rootRef);
  return (
    <div ref={rootRef}>
      <button type="button" data-testid={testId}>
        focusable
      </button>
    </div>
  );
}

function dispatchUndo() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  });
}

describe('useStudioKeyboardShortcuts scoping (1.3)', () => {
  it('only the focused Studio instance responds to Ctrl+Z', () => {
    const controllerA = new StudioController();
    const controllerB = new StudioController();
    // Give each instance one undoable action.
    controllerA.setDashboardTitle('A edit');
    controllerB.setDashboardTitle('B edit');
    expect(controllerA.canUndo()).toBe(true);
    expect(controllerB.canUndo()).toBe(true);

    render(
      <React.Fragment>
        <Instance controller={controllerA} testId="focus-a" />
        <Instance controller={controllerB} testId="focus-b" />
      </React.Fragment>,
    );

    // Focus lands inside instance A's root.
    act(() => {
      (screen.getByTestId('focus-a') as HTMLButtonElement).focus();
    });

    dispatchUndo();

    // Only instance A undid; instance B is untouched by the same keypress.
    expect(controllerA.canUndo()).toBe(false);
    expect(controllerB.canUndo()).toBe(true);
  });

  it('routes the shortcut to the instance that currently holds focus', () => {
    const controllerA = new StudioController();
    const controllerB = new StudioController();
    controllerA.setDashboardTitle('A edit');
    controllerB.setDashboardTitle('B edit');

    render(
      <React.Fragment>
        <Instance controller={controllerA} testId="focus-a" />
        <Instance controller={controllerB} testId="focus-b" />
      </React.Fragment>,
    );

    // Now focus instance B instead.
    act(() => {
      (screen.getByTestId('focus-b') as HTMLButtonElement).focus();
    });

    dispatchUndo();

    expect(controllerB.canUndo()).toBe(false);
    expect(controllerA.canUndo()).toBe(true);
  });
});

/**
 * Delete/Backspace removing the selected widget (AG_STUDIO_GAP_ANALYSIS XS-A11Y-001).
 *
 * The one authoring action a keyboard user previously had no direct route to — reaching it meant
 * opening the card's action menu. It is deliberately UNMODIFIED, which is the convention every
 * canvas editor uses and also what makes it easy to fire by accident, so most of what is asserted
 * here is the guards rather than the happy path.
 */
describe('useStudioKeyboardShortcuts — delete selected widget', () => {
  function seedSelectedWidget() {
    const controller = new StudioController();
    const pageId = controller.getState().doc.dashboard.activePageId;
    // `insertWidgetAt` rather than `addWidget`: the latter puts the widget in `doc.widgets` without
    // placing it on a page, which is a state the shortcut would still act on but no user can reach.
    // The default state already seeds a widget, so the new row is APPENDED — replacing the rows
    // orphans that one, which `warnOnOrphanedWidgets` (correctly) complains about.
    const rows = controller.getState().doc.pages[pageId].widgetRows;
    // `createDefaultWidget` mints its own id (its second parameter is an overrides bag, not an id),
    // so the id is read back rather than assumed.
    const widget = { ...createDefaultWidget('text'), id: 'w1' };
    controller.insertWidgetAt(widget, pageId, [...rows, ['w1']]);
    controller.setSelectedWidget('w1');
    return controller;
  }

  function pressDelete(key: 'Delete' | 'Backspace' = 'Delete', target?: EventTarget) {
    act(() => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true });
      (target ?? window).dispatchEvent(event);
    });
  }

  it('removes the selected widget in edit mode', () => {
    const controller = seedSelectedWidget();
    render(<Instance controller={controller} testId="del1" />);
    act(() => {
      screen.getByTestId('del1').focus();
    });

    pressDelete();

    expect(controller.getState().doc.widgets.w1).to.equal(undefined);
  });

  it('accepts Backspace as well as Delete', () => {
    const controller = seedSelectedWidget();
    render(<Instance controller={controller} testId="del2" />);
    act(() => {
      screen.getByTestId('del2').focus();
    });

    pressDelete('Backspace');

    expect(controller.getState().doc.widgets.w1).to.equal(undefined);
  });

  it('does nothing in view mode', () => {
    // Deleting from a read-only surface is the clearest possible violation of what view mode
    // promises, and view mode is the one a dashboard CONSUMER sees.
    const controller = seedSelectedWidget();
    controller.setMode('view');
    render(<Instance controller={controller} testId="del3" />);
    act(() => {
      screen.getByTestId('del3').focus();
    });

    pressDelete();

    expect(controller.getState().doc.widgets.w1).to.not.equal(undefined);
  });

  it('does nothing when no widget is selected', () => {
    const controller = seedSelectedWidget();
    controller.setSelectedWidget(null);
    render(<Instance controller={controller} testId="del4" />);
    act(() => {
      screen.getByTestId('del4').focus();
    });

    pressDelete();

    expect(controller.getState().doc.widgets.w1).to.not.equal(undefined);
  });

  it('does nothing when the selection is stale', () => {
    // A selection id outlives the widget it names: undoing an `addWidget` removes the widget while
    // `selectedWidgetId` is carried across the doc swap. Without the existence check, the next
    // Delete would push an undo entry for removing nothing.
    const controller = seedSelectedWidget();
    controller.removeWidget('w1');
    controller.setSelectedWidget('w1');
    render(<Instance controller={controller} testId="del5" />);
    act(() => {
      screen.getByTestId('del5').focus();
    });
    const before = controller.getState().doc;

    pressDelete();

    expect(controller.getState().doc).to.equal(before);
  });

  it('does not fire while the user is typing', () => {
    // The reason an unmodified destructive key needs `isEditableTarget`: Backspace is how you
    // correct a typo in a filter value, and it must not delete the widget behind the drawer.
    const controller = seedSelectedWidget();
    render(<Instance controller={controller} testId="del6" />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.focus();
    });

    pressDelete('Backspace', input);

    expect(controller.getState().doc.widgets.w1).to.not.equal(undefined);
    input.remove();
  });

  it('calls onWidgetRemoved so the caller can announce and restore focus', () => {
    // The hook owns neither the live region nor the DOM, so it reports rather than acts. Losing
    // this callback would leave a keyboard author on `<body>` with no announcement.
    const controller = seedSelectedWidget();
    let calls = 0;
    function Scope() {
      const rootRef = React.useRef<HTMLDivElement>(null);
      useStudioKeyboardShortcuts(rootRef, {
        onWidgetRemoved: () => {
          calls += 1;
        },
      });
      return (
        <div ref={rootRef}>
          <button type="button" data-testid="del7">
            focusable
          </button>
        </div>
      );
    }
    render(
      <StudioProvider controller={controller}>
        <Scope />
      </StudioProvider>,
    );
    act(() => {
      screen.getByTestId('del7').focus();
    });

    pressDelete();

    expect(calls).to.equal(1);
  });
});
