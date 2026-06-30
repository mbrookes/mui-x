import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioState, StudioWidget, StudioWidgetConfig } from '../../models';
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
    shell?: Partial<StudioState['shell']>;
    onUnconfiguredClick?: (id: string) => void;
    mode?: StudioState['mode'];
  } = {},
) {
  const w = options.widget ?? widget();
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      widgets: { [w.id]: w },
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.shell ? { shell: options.shell as StudioState['shell'] } : {}),
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
});
