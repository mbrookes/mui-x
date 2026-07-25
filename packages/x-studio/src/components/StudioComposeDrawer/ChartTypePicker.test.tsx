import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ChartTypePicker } from './ChartTypePicker';

const { render } = createRenderer();

/**
 * The selected cell's background was `primary.main18` and the hover background
 * `primary.main10` — tokens that exist in neither MUI's palette nor this repo's theme
 * (confirmed by grep). `bgcolor` therefore resolved to nothing at all and selection was
 * signalled by a 1px border alone, against a `divider` border on every other cell.
 */
describe('ChartTypePicker selected-cell affordance', () => {
  it('paints a real background on the selected chart type', () => {
    render(<ChartTypePicker chartType="line" onChange={vi.fn()} />);

    const selected = screen.getByRole('button', { name: 'Line' });
    const unselected = screen.getByRole('button', { name: 'Pie' });

    // The tell for the bug: with a non-existent palette token the selected cell resolved
    // to the very same (absent) background as every unselected one.
    expect(getComputedStyle(selected).backgroundColor).not.toBe(
      getComputedStyle(unselected).backgroundColor,
    );
  });

  it('keeps the pressed state on the selected chart type', () => {
    render(<ChartTypePicker chartType="line" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Line' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Pie' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('distinguishes the horizontal bar variants by bar layout, not chart type alone', () => {
    render(<ChartTypePicker chartType="bar" barLayout="horizontal" onChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Bar (horizontal)' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'Bar (grouped)' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
