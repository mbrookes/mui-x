import * as React from 'react';
import { createRenderer, screen, waitFor, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioLiveRegionProvider } from '../../internals/StudioLiveRegion';
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

/**
 * The stacked layout (the DEFAULT — `sidebarLayout` defaults to `'stacked'`) swaps between
 * two mutually exclusive trees: closed renders the collapsed rail, open renders a different
 * tree with the rail unmounted. Whichever control the user just activated is therefore
 * removed from the DOM by its own activation, focus resets to `<body>`, and the next Tab
 * restarts from the top of the document (WCAG 2.4.3). Nothing was announced either
 * (WCAG 4.1.3) — the two `sidebarPanel*Announcement` locale keys existed and were
 * translated in all five bundles, but the only consumer was `TabbedSidebar`, the
 * NON-default layout.
 */
describe('DrawerPanel focus management and announcements', () => {
  function renderPanel(open: boolean) {
    const harness = createStudioHarness({
      initialState: {
        session: { shell: { openDrawers: { compose: open } } } as never,
      },
    });
    const view = render(
      <StudioLiveRegionProvider>
        <DrawerPanel drawer="compose" title="Compose">
          <div>panel body</div>
        </DrawerPanel>
      </StudioLiveRegionProvider>,
      { wrapper: harness.wrapper },
    );
    return { ...view, ...harness };
  }

  /** Same tree, plus a focusable control OUTSIDE the panel to stand in for "wherever the user is". */
  function renderPanelWithOutsideControl(open: boolean) {
    const harness = createStudioHarness({
      initialState: {
        session: { shell: { openDrawers: { compose: open } } } as never,
      },
    });
    const view = render(
      <StudioLiveRegionProvider>
        <button type="button">Outside</button>
        <DrawerPanel drawer="compose" title="Compose">
          <div>panel body</div>
        </DrawerPanel>
      </StudioLiveRegionProvider>,
      { wrapper: harness.wrapper },
    );
    return { ...view, ...harness };
  }

  function liveRegionText() {
    return document.querySelector('[aria-live="polite"]')?.textContent ?? '';
  }

  it('reports its expanded state on the collapsed rail', () => {
    renderPanel(false);
    expect(screen.getByRole('button', { name: 'Open Compose panel' })).to.have.attribute(
      'aria-expanded',
      'false',
    );
  });

  it('moves focus into the opened panel instead of dropping it on <body>', async () => {
    const { user } = renderPanel(false);
    const rail = screen.getByRole('button', { name: 'Open Compose panel' });
    rail.focus();
    await user.keyboard('{Enter}');

    const collapseButton = screen.getByRole('button', { name: 'Close Compose panel' });
    expect(document.activeElement).to.equal(collapseButton);
  });

  it('returns focus to the rail when the panel is collapsed', async () => {
    const { user } = renderPanel(true);
    const collapseButton = screen.getByRole('button', { name: 'Close Compose panel' });
    collapseButton.focus();
    await user.keyboard('{Enter}');

    const rail = screen.getByRole('button', { name: 'Open Compose panel' });
    expect(document.activeElement).to.equal(rail);
  });

  it('announces the panel opening', async () => {
    const { user } = renderPanel(false);
    await user.click(screen.getByRole('button', { name: 'Open Compose panel' }));
    await waitFor(() => {
      expect(liveRegionText()).to.equal(
        DEFAULT_STUDIO_LOCALE_TEXT.sidebarPanelOpenedAnnouncement('Compose'),
      );
    });
  });

  it('announces the panel closing', async () => {
    const { user } = renderPanel(true);
    await user.click(screen.getByRole('button', { name: 'Close Compose panel' }));
    await waitFor(() => {
      expect(liveRegionText()).to.equal(DEFAULT_STUDIO_LOCALE_TEXT.sidebarPanelClosedAnnouncement);
    });
  });

  // The negative half of the same contract. `pendingFocusRef` is set ONLY by this
  // component's own rail/close controls, so the layout effect moves focus only for a swap
  // the user caused here. Both positive directions are covered above; without the ref gate
  // the effect would focus on every `open` flip and they would all still pass — while a
  // keyboard shortcut, the AI panel, or the host's `StudioHandle` opening a drawer would rip
  // focus out of whatever the user was actually typing in.
  it('a PROGRAMMATIC open does not yank focus away from the user', async () => {
    const { controller } = renderPanelWithOutsideControl(false);
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    expect(document.activeElement).to.equal(outside);

    await act(async () => {
      controller.setDrawerOpen('compose', true);
    });

    // The panel really did open …
    expect(screen.getByRole('button', { name: 'Close Compose panel' })).not.toBe(null);
    // … and focus stayed where the user put it.
    expect(document.activeElement).to.equal(outside);
  });

  it('a PROGRAMMATIC close does not yank focus away from the user', async () => {
    const { controller } = renderPanelWithOutsideControl(true);
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();

    await act(async () => {
      controller.setDrawerOpen('compose', false);
    });

    expect(screen.getByRole('button', { name: 'Open Compose panel' })).not.toBe(null);
    expect(document.activeElement).to.equal(outside);
  });
});
