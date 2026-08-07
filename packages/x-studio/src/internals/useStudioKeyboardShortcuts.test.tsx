import * as React from 'react';
import { createRenderer, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
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
