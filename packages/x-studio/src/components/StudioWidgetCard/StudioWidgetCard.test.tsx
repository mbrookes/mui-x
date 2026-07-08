import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioState,
  StudioWidget,
  StudioWidgetConfig,
} from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { exportGridToCsv } from '../../internals/widgetUtils';
import { StudioWidgetCard } from './StudioWidgetCard';

vi.mock('../../internals/widgetUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/widgetUtils')>();
  return { ...actual, exportGridToCsv: vi.fn() };
});

const { render } = createRenderer();

function widget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'text',
    title: 'My widget',
    config: { textBody: 'Note body' } as StudioWidgetConfig,
    ...overrides,
  };
}

function setup(
  options: {
    widget?: StudioWidget;
    shell?: Partial<StudioState['session']['shell']>;
    onUnconfiguredClick?: (id: string) => void;
    mode?: StudioState['session']['mode'];
    filters?: StudioFilterState[];
    dataSources?: Record<string, StudioDataSource>;
  } = {},
) {
  const w = options.widget ?? widget();
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        widgets: { [w.id]: w },
        ...(options.filters ? { filters: options.filters } : {}),
      },
      session: {
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.shell ? { shell: options.shell as StudioState['session']['shell'] } : {}),
      },
      ...(options.dataSources ? { runtime: { dataSources: options.dataSources } } : {}),
    },
  });
  const setSelectedSpy = vi.spyOn(controller, 'setSelectedWidget');
  render(
    <StudioWidgetCard
      widgetId={w.id}
      pageId="page-1"
      onUnconfiguredClick={options.onUnconfiguredClick}
    />,
    {
      wrapper,
    },
  );
  // The card root carries aria-label `Widget: <title>` (filtersSectionWidgetTitle).
  const card = screen.getByLabelText(/^Widget: /);
  return { card, controller, setSelectedSpy };
}

