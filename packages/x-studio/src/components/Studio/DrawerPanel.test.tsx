import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { DrawerPanel } from './DrawerPanel';

const { render } = createRenderer();

/**
 * The collapsed rail is one `role="button"` covering its whole area, and it used to nest a
 * real `<button>` (an `IconButton`) inside it carrying the SAME accessible name. Nesting
 * interactive elements is invalid HTML, and a screen reader announced two identically named
 * "Open <title> panel" buttons for one target; `tabIndex={-1}` hid the inner one from the
 * tab order but not from the accessibility tree or an element rotor.
 */
describe('DrawerPanel collapsed rail', () => {
  function renderCollapsed() {
    const harness = createStudioHarness({
      initialState: {
        session: { shell: { openDrawers: { compose: false } } } as never,
      },
    });
    const view = render(
      <DrawerPanel drawer="compose" title="Compose">
        <div>panel body</div>
      </DrawerPanel>,
      { wrapper: harness.wrapper },
    );
    return { ...view, ...harness };
  }

  it('exposes exactly one control for opening the panel', () => {
    renderCollapsed();
    expect(screen.getAllByRole('button', { name: 'Open Compose panel' }).length).toBe(1);
  });

  it('nests no interactive element inside the rail', () => {
    renderCollapsed();
    const rail = screen.getByRole('button', { name: 'Open Compose panel' });
    expect(rail.querySelector('button')).toBe(null);
  });

  it('still opens the drawer when the rail is activated', async () => {
    const { user, controller } = renderCollapsed();
    await user.click(screen.getByRole('button', { name: 'Open Compose panel' }));
    expect(controller.getState().session.shell.openDrawers.compose).toBe(true);
  });
});
