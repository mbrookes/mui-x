import * as React from 'react';
import { createRenderer, screen, fireEvent, waitFor, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createDefaultStudioState } from '@mui/x-studio-core/models';
import { frLocaleText } from '@mui/x-studio-core/locales';
import type { StudioState } from '../../models';
import {
  DEFAULT_STUDIO_LOCALE_TEXT,
  type ResolvedStudioFeatures,
  type StudioLocaleText,
} from '../../internals/StudioUIConfigContext';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { StudioQuickFilterBar } from './StudioQuickFilterBar';

// ── Shared mutable state ──────────────────────────────────────────────────────

let mockState: StudioState;
let mockFeatures: ResolvedStudioFeatures;
let mockLocaleText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT;

const controller = {
  setDrawerOpen: vi.fn(),
  removeFilter: vi.fn(),
  toggleFilter: vi.fn(),
  clearCrossFilter: vi.fn(),
  updateState: vi.fn(),
};

const BASE_FEATURES: ResolvedStudioFeatures = {
  compose: true,
  filters: true,
  quickFilter: false,
  crossFilterBar: false,
  savedFilterViews: true,
  dataManagement: true,
  relationships: true,
  widgetFilters: true,
  aiChat: false,
  aiInsights: true,
  export: true,
  grid: true,
  chart: true,
  kpi: true,
  text: true,
  filter: true,
  pivot: true,
  map: true,
  kpiSparkline: true,
  kpiTrend: true,
  kpiCalculatedFields: true,
  chartAnnotations: true,
  chartCalculatedFields: true,
  gridGroupBy: true,
  gridSummary: true,
  gridConditionalFormats: true,
  gridCalculatedFields: true,
  calculatedFields: true,
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

vi.mock('../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioLocaleText: () => mockLocaleText,
    useStudioFeatures: () => mockFeatures,
  };
});

const { render } = createRenderer();

const PAGE_ID = 'page-1';

function makePageFilter(id: string, field: string = 'country') {
  return {
    id,
    field,
    sourceId: 'src1',
    operatorId: 'equals',
    values: ['France'],
    value: 'France',
    operator: 'equals' as const,
    scope: { kind: 'page' as const, pageId: PAGE_ID },
    filterMode: 'condition' as const,
  };
}

function makeCrossFilter(
  id: string,
  field: string,
  value: unknown,
  overrides: { sourceWidgetId?: string } = {},
) {
  return {
    id,
    field,
    operator: 'equals' as const,
    value,
    scope: {
      kind: 'cross-filter' as const,
      sourceWidgetId: overrides.sourceWidgetId ?? 'w1',
      pageId: PAGE_ID,
    },
    filterMode: 'condition' as const,
  };
}

