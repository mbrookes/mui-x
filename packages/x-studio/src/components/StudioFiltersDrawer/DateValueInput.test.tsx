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

// Regression for M9: `onChange` routes straight into the undoable `controller.updateFilter`,
// and a MUI date field publishes once per SECTION. While the user retypes over an already
// filled date, an intermediate publish carries an INVALID date, which this input used to
// commit as `value: ''` — every widget re-rendered unfiltered and back, and Ctrl+Z then walked
// those blank states one section at a time. It was the only value editor in the drawer without
// buffering. A partial/invalid edit must commit nothing; a genuine clear must still commit.
describe('DateValueInput partial-edit buffering (M9)', () => {
  it('does not commit an empty value for an intermediate invalid date', async () => {
    const onChange = vi.fn();
    // February 2023 has 28 days, so typing day "29" over this makes a fully-typed but INVALID
    // date — exactly the publish that used to blank the filter.
    const { user } = render(tree('2023-02-10', onChange));

    const daySection = screen.getByRole('spinbutton', { name: 'Day' });
    await user.click(daySection);
    await user.keyboard('29');

    expect(onChange).not.toHaveBeenCalledWith('');
  });

  it('still commits the date once the edit resolves to a valid one', async () => {
    const onChange = vi.fn();
    const { user } = render(tree('2023-02-10', onChange));

    const daySection = screen.getByRole('spinbutton', { name: 'Day' });
    await user.click(daySection);
    await user.keyboard('21');

    expect(onChange).toHaveBeenLastCalledWith('2023-02-21');
  });

  it('still commits an explicit clear', async () => {
    const onChange = vi.fn();
    const { user } = render(tree('2023-02-10', onChange));

    // Deleting a filled section publishes `null` with NO validation error — a genuine
    // emptying, not a partial edit, so it must still reach the store.
    await user.click(screen.getByRole('spinbutton', { name: 'Day' }));
    await user.keyboard('{Delete}');

    expect(onChange).toHaveBeenCalledWith('');
  });
});
