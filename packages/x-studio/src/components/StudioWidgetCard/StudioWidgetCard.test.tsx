import * as React from 'react';
import { createRenderer, fireEvent, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  StudioDataSource,
  StudioExpressionField,
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

// Capture the config passed to pragmatic-dnd's `draggable` so drag start/teardown can be
// driven directly (jsdom has no real pointer drag). Returns a no-op cleanup.
let lastDraggableConfig: { onDragStart?: () => void; onDrop?: () => void } | null = null;
vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: { onDragStart?: () => void; onDrop?: () => void }) => {
    lastDraggableConfig = config;
    return () => {};
  },
}));

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
    expressionFields?: StudioExpressionField[];
  } = {},
) {
  const w = options.widget ?? widget();
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        widgets: { [w.id]: w },
        ...(options.filters ? { filters: options.filters } : {}),
        ...(options.expressionFields ? { expressionFields: options.expressionFields } : {}),
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
    // fireEvent.keyDown targets the active element in this harness. Wrapped in act()
    // since focusing the card now also updates state (finding 2.14's onFocus handler).
    act(() => {
      card.focus();
    });
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
    act(() => {
      card.focus();
    });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(setSelectedSpy).not.toHaveBeenCalled();
  });

  it('is not aria-current in view mode even when it is the selected widget', () => {
    const { card } = setup({ mode: 'view', shell: { selectedWidgetId: 'w1' } });
    expect(card.getAttribute('aria-current')).toBe(null);
  });

  // Regression coverage: `widget.kind` is doc-authored. The custom/built-in classification
  // used to check `widget.kind in BUILTIN_WIDGET_DEFS`, and `in` walks the prototype chain —
  // so a bogus kind equal to an inherited `Object.prototype` member name (e.g. "constructor")
  // would misclassify as built-in. Rendering such a widget must not throw (with no matching
  // def, the card simply renders no widget content).
  it('does not throw for a widget kind colliding with an inherited Object.prototype member', () => {
    expect(() => setup({ widget: widget({ kind: 'constructor' as any }) })).not.toThrow();
  });

  // Regression coverage: Space used to select the widget without calling
  // `event.preventDefault()`, so the browser would also scroll the page (its default
  // action for a Space keypress) on top of activating the card.
  it('prevents default scroll behavior when activated with Space in edit mode', () => {
    const { card } = setup();
    act(() => {
      card.focus();
    });
    // `fireEvent` returns the result of `dispatchEvent`, which is `false` when the
    // event was cancelable and a handler called `preventDefault()`.
    const result = fireEvent.keyDown(card, { key: ' ' });
    expect(result).toBe(false);
  });

  it('does not preventDefault for Space in view mode (card is not interactive)', () => {
    const { card } = setup({ mode: 'view' });
    act(() => {
      card.focus();
    });
    const result = fireEvent.keyDown(card, { key: ' ' });
    expect(result).toBe(true);
  });

  // Regression coverage for finding 2.14: the view-mode export/expand toolbar used to
  // reveal only on `onMouseEnter`/`onMouseLeave`, with no keyboard-focus equivalent — a
  // keyboard-only user could never reach it (edit mode already has a keyboard path via
  // card selection). The toolbar buttons stay mounted with `tabIndex={-1}` while hidden
  // (`StudioWidgetCardActionsOverlay`), so focusing the always-tabbable card container
  // must flip them to `tabIndex={0}` exactly like mouse hover does.
  it('reveals the view-mode toolbar (and makes its buttons tabbable) on card focus, not just mouse hover', () => {
    const source: StudioDataSource = {
      id: 's1',
      label: 'Source',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      rows: [{ status: 'active' }],
    };
    const { card } = setup({
      mode: 'view',
      widget: widget({ kind: 'grid', sourceId: 's1', config: {} as StudioWidgetConfig }),
      dataSources: { s1: source },
    });
    const exportButton = screen.getByLabelText('Download as CSV');
    // Hidden and out of the tab order before any hover/focus.
    expect(exportButton.getAttribute('tabindex')).toBe('-1');

    fireEvent.focus(card);
    expect(exportButton.getAttribute('tabindex')).toBe('0');

    // Focus moving to a descendant (the button itself, e.g. via Tab) must not hide the
    // toolbar again — only leaving the card entirely should.
    fireEvent.blur(card, { relatedTarget: exportButton });
    expect(exportButton.getAttribute('tabindex')).toBe('0');

    fireEvent.blur(card, { relatedTarget: null });
    expect(exportButton.getAttribute('tabindex')).toBe('-1');
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
    // The expected bounds are derived through the same `Intl` options the helper uses
    // rather than hardcoded as English `1 Jan 2024`: the helper now resolves both the
    // month name and the field order from the runtime locale (it used to format through
    // dayjs's unconfigured global default), so a hardcoded string would only pass under
    // one locale.
    const formatBound = (iso: string) =>
      new Date(iso).toLocaleDateString(undefined, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    expect(
      screen.getByText(`order_date: ${formatBound('2024-01-01')} – ${formatBound('2024-01-31')}`),
    ).toBeDefined();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  // Regression coverage for finding 3.11: the cross-filter chip label only checked
  // `source.fields`, so a cross-filter on an expression (calculated) field fell through
  // to the raw field id instead of its label. `resolveFieldDef` (already the shared
  // "check owned fields, then expression fields" lookup used by the chart widgets)
  // should resolve it the same way here.
  it('resolves the cross-filter chip label from an expression field, not just the raw id', () => {
    const crossFilter: StudioFilterState = {
      id: 'cf1',
      field: 'margin',
      operator: 'equals',
      value: 'high',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
    };
    const marginField: StudioExpressionField = {
      id: 'margin',
      label: 'Margin %',
      sourceId: 's1',
      isMeasure: false,
      expression: {
        operator: 'add',
        inputs: [
          { type: 'number', value: 0 },
          { type: 'number', value: 0 },
        ],
      } as StudioExpressionField['expression'],
    };
    setup({
      widget: widget({ kind: 'grid', sourceId: 's1', config: {} as StudioWidgetConfig }),
      filters: [crossFilter],
      expressionFields: [marginField],
    });
    expect(screen.getByText('Margin %: high')).toBeDefined();
    expect(screen.queryByText(/^margin:/)).toBeNull();
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

  // Regression coverage (finding 3.7): the drag body flag + inline card opacity were only
  // cleared in `onDrop`. If the card unmounted mid-drag (widget deleted, page changed, or
  // edit mode exited), pragmatic-dnd tore down without firing `onDrop`, so
  // `document.body.dataset.studioDraggingWidgetId` (and any global CSS keyed on it) stuck.
  // `useStudioDraggable`'s effect cleanup now runs the drop handler when a drag is in flight.
  it('clears the drag body flag when the card unmounts mid-drag', () => {
    lastDraggableConfig = null;
    const w = widget({ kind: 'grid', config: {} as StudioWidgetConfig });
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { [w.id]: w } },
        session: { mode: 'edit' },
      },
    });
    const { unmount } = render(<StudioWidgetCard widgetId={w.id} pageId="page-1" />, { wrapper });

    // Simulate a drag that starts but never receives a drop before the card is unmounted.
    act(() => {
      lastDraggableConfig?.onDragStart?.();
    });
    expect(document.body.dataset.studioDraggingWidgetId).toBe(w.id);

    act(() => {
      unmount();
    });
    expect(document.body.dataset.studioDraggingWidgetId).toBeUndefined();
  });

  // Regression coverage (finding 3.2): the untitled-widget fallback used to render a
  // hardcoded `'KPI'` / capitalized raw kind string. It now routes through localized
  // widget-kind labels, e.g. a grid resolves to "Table" rather than the old "Grid".
  // (setup()'s `getByLabelText(/^Widget: /)` can't be used here — an empty title yields the
  // label "Widget: " whose trailing space testing-library trims — so render directly.)
  function renderUntitled(w: StudioWidget) {
    const { wrapper } = createStudioHarness({ initialState: { doc: { widgets: { [w.id]: w } } } });
    render(<StudioWidgetCard widgetId={w.id} pageId="page-1" />, { wrapper });
  }

  it('renders a localized widget-kind label as the untitled fallback', () => {
    renderUntitled(widget({ kind: 'grid', title: '', config: {} as StudioWidgetConfig }));
    // Localized label for the grid kind is "Table", not the old capitalized "Grid".
    expect(screen.getByText('Table')).not.toBe(null);
    expect(screen.queryByText('Grid')).toBe(null);
  });

  it('renders the localized KPI label for an untitled KPI widget', () => {
    renderUntitled(widget({ kind: 'kpi', title: '', config: {} as StudioWidgetConfig }));
    expect(screen.getByText('KPI')).not.toBe(null);
  });

  // Architecture review finding (Tier1): the widget title header renders outside this
  // card's own `StudioWidgetErrorBoundary` (which wraps only `def.component`), so an
  // unguarded `widgetKindLabels[widget.kind]` bracket lookup that resolves an inherited
  // `Object.prototype` member (e.g. `kind: 'constructor'` — a persisted-doc/AI-authored/
  // custom-widget kind string) would throw uncaught when rendered as a `Typography`
  // child, crashing the whole dashboard. It must instead fall through to the
  // capitalized-kind fallback.
  it('falls back to the capitalized kind for an untitled widget whose kind collides with an Object.prototype member', () => {
    renderUntitled(widget({ kind: 'constructor', title: '', config: {} as StudioWidgetConfig }));
    expect(screen.getByText('Constructor')).not.toBe(null);
  });

  // M23: the visible title had the full fallback chain above, but the card root's
  // `aria-label` interpolated a bare `widget.title ?? ''`. Every untitled widget on a page
  // therefore announced as the identical "Widget:, group" while sighted users read "KPI",
  // "Table", "Revenue by region" — the accessible name distinguished nothing.
  describe('accessible name for an untitled widget (M23)', () => {
    // Scoped by `data-widget-id` rather than `getByRole('group')`: one of the cases below
    // renders two cards to compare their names, and the renderer shares one document.
    function untitledCardLabel(w: StudioWidget) {
      renderUntitled(w);
      return document.querySelector(`[data-widget-id="${w.id}"]`)?.getAttribute('aria-label');
    }

    it('names the card with the localized kind label rather than an empty string', () => {
      expect(
        untitledCardLabel(widget({ kind: 'kpi', title: '', config: {} as StudioWidgetConfig })),
      ).toBe('Widget: KPI');
    });

    it('gives two untitled widgets of different kinds distinguishable names', () => {
      const kpiLabel = untitledCardLabel(
        widget({ id: 'w-kpi', kind: 'kpi', title: '', config: {} as StudioWidgetConfig }),
      );
      const gridLabel = untitledCardLabel(
        widget({ id: 'w-grid', kind: 'grid', title: '', config: {} as StudioWidgetConfig }),
      );
      expect(kpiLabel).not.toBe(gridLabel);
    });

    it('matches the visible title exactly', () => {
      const w = widget({
        id: 'w-visible',
        kind: 'grid',
        title: '',
        config: {} as StudioWidgetConfig,
      });
      renderUntitled(w);
      const visibleTitle = screen.getByText('Table').textContent;
      expect(document.querySelector(`[data-widget-id="${w.id}"]`)?.getAttribute('aria-label')).toBe(
        `Widget: ${visibleTitle}`,
      );
    });

    it('still uses the authored title when there is one', () => {
      expect(untitledCardLabel(widget({ kind: 'kpi', title: 'Revenue' }))).toBe('Widget: Revenue');
    });
  });
});
