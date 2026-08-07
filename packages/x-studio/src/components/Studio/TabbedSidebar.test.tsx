import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import type { StudioState } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { TabbedSidebar } from './TabbedSidebar';

// ── Shared mutable state ──────────────────────────────────────────────────────

let controller: StudioController;
let mockState: StudioState;

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

// ── Test helpers ──────────────────────────────────────────────────────────────

function syncState() {
  mockState = controller.getState();
}

const PANELS: React.ComponentProps<typeof TabbedSidebar>['panels'] = [
  { drawer: 'data', label: 'Data', children: <div>Data content</div> },
  { drawer: 'compose', label: 'Config', children: <div>Config content</div> },
  { drawer: 'filters', label: 'Filters', children: <div>Filters content</div> },
];

const { render } = createRenderer();

function renderSidebar(panels = PANELS) {
  return render(<TabbedSidebar panels={panels} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TabbedSidebar', () => {
  beforeEach(() => {
    controller = new StudioController({
      session: {
        shell: {
          openDrawers: { data: false, compose: false, filters: false },
          selectedWidgetId: null,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
    });
    syncState();
    // Some tests reassign `controller` mid-test, so resolve it live via a getter.
    configureStudioContextMock({ getState: () => mockState, getController: () => controller });
  });

  it('renders tab rail with all panel labels', () => {
    renderSidebar();

    expect(screen.getByRole('tab', { name: /Open Data panel/i })).toBeVisible();
    expect(screen.getByRole('tab', { name: /Open Config panel/i })).toBeVisible();
    expect(screen.getByRole('tab', { name: /Open Filters panel/i })).toBeVisible();
  });

  it('renders nothing (no empty rail) when there are no panels', () => {
    const { container } = renderSidebar([]);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('renders no panel content when all drawers are closed', () => {
    renderSidebar();

    expect(screen.queryByText('Data content')).toBeNull();
    expect(screen.queryByText('Config content')).toBeNull();
    expect(screen.queryByText('Filters content')).toBeNull();
  });

  it('opens a panel when its tab is clicked', () => {
    renderSidebar();

    fireEvent.click(screen.getByRole('tab', { name: /Open Data panel/i }));
    syncState();

    expect(controller.getState().session.shell.openDrawers.data).toBe(true);
  });

  it('closes a panel when the active tab is clicked again', () => {
    controller = new StudioController({
      session: {
        shell: {
          openDrawers: { data: true, compose: false, filters: false },
          selectedWidgetId: null,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
    });
    syncState();
    renderSidebar();

    fireEvent.click(screen.getByRole('tab', { name: /Close Data panel/i }));
    syncState();

    expect(controller.getState().session.shell.openDrawers.data).toBe(false);
  });

  it('closes the current panel and opens the new one when a different tab is clicked', () => {
    controller = new StudioController({
      session: {
        shell: {
          openDrawers: { data: true, compose: false, filters: false },
          selectedWidgetId: null,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
    });
    syncState();
    renderSidebar();

    fireEvent.click(screen.getByRole('tab', { name: /Open Filters panel/i }));
    syncState();

    const drawers = controller.getState().session.shell.openDrawers;
    expect(drawers.data).toBe(false);
    expect(drawers.filters).toBe(true);
    expect(drawers.compose).toBe(false);
  });

  it('renders only the panels passed as props', () => {
    // Only show filters tab (view mode scenario)
    renderSidebar([{ drawer: 'filters', label: 'Filters', children: <div>Filters content</div> }]);

    expect(screen.getByRole('tab', { name: /Open Filters panel/i })).toBeVisible();
    expect(screen.queryByRole('tab', { name: /Data/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Config/i })).toBeNull();
  });

  it('shows panel content for the open drawer', () => {
    controller = new StudioController({
      session: {
        shell: {
          openDrawers: { data: false, compose: false, filters: true },
          selectedWidgetId: null,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
    });
    syncState();
    renderSidebar();

    expect(screen.getByText('Filters content')).toBeVisible();
    expect(screen.queryByText('Data content')).toBeNull();
  });

  it('wires the active panel as a labelled tabpanel for its tab (APG tabs pattern)', () => {
    controller = new StudioController({
      session: {
        shell: {
          openDrawers: { data: false, compose: false, filters: true },
          selectedWidgetId: null,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
    });
    syncState();
    renderSidebar();

    const tab = screen.getByRole('tab', { name: /Close Filters panel/i });
    const panel = screen.getByRole('tabpanel');
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
  });

  it('only the active tab is in the Tab sequence; others are roving-tabindex -1', () => {
    controller = new StudioController({
      session: {
        shell: {
          openDrawers: { data: false, compose: true, filters: false },
          selectedWidgetId: null,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
    });
    syncState();
    renderSidebar();

    const tabs = screen.getAllByRole('tab');
    tabs.forEach((tab) => {
      const expectedTabIndex = /Close Config panel/i.test(tab.getAttribute('aria-label') ?? '')
        ? '0'
        : '-1';
      expect(tab.getAttribute('tabindex')).toBe(expectedTabIndex);
    });
  });

  it('moves roving focus to the next tab on ArrowRight without changing the open panel', () => {
    renderSidebar();

    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(tabs[1]).toHaveFocus();
    expect(tabs[1].getAttribute('tabindex')).toBe('0');
    expect(tabs[0].getAttribute('tabindex')).toBe('-1');
    // Navigation alone must not open a panel.
    expect(controller.getState().session.shell.openDrawers.compose).toBe(false);
  });

  it('wraps roving focus from the last tab to the first on ArrowRight, and moves focus with Home/End', () => {
    renderSidebar();

    const tabs = screen.getAllByRole('tab');
    tabs[tabs.length - 1].focus();
    fireEvent.keyDown(tabs[tabs.length - 1], { key: 'ArrowRight' });
    expect(tabs[0]).toHaveFocus();

    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(tabs[tabs.length - 1]).toHaveFocus();

    fireEvent.keyDown(tabs[tabs.length - 1], { key: 'Home' });
    expect(tabs[0]).toHaveFocus();
  });

  // ── M9: the rail must never leave the keyboard tab order ────────────────────
  //
  // `focusedIndex` was only written by the open-panel sync effect (which bails while no
  // panel is open) and by arrow-key navigation, so it could survive `panels` shrinking:
  // open Filters (index 2 of 3), close it (`activeIndex` → -1, `focusedIndex` stays 2),
  // then switch to view mode so only one panel remains. Every tab then rendered
  // `tabIndex={-1}` and the rail became unreachable with Tab, with no way back in.
  describe('roving tabindex clamping (M9)', () => {
    it('keeps a tab in the Tab sequence after the panel list shrinks past the focused index', () => {
      const { setProps } = renderSidebar();

      // Move roving focus to the last tab (index 2), then drop back to a single panel —
      // the same transition as closing Filters and switching to view mode.
      const tabs = screen.getAllByRole('tab');
      tabs[0].focus();
      fireEvent.keyDown(tabs[0], { key: 'End' });
      expect(tabs[2].getAttribute('tabindex')).toBe('0');

      setProps({
        panels: [{ drawer: 'filters', label: 'Filters', children: <div>Filters content</div> }],
      });

      const remaining = screen.getAllByRole('tab');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].getAttribute('tabindex')).toBe('0');
    });

    it('still exposes exactly one tabbable tab after shrinking to two panels', () => {
      const { setProps } = renderSidebar();

      const tabs = screen.getAllByRole('tab');
      tabs[0].focus();
      fireEvent.keyDown(tabs[0], { key: 'End' });

      setProps({ panels: PANELS.slice(0, 2) });

      const remaining = screen.getAllByRole('tab');
      expect(remaining.filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
    });
  });
});
