import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { WidgetTypeCard, type WidgetTypeEntry } from './WidgetTypeCard';

const { render } = createRenderer();

const entry: WidgetTypeEntry = {
  kind: 'chart',
  label: 'Chart',
  description: 'Bar, line, pie…',
  icon: <span />,
};

/**
 * The card is a `role="button"` composite, which gets none of a native `<button>`'s
 * disabled semantics for free. Both handlers already no-op when `canAdd` is false and the
 * card is dimmed to 50%, but a screen-reader user was told nothing: the card announced as
 * a plain, actionable button that then silently did nothing when activated.
 */
describe('WidgetTypeCard disabled semantics', () => {
  it('exposes aria-disabled when the widget type cannot be added', () => {
    render(<WidgetTypeCard wt={entry} canAdd={false} onSelect={vi.fn()} />);
    const card = screen.getByRole('button', { name: /Chart/ });
    expect(card.getAttribute('aria-disabled')).toBe('true');
    // Still reachable, per APG — an unreachable control cannot communicate its own state.
    expect(card.getAttribute('tabindex')).toBe('0');
  });

  it('reports itself as enabled when the widget type can be added', () => {
    render(<WidgetTypeCard wt={entry} canAdd onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Chart/ }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  it('does not select a disabled widget type when activated', async () => {
    const onSelect = vi.fn();
    const { user } = render(<WidgetTypeCard wt={entry} canAdd={false} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /Chart/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
