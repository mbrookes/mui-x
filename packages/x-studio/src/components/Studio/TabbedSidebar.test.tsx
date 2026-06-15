import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StudioController } from '../../store/StudioController';
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
      shell: {
        openDrawers: { data: false, compose: false, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
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

    expect(controller.getState().shell.openDrawers.data).toBe(true);
  });

  it('closes a panel when the active tab is clicked again', () => {
    controller = new StudioController({
      shell: {
        openDrawers: { data: true, compose: false, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
      },
    });
    syncState();
    renderSidebar();

    fireEvent.click(screen.getByRole('tab', { name: /Close Data panel/i }));
    syncState();

    expect(controller.getState().shell.openDrawers.data).toBe(false);
  });

  it('closes the current panel and opens the new one when a different tab is clicked', () => {
    controller = new StudioController({
      shell: {
        openDrawers: { data: true, compose: false, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
      },
    });
    syncState();
    renderSidebar();

    fireEvent.click(screen.getByRole('tab', { name: /Open Filters panel/i }));
    syncState();

    const drawers = controller.getState().shell.openDrawers;
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
      shell: {
        openDrawers: { data: false, compose: false, filters: true },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
      },
    });
    syncState();
    renderSidebar();

    expect(screen.getByText('Filters content')).toBeVisible();
    expect(screen.queryByText('Data content')).toBeNull();
  });
});
