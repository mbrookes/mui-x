import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type {
  StudioFilterState,
  StudioState,
  StudioWidget,
  StudioWidgetConfig,
} from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetCard } from './StudioWidgetCard';

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
});