describe('StudioWidgetCard', () => {
  it('renders a card element with the widget content', () => {
    const { card } = setup();
    expect(card).not.toBe(null);
    expect(card.getAttribute('aria-label')).toContain('My widget');
  });

  it('marks the card aria-current when it is the selected widget', () => {
    // `aria-current` is used instead of `aria-selected` because the card is a
    // `role="group"` container (it holds interactive content), where
    // `aria-selected` would be invalid.
    const { card } = setup({ shell: { selectedWidgetId: 'w1' } });
    expect(card.getAttribute('aria-current')).toBe('true');
  });

  it('is not aria-current when another widget is selected', () => {
    const { card } = setup({ shell: { selectedWidgetId: 'other' } });
    expect(card.getAttribute('aria-current')).toBe(null);
  });

  it('selects the widget when the card is clicked', () => {
    const { card, setSelectedSpy } = setup();
    // Use fireEvent.click since the card is a div (not a button role).
    fireEvent.click(card);
    expect(setSelectedSpy).toHaveBeenCalledWith('w1');
  });

  it('selects the widget on Enter and Space key presses', () => {
    const { card, setSelectedSpy } = setup();
    card.focus(); // fireEvent.keyDown targets the active element in this harness
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(setSelectedSpy).toHaveBeenCalledTimes(2);
    expect(setSelectedSpy).toHaveBeenCalledWith('w1');
  });

  it('does not call onUnconfiguredClick for a text widget', () => {
    const onUnconfiguredClick = vi.fn();
    const { card } = setup({ onUnconfiguredClick });
    fireEvent.click(card);
    expect(onUnconfiguredClick).not.toHaveBeenCalled();
  });

  it('calls onUnconfiguredClick for a non-text widget with no source (edit mode)', () => {
    const onUnconfiguredClick = vi.fn();
    const { card } = setup({
      widget: widget({ kind: 'kpi', title: 'KPI', config: {} as StudioWidgetConfig }),
      onUnconfiguredClick,
    });
    fireEvent.click(card);
    expect(onUnconfiguredClick).toHaveBeenCalledWith('w1');
  });

  it('does not select/activate the widget when clicked in view mode', () => {
    const { card, setSelectedSpy } = setup({ mode: 'view' });
    fireEvent.click(card);
    card.focus();
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(setSelectedSpy).not.toHaveBeenCalled();
  });

  it('is not aria-current in view mode even when it is the selected widget', () => {
    const { card } = setup({ mode: 'view', shell: { selectedWidgetId: 'w1' } });
    expect(card.getAttribute('aria-current')).toBe(null);
  });

  // Regression coverage: Space used to select the widget without calling
  // `event.preventDefault()`, so the browser would also scroll the page (its default
  // action for a Space keypress) on top of activating the card.
  it('prevents default scroll behavior when activated with Space in edit mode', () => {
    const { card } = setup();
    card.focus();
    // `fireEvent` returns the result of `dispatchEvent`, which is `false` when the
    // event was cancelable and a handler called `preventDefault()`.
    const result = fireEvent.keyDown(card, { key: ' ' });
    expect(result).toBe(false);
  });

  it('does not preventDefault for Space in view mode (card is not interactive)', () => {
    const { card } = setup({ mode: 'view' });
    card.focus();
    const result = fireEvent.keyDown(card, { key: ' ' });
    expect(result).toBe(true);
  });

  // Regression coverage: the active cross-filter chip label used to be built by an
  // inline IIFE that has been extracted to the shared `formatCrossFilterValueLabel`
  // helper (also used by `StudioQuickFilterBar`). Assert a `between` (date-range)
  // cross-filter value still renders as formatted dates, not "[object Object]".
  // (`makeSelectWidgetActiveCrossFilter` only resolves for chart/grid widgets, hence
  // `kind: 'grid'` here instead of the default text widget.)
  it('formats a between cross-filter chip label via the shared helper', () => {
    const crossFilter: StudioFilterState = {
      id: 'cf1',
      field: 'order_date',
      operator: 'equals',
      value: { from: '2024-01-01', to: '2024-01-31' },
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
    };
    setup({
      widget: widget({ kind: 'grid', config: {} as StudioWidgetConfig }),
      filters: [crossFilter],
    });
    expect(screen.getByText(/order_date: 1 Jan 2024 – 31 Jan 2024/)).toBeDefined();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  // Regression coverage: `resolveWidgetRows` only honours a widget's cross-filter mode
  // when the caller opts in via its `options` argument — omitting it silently keeps the
  // (incorrect) pre-opt-in default of always including cross-filters. The CSV-export path
  // used to call it with no options at all, so a grid configured with
  // `crossFilterMode: 'none'` would still export cross-filtered-out rows.
  describe('CSV export respects the widget cross-filter mode', () => {
    const source: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      rows: [{ status: 'active' }, { status: 'inactive' }],
    };
    const crossFilter: StudioFilterState = {
      id: 'cf1',
      field: 'status',
      operator: 'equals',
      value: 'active',
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
    };

    beforeEach(() => {
      vi.mocked(exportGridToCsv).mockClear();
    });

    function clickExport() {
      fireEvent.click(screen.getByLabelText('Download as CSV'));
    }

    it('excludes cross-filtered rows when the widget opts out via crossFilterMode: "none"', () => {
      setup({
        widget: widget({
          kind: 'grid',
          sourceId: 's1',
          config: { crossFilterMode: 'none' } as StudioWidgetConfig,
        }),
        dataSources: { s1: source },
        filters: [crossFilter],
      });
      clickExport();
      expect(exportGridToCsv).toHaveBeenCalledTimes(1);
      const rows = vi.mocked(exportGridToCsv).mock.calls[0][2];
      expect(rows).toEqual([{ status: 'active' }, { status: 'inactive' }]);
    });

    it('includes cross-filtered rows for a widget using the default cross-highlight mode', () => {
      setup({
        widget: widget({
          kind: 'grid',
          sourceId: 's1',
          config: {} as StudioWidgetConfig,
        }),
        dataSources: { s1: source },
        filters: [crossFilter],
      });
      clickExport();
      expect(exportGridToCsv).toHaveBeenCalledTimes(1);
      const rows = vi.mocked(exportGridToCsv).mock.calls[0][2];
      expect(rows).toEqual([{ status: 'active' }]);
    });
  });
});