const DATA_SOURCES_WITH_DATE = {
  src1: {
    id: 'src1',
    label: 'Source',
    fields: [
      { id: 'order_date', label: 'Order Date', type: 'date' as const },
      { id: 'country', label: 'Country', type: 'string' as const },
    ],
    rows: [],
  },
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('StudioQuickFilterBar', () => {
  // Reset features to default before each test

  beforeEach(() => {
    mockFeatures = { ...BASE_FEATURES, quickFilter: false };
    mockLocaleText = DEFAULT_STUDIO_LOCALE_TEXT;
    controller.removeFilter.mockClear();
    controller.toggleFilter.mockClear();
    controller.clearCrossFilter.mockClear();
    controller.updateState.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('renders nothing when there are no page filters', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
    });
    const { container } = render(<StudioQuickFilterBar />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a chip for each active page filter', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [makePageFilter('f1', 'country'), makePageFilter('f2', 'region')],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [
              { id: 'country', label: 'Country', type: 'string' as const },
              { id: 'region', label: 'Region', type: 'string' as const },
            ],
            rows: [],
          },
        },
      },
    });
    render(<StudioQuickFilterBar />);
    expect(screen.getByText(/Country/)).toBeDefined();
    expect(screen.getByText(/Region/)).toBeDefined();
  });

  it('shows dashboard date-range filter as chip when quickFilter is disabled', () => {
    mockFeatures = { ...BASE_FEATURES, quickFilter: false };
    mockState = createDefaultStudioState({
      doc: {
        filters: [
          {
            ...makePageFilter('dr1', 'order_date'),
            scope: { kind: 'dashboard-date-range' as const, sourceId: 'src1', pageId: PAGE_ID },
          },
          makePageFilter('f1', 'country'),
        ],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: { dataSources: DATA_SOURCES_WITH_DATE },
    });
    render(<StudioQuickFilterBar />);
    // Both filters shown when quickFilter bar is off (user can still clear them)
    expect(screen.getByText(/Order Date/)).toBeDefined();
    expect(screen.getByText(/Country/)).toBeDefined();
  });

  it('hides dashboard date-range filter chip when quickFilter is enabled (bar handles it)', () => {
    mockFeatures = { ...BASE_FEATURES, quickFilter: true };
    mockState = createDefaultStudioState({
      doc: {
        filters: [
          {
            ...makePageFilter('dr1', 'order_date'),
            scope: { kind: 'dashboard-date-range' as const, sourceId: 'src1', pageId: PAGE_ID },
          },
          makePageFilter('f1', 'country'),
        ],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: { dataSources: DATA_SOURCES_WITH_DATE },
    });
    render(<StudioQuickFilterBar />);
    // Date range filter excluded from chips — the bar component handles it
    expect(screen.queryByText(/Order Date/)).toBeNull();
    // Regular page filter still shown
    expect(screen.getByText(/Country/)).toBeDefined();
  });

  it('does not show chips for filters on other pages', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [
          { ...makePageFilter('f1'), scope: { kind: 'page' as const, pageId: 'other-page' } },
        ],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
    });
    const { container } = render(<StudioQuickFilterBar />);
    expect(container.firstChild).toBeNull();
  });

  it('shows chips for filters with no pageId (legacy data)', () => {
    const filterWithoutPageId = { ...makePageFilter('f1'), scope: { kind: 'page' as const } };
    mockState = createDefaultStudioState({
      doc: {
        filters: [filterWithoutPageId],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
    });
    render(<StudioQuickFilterBar />);
    expect(screen.getByText(/country/)).toBeDefined();
  });

  it('suppresses the chip toggle tooltip while hovering the close button (no double tooltip)', async () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [makePageFilter('f1', 'country')],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [{ id: 'country', label: 'Country', type: 'string' as const }],
            rows: [],
          },
        },
      },
    });
    render(<StudioQuickFilterBar />);

    const closeButton = screen.getByRole('button', { name: 'Remove filter' });
    const chip = closeButton.closest('.MuiChip-root') as HTMLElement;

    // Hovering the chip body shows the enable/disable tooltip.
    fireEvent.mouseEnter(chip);
    expect(screen.getByText('Disable filter')).toBeDefined();

    // Moving onto the close button must hide that tooltip — otherwise the remove tooltip
    // would render on top of it and the user would see two tooltips at once.
    fireEvent.mouseEnter(closeButton);
    await waitFor(() => expect(screen.queryByText('Disable filter')).toBeNull());
  });

  // Regression coverage for Tier-2 finding #7 / Tier-4 finding #11 in the architecture
  // review: `summarizeFilter` used to hardcode English strings and call
  // `getOperatorLabel` without locale text, so a quick-filter-bar chip rendered in
  // English (e.g. "Country: Equals: France") regardless of the active locale even
  // though the `filterOperator_*` tokens were already translated.
  it('renders the chip summary translated under a non-English locale', () => {
    mockLocaleText = { ...DEFAULT_STUDIO_LOCALE_TEXT, ...frLocaleText };
    mockState = createDefaultStudioState({
      doc: {
        filters: [makePageFilter('f1', 'country')],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [{ id: 'country', label: 'Country', type: 'string' as const }],
            rows: [],
          },
        },
      },
    });
    render(<StudioQuickFilterBar />);
    // French translation of the `equals` operator label — not the hardcoded English "Equals".
    expect(screen.getByText(/Est égal à: France/)).toBeDefined();
    expect(screen.queryByText(/Equals: France/)).toBeNull();
  });

  // Regression coverage for the cross-filter chip value formatting fix: a `between`
  // (date-range) cross-filter value used to render via bare `String(filter.value)`,
  // producing "[object Object]" instead of a readable date range.
  it('renders a date-range (between) cross-filter chip with formatted dates, not [object Object]', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [makeCrossFilter('cf1', 'order_date', { from: '2024-01-01', to: '2024-01-31' })],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: { dataSources: DATA_SOURCES_WITH_DATE },
    });
    render(<StudioQuickFilterBar />);
    // Built from `Intl` rather than a literal: `crossFilterValueLabel` formats through
    // `toLocaleDateString` (dayjs is never locale-configured in this package), so a hardcoded
    // en-GB-style string would pin one runtime's locale rather than the behaviour.
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    expect(
      screen.getByText(new RegExp(`Order Date: ${fmt('2024-01-01')} – ${fmt('2024-01-31')}`)),
    ).toBeDefined();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  // Regression coverage: an `in` (multi-select, shift-click) cross-filter value is an
  // array — bare `String(filter.value)` used to join it with commas via the array's
  // default `toString`, which happens to look readable for simple string arrays but
  // breaks down for anything else. Assert the shared helper is actually used.
  it('renders an in (multi-select) cross-filter chip as a readable list', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [makeCrossFilter('cf1', 'country', ['France', 'Germany'])],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [{ id: 'country', label: 'Country', type: 'string' as const }],
            rows: [],
          },
        },
      },
    });
    render(<StudioQuickFilterBar />);
    expect(screen.getByText(/Country: France, Germany/)).toBeDefined();
  });

  // Regression coverage: `filter.scope.pageId` (used to prefix a cross-page cross-filter
  // chip with its origin page's title) is doc-authored. A bare `pages[pageId]` lookup would
  // resolve an inherited `Object.prototype` member (truthy) for a pageId like "constructor",
  // and reading `.title` off that would throw. Rendering must not throw, and since no such
  // page actually exists the origin-page prefix must be omitted.
  it('does not throw and omits the origin-page prefix for a cross-page filter pageId colliding with an inherited Object.prototype member', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [
          {
            ...makeCrossFilter('cf1', 'country', 'France'),
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'constructor' },
          },
        ],
        // Cross-page filters are only rendered at all when `crossFilterAllPages` is on
        // (otherwise they're scoped out entirely, unrelated to this fix) — needed here so
        // the chip (and its origin-page-title lookup) actually renders.
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID, crossFilterAllPages: true },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [{ id: 'country', label: 'Country', type: 'string' as const }],
            rows: [],
          },
        },
      },
    });
    expect(() => render(<StudioQuickFilterBar />)).not.toThrow();
    expect(screen.getByText(/Country: France/)).toBeDefined();
  });

  // Regression coverage for architecture-review finding #7: the tooltip describing the
  // toggle/remove affordance used to be driven only by mouseenter/mouseleave state, so a
  // keyboard user tabbing onto the (already-focusable, clickable) chip never saw it.
  it('shows the chip toggle tooltip on keyboard focus, not just mouse hover', async () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [makePageFilter('f1', 'country')],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [{ id: 'country', label: 'Country', type: 'string' as const }],
            rows: [],
          },
        },
      },
    });
    render(<StudioQuickFilterBar />);

    const closeButton = screen.getByRole('button', { name: 'Remove filter' });
    const chip = closeButton.closest('.MuiChip-root') as HTMLElement;

    expect(screen.queryByText('Disable filter')).toBeNull();
    fireEvent.focus(chip);
    expect(screen.getByText('Disable filter')).toBeDefined();

    fireEvent.blur(chip);
    await waitFor(() => expect(screen.queryByText('Disable filter')).toBeNull());
  });

  // Regression coverage for the a11y fix: the remove affordance used to be a
  // `role="button"` span with no `tabIndex`/keyboard handler. It's now the Chip's
  // native `onDelete`, which MUI wires up to Backspace/Delete while the chip is focused.
  it('removes a page filter via keyboard (Backspace) on a focused chip', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [makePageFilter('f1', 'country')],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [{ id: 'country', label: 'Country', type: 'string' as const }],
            rows: [],
          },
        },
      },
    });
    render(<StudioQuickFilterBar />);

    const chip = screen
      .getByText(/Country: Equals: France/)
      .closest('.MuiChip-root') as HTMLElement;
    // `chip.focus()` must both move `document.activeElement` (`fireEvent.keyUp` below
    // requires the target to actually be focused) AND run inside `act()` — the chip now
    // also has an `onFocus` handler (finding #7), and a raw `.focus()` call dispatches
    // outside testing-library's `act()` wrapping, so the resulting state update would
    // otherwise warn "not wrapped in act(...)".
    act(() => {
      chip.focus();
    });
    fireEvent.keyUp(chip, { key: 'Backspace' });
    expect(controller.removeFilter).toHaveBeenCalledWith('f1');
  });

  it('clears a cross-filter via keyboard (Backspace) on a focused chip', () => {
    mockState = createDefaultStudioState({
      doc: {
        filters: [makeCrossFilter('cf1', 'region', 'EMEA', { sourceWidgetId: 'w9' })],
        dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Source',
            fields: [{ id: 'region', label: 'Region', type: 'string' as const }],
            rows: [],
          },
        },
      },
    });
    render(<StudioQuickFilterBar />);

    const chip = screen.getByText(/Region: EMEA/).closest('.MuiChip-root') as HTMLElement;
    // See the analogous comment above.
    act(() => {
      chip.focus();
    });
    fireEvent.keyUp(chip, { key: 'Backspace' });
    expect(controller.clearCrossFilter).toHaveBeenCalledWith('w9');
  });

  // Regression coverage for architecture-review finding 2.10: "Clear all" used to call
  // `controller.removeFilter`/`clearCrossFilter` in a loop — one undoable commit per
  // filter — so a single click pushed N undo entries for one user gesture. It must now
  // batch everything into exactly one `controller.updateState` call (a single undo
  // step), and must never fall back to the old per-filter methods.
  describe('Clear all (finding 2.10)', () => {
    it('clears multiple page filters in a single updateState commit, not N removeFilter calls', () => {
      mockState = createDefaultStudioState({
        doc: {
          filters: [makePageFilter('f1', 'country'), makePageFilter('f2', 'region')],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Source',
              fields: [
                { id: 'country', label: 'Country', type: 'string' as const },
                { id: 'region', label: 'Region', type: 'string' as const },
              ],
              rows: [],
            },
          },
        },
      });
      render(<StudioQuickFilterBar />);

      fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));

      expect(controller.removeFilter).not.toHaveBeenCalled();
      expect(controller.updateState).toHaveBeenCalledTimes(1);
      const [patch] = controller.updateState.mock.calls[0];
      expect(patch.doc.filters).toEqual([]);
    });

    it('clears page filters and cross-filters together in one commit', () => {
      mockState = createDefaultStudioState({
        doc: {
          filters: [
            makePageFilter('f1', 'country'),
            makeCrossFilter('cf1', 'region', 'EMEA', { sourceWidgetId: 'w9' }),
          ],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Source',
              fields: [
                { id: 'country', label: 'Country', type: 'string' as const },
                { id: 'region', label: 'Region', type: 'string' as const },
              ],
              rows: [],
            },
          },
        },
      });
      render(<StudioQuickFilterBar />);

      fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));

      expect(controller.removeFilter).not.toHaveBeenCalled();
      expect(controller.clearCrossFilter).not.toHaveBeenCalled();
      expect(controller.updateState).toHaveBeenCalledTimes(1);
      const [patch] = controller.updateState.mock.calls[0];
      expect(patch.doc.filters).toEqual([]);
    });

    it('is a no-op (no commit) when there is nothing to clear beyond a single filter (button hidden)', () => {
      mockState = createDefaultStudioState({
        doc: {
          filters: [makePageFilter('f1', 'country')],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Source',
              fields: [{ id: 'country', label: 'Country', type: 'string' as const }],
              rows: [],
            },
          },
        },
      });
      render(<StudioQuickFilterBar />);

      // "Clear all" is only rendered once there's more than one filter/cross-filter.
      expect(screen.queryByRole('button', { name: 'Clear all filters' })).toBeNull();
      expect(controller.updateState).not.toHaveBeenCalled();
    });
  });

  // M20: the chip IS the enable/disable toggle, and its state was carried by colour, fill and
  // opacity alone — nothing a screen reader or a low-vision user can perceive.
  describe('toggle state exposure (M20)', () => {
    function renderTwoChips() {
      mockState = createDefaultStudioState({
        doc: {
          filters: [
            makePageFilter('f1', 'country'),
            { ...makePageFilter('f2', 'region'), disabled: true },
          ],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Source',
              fields: [
                { id: 'country', label: 'Country', type: 'string' as const },
                { id: 'region', label: 'Region', type: 'string' as const },
              ],
              rows: [],
            },
          },
        },
      });
      render(<StudioQuickFilterBar />);
    }

    it('marks an enabled chip pressed and a disabled chip unpressed', () => {
      renderTwoChips();

      const pressedStates = screen
        .getAllByText(/Equals: France/)
        .map((label) => label.closest('.MuiChip-root')?.getAttribute('aria-pressed'));
      expect(pressedStates).toEqual(['true', 'false']);
    });
  });
});
