import * as React from 'react';
import { createRenderer, fireEvent, screen, within } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Side-effect imports: `AdapterDayjs.ts` calls `.utc()`/`.tz()` assuming the consumer has
// already loaded these plugins' ambient `declare module 'dayjs'` augmentations. x-date-pickers'
// own program gets this via `AdapterDayjs.test.tsx`, but this package's tsconfig only includes
// its own `src/**/*`, so this is the file that pulls `AdapterDayjs.ts` into x-studio's program —
// without these imports, `pnpm --filter "@mui/x-studio" run typescript` fails inside a file we
// don't own.
import 'dayjs/plugin/utc';
import 'dayjs/plugin/timezone';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { createStudioHarness } from '../../../../internals/test-utils';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../../../internals/StudioUIConfigContext';
import { DateRangeControl } from './DateRangeControl';

const { render } = createRenderer();

const localeText = DEFAULT_STUDIO_LOCALE_TEXT;

// The DatePicker chooses its desktop/mobile variant from `useMediaQuery`, which relies on
// `window.matchMedia`. Stub it so the (simpler to drive) desktop variant renders in jsdom.
beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addListener: () => {},
    addEventListener: () => {},
    removeListener: () => {},
    removeEventListener: () => {},
  }) as unknown as typeof window.matchMedia;
});

function setup(props: Partial<React.ComponentProps<typeof DateRangeControl>> = {}) {
  const onApply = vi.fn();
  const onClear = vi.fn();
  const { wrapper: studioWrapper } = createStudioHarness();
  function wrapper(wrapperProps: { children?: React.ReactNode }) {
    return (
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        {studioWrapper(wrapperProps)}
      </LocalizationProvider>
    );
  }
  const utils = render(
    <DateRangeControl
      label="Order date"
      fieldId="orderDate"
      currentValue={null}
      onApply={onApply}
      onClear={onClear}
      {...props}
    />,
    { wrapper },
  );
  return { onApply, onClear, ...utils };
}

/** The sectioned date field exposes its label via an `aria-labelledby` group, not a plain
 *  labelled input, so `getByRole('group', { name })` is the unambiguous way to find it
 *  (`getByLabelText` matches both that group and the field's hidden native input). */
function getDateField(name: string) {
  return screen.getByRole('group', { name });
}

describe('DateRangeControl', () => {
  it('renders a "from" and a "to" date picker', () => {
    setup();

    expect(getDateField(localeText.filterWidgetDateFromLabel)).not.toBe(null);
    expect(getDateField(localeText.filterWidgetDateToLabel)).not.toBe(null);
  });

  it('does not show the clear affordance when no value is set', () => {
    setup();

    expect(screen.queryByRole('button', { name: localeText.filterWidgetClearAriaLabel })).toBe(
      null,
    );
  });

  it('shows the clear affordance when a "from" value is set', () => {
    setup({ currentValue: { from: '2024-01-01' } });

    expect(screen.getByRole('button', { name: localeText.filterWidgetClearAriaLabel })).not.toBe(
      null,
    );
  });

  it('shows the clear affordance when a "to" value is set', () => {
    setup({ currentValue: { to: '2024-01-31' } });

    expect(screen.getByRole('button', { name: localeText.filterWidgetClearAriaLabel })).not.toBe(
      null,
    );
  });

  it('calls onClear when the clear affordance is clicked', async () => {
    const { user, onClear } = setup({ currentValue: { from: '2024-01-01', to: '2024-01-31' } });

    await user.click(screen.getByRole('button', { name: localeText.filterWidgetClearAriaLabel }));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it('prefills the pickers with the current value', () => {
    setup({ currentValue: { from: '2024-01-15', to: '2024-01-20' } });

    const fromField = getDateField(localeText.filterWidgetDateFromLabel);
    expect(within(fromField).getByRole('spinbutton', { name: 'Month' }).textContent).toBe('01');
    expect(within(fromField).getByRole('spinbutton', { name: 'Day' }).textContent).toBe('15');
    expect(within(fromField).getByRole('spinbutton', { name: 'Year' }).textContent).toBe('2024');

    const toField = getDateField(localeText.filterWidgetDateToLabel);
    expect(within(toField).getByRole('spinbutton', { name: 'Month' }).textContent).toBe('01');
    expect(within(toField).getByRole('spinbutton', { name: 'Day' }).textContent).toBe('20');
    expect(within(toField).getByRole('spinbutton', { name: 'Year' }).textContent).toBe('2024');
  });

  describe('applying a new "from" date (debounced)', () => {
    // The control debounces `onApply` by 300ms so that typing into the date field doesn't
    // trigger a pipeline re-render per keystroke. Real timers (with an awaited delay) are used
    // here rather than fake timers, since combining `vi.useFakeTimers()` with userEvent's own
    // internal timing proved unreliable for this sectioned field in jsdom.
    it('calls onApply with the formatted value after the debounce window', async () => {
      const { user, onApply } = setup({ currentValue: null });

      const fromField = getDateField(localeText.filterWidgetDateFromLabel);
      const monthSection = within(fromField).getByRole('spinbutton', { name: 'Month' });
      await user.click(monthSection);
      await user.keyboard('01152024');

      expect(onApply).not.toHaveBeenCalled();

      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });

      expect(onApply).toHaveBeenCalledWith({ from: '2024-01-15', to: undefined });
    });

    it('cancels a pending debounced apply when clear is clicked before it fires (finding 2)', async () => {
      const { user, onApply, onClear } = setup({
        currentValue: { from: '2024-01-01', to: '2024-01-31' },
      });

      const fromField = getDateField(localeText.filterWidgetDateFromLabel);
      const monthSection = within(fromField).getByRole('spinbutton', { name: 'Month' });
      await user.click(monthSection);
      // A single keystroke is enough to schedule a debounced `onApply` — kept minimal
      // (unlike the full-date entry above) so real typing time can never itself approach
      // the 300ms debounce window before `clear` is clicked, which would flake this test
      // for a reason unrelated to what it verifies.
      await user.keyboard('2');

      // Clear immediately, before the 300ms debounce window elapses — this must cancel
      // the scheduled `onApply` rather than let it fire afterward and silently
      // resurrect the just-cleared date range. Uses `fireEvent.click` (not `user.click`)
      // to avoid the Tooltip-wrapped icon button's hover-open simulation, whose own
      // delayed state update would otherwise land during the real-timer wait below and
      // trip `vitest-fail-on-console`'s act() warning — unrelated to what this test verifies.
      fireEvent.click(screen.getByRole('button', { name: localeText.filterWidgetClearAriaLabel }));

      expect(onClear).toHaveBeenCalledOnce();

      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });

      expect(onApply).not.toHaveBeenCalled();
    });
  });
});
