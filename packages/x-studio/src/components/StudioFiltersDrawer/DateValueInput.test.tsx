import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import dayjs from 'dayjs';
import type { RelativeDateValue } from '../../internals/filterTypes';
import { DateValueInput } from './DateValueInput';

const { render } = createRenderer();

function tree(value: unknown, onChange: (v: unknown) => void) {
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <DateValueInput value={value} onChange={onChange} />
    </LocalizationProvider>
  );
}

// Regression for finding 7: the absolute↔relative toggle reads as a display-mode switch, but
// `absoluteToRelative`/`relativeToAbsolute` are lossy — a date 45 days old became "2 months
// ago", and toggling back committed ~60 days ago, destroying the original date. The last value
// held in each mode is now restored verbatim, so the round trip is lossless.
describe('DateValueInput absolute/relative toggle (finding 7)', () => {
  it('restores the exact original date when toggling to relative and back', async () => {
    const originalDate = dayjs().subtract(45, 'day').format('YYYY-MM-DD');
    const onChange = vi.fn();
    const { user, rerender } = render(tree(originalDate, onChange));

    await user.click(screen.getByRole('button', { name: 'Relative date' }));
    const converted = onChange.mock.calls[0][0] as RelativeDateValue;
    expect(converted.relative).toBe(true);

    // The store now holds the relative value; re-render with it, as the drawer would.
    rerender(tree(converted, onChange));
    await user.click(screen.getByRole('button', { name: 'Absolute date' }));

    // Not `relativeToAbsolute(converted)` — which would land ~60 days ago — but the date the
    // user actually authored.
    expect(onChange).toHaveBeenLastCalledWith(originalDate);
  });

  it('restores the exact relative expression when toggling to absolute and back', async () => {
    const relative: RelativeDateValue = {
      relative: true,
      amount: 45,
      unit: 'day',
      direction: 'past',
    };
    const onChange = vi.fn();
    const { user, rerender } = render(tree(relative, onChange));

    await user.click(screen.getByRole('button', { name: 'Absolute date' }));
    const asAbsolute = onChange.mock.calls[0][0];

    rerender(tree(asAbsolute, onChange));
    await user.click(screen.getByRole('button', { name: 'Relative date' }));

    // A re-derived relative value would have been coarsened to "2 months ago".
    expect(onChange).toHaveBeenLastCalledWith(relative);
  });

  it('still converts on the first toggle, when there is nothing to restore', async () => {
    const onChange = vi.fn();
    const { user } = render(tree('2024-05-20', onChange));

    await user.click(screen.getByRole('button', { name: 'Relative date' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as RelativeDateValue).relative).toBe(true);
  });
});
