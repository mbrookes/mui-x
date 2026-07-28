import * as React from 'react';
import { configure, createRenderer, fireEvent, screen, within } from '@mui/internal-test-utils';
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

// This suite runs entirely on fake timers so the control's 300ms debounce is driven by
// `clock.tick(...)` instead of by wall-clock waiting — nothing below depends on how fast the
// machine is. Two pieces of glue are needed to get `userEvent` and fake timers to coexist:
//
//   1. `advanceTimers`, wired up per-session in `setup()` below.
//   2. This `asyncWrapper` override. React Testing Library wraps every async interaction
//      (i.e. every `userEvent` call) in a wrapper that drains the microtask queue by awaiting
//      a 0ms `setTimeout` — and it only pumps the clock for *jest*'s fake timers, which it
//      detects via `typeof jest !== 'undefined'`. Under vitest that check is always false, so
//      the awaited timeout is never fired and the very first `await user.click(...)` hangs
//      until the test times out. Re-implementing the drain against vitest's clock is what
//      makes fake timers usable here at all; the act-environment toggling mirrors RTL's own
//      wrapper so interactions keep behaving (and keep logging) exactly as they do elsewhere.
const globalWithActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
configure({
  asyncWrapper: async (callback) => {
    const previousActEnvironment = globalWithActEnvironment.IS_REACT_ACT_ENVIRONMENT;
    globalWithActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const result = await callback();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
        if (vi.isFakeTimers()) {
          vi.advanceTimersByTime(0);
        }
      });
      return result;
    } finally {
      globalWithActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  },
});

const { clock, render } = createRenderer({ clock: 'fake' });

const localeText = DEFAULT_STUDIO_LOCALE_TEXT;

/** The debounce window `DateRangeControl` applies to `onApply`, in milliseconds. */
const DEBOUNCE_MS = 300;

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
  // `createRenderer`'s `user` is set up without `advanceTimers`, so under fake timers its
  // internal inter-event `wait()` (a 0ms `setTimeout`) would never resolve and every
  // interaction would hang. Deriving a sub-session — same pointer/keyboard state, extra
  // config — wires that wait to the fake clock, which is exactly what `advanceTimers` is for.
  const user = utils.user.setup({
    advanceTimers: (ms: number) => {
      vi.advanceTimersByTime(ms);
    },
  });
  return { onApply, onClear, ...utils, user };
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

  // Regression coverage: an external clear (e.g. another part of the UI clearing this
  // filter, or an undo/redo) that lands while the "from" field is focused must not strand
  // the stale displayed date forever. The focus guard legitimately suppresses the resync
  // while focused, but losing focus must flush it.
  it('re-syncs the displayed "from" value on blur after an external change while focused', async () => {
    const { user, setProps } = setup({ currentValue: { from: '2024-01-15', to: '2024-01-20' } });

    const fromField = getDateField(localeText.filterWidgetDateFromLabel);
    const monthSection = within(fromField).getByRole('spinbutton', { name: 'Month' });
    await user.click(monthSection);
    expect(monthSection.textContent).toBe('01');

    // External clear while the field is still focused.
    setProps({ currentValue: null });

    // The focus guard suppresses the resync while focused, so the stale date is still shown.
    expect(monthSection.textContent).toBe('01');

    // Losing focus must flush the resync so the stale value doesn't persist past a blur.
    await user.click(document.body);

    expect(monthSection.textContent).toBe('MM');
    expect(within(fromField).getByRole('spinbutton', { name: 'Day' }).textContent).toBe('DD');
    expect(within(fromField).getByRole('spinbutton', { name: 'Year' }).textContent).toBe('YYYY');
  });

  // The blur resync above must not fight this control's OWN pending 300ms commit:
  // `currentValue` still holds the pre-edit value until the debounce fires, so resyncing on
  // blur reverted the field the user had just typed, only for the commit to land moments
  // later and fill it back in — a visible empty→filled flicker on every tab-out.
  it('does not revert its own in-flight edit when blurred before the commit fires', async () => {
    // Two things have to be true for this test to exercise the guard at all, and an earlier
    // version of it had neither:
    //
    //  - The edit must be a COMPLETE date. `DatePicker` fires `onChange` only once every
    //    section is filled, so a month-only edit never reaches `scheduleApply` and leaves
    //    `pendingApply.current` null — the guard is then simply not on the path.
    //  - `currentValue` must be non-null and DIFFERENT from what is typed. The blur handler
    //    resyncs via `setFrom(currentValue?.from ? … : null)`; against a null `currentValue`
    //    that is a null→null no-op which React bails on, so the field keeps the typed
    //    sections whether or not the guard exists.
    //
    // With a real pre-edit value the unguarded blur would visibly snap the field back to
    // March, which is the empty→filled flicker this guard was added to prevent.
    const { user, onApply } = setup({ currentValue: { from: '2024-03-20' } });

    const fromField = getDateField(localeText.filterWidgetDateFromLabel);
    const monthSection = within(fromField).getByRole('spinbutton', { name: 'Month' });
    expect(monthSection.textContent).toBe('03');

    await user.click(monthSection);
    // Fake timers mean no time passes while typing, so the commit scheduled by the final
    // keystroke is guaranteed to still be pending at the blur below.
    await user.keyboard('01152024');
    expect(monthSection.textContent).toBe('01');

    // Blur while the commit is still pending — `currentValue` still holds the March date.
    await user.click(document.body);

    expect(monthSection.textContent).toBe('01');

    // And once the commit lands, the typed value is what's displayed and what was applied —
    // the blur must not have produced a January→March→January flicker in between.
    await clock.tickAsync(DEBOUNCE_MS);
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ from: '2024-01-15', to: undefined });
    expect(monthSection.textContent).toBe('01');
  });

  describe('applying a new "from" date (debounced)', () => {
    // The control debounces `onApply` by 300ms so that typing into the date field doesn't
    // trigger a pipeline re-render per keystroke. The whole suite runs on fake timers, so
    // these tests step the clock explicitly instead of waiting on wall-clock time: nothing
    // here depends on how fast the machine is, and the exact boundary of the window is
    // asserted rather than approximated by an over-long sleep.
    it('calls onApply with the formatted value only once the debounce window has elapsed', async () => {
      const { user, onApply } = setup({ currentValue: null });

      const fromField = getDateField(localeText.filterWidgetDateFromLabel);
      const monthSection = within(fromField).getByRole('spinbutton', { name: 'Month' });
      await user.click(monthSection);
      await user.keyboard('01152024');

      expect(onApply).not.toHaveBeenCalled();

      // One tick short of the window: still nothing. This is what pins the debounce to its
      // documented duration — a shorter delay would have committed by now.
      await clock.tickAsync(DEBOUNCE_MS - 1);
      expect(onApply).not.toHaveBeenCalled();

      // Crossing the window commits exactly once, with the fully typed date.
      await clock.tickAsync(1);
      expect(onApply).toHaveBeenCalledExactlyOnceWith({ from: '2024-01-15', to: undefined });
    });

    it('cancels a pending debounced apply when clear is clicked before it fires (finding 2)', async () => {
      const { user, onApply, onClear } = setup({
        currentValue: { from: '2024-01-01', to: '2024-01-31' },
      });

      const fromField = getDateField(localeText.filterWidgetDateFromLabel);
      const monthSection = within(fromField).getByRole('spinbutton', { name: 'Month' });
      await user.click(monthSection);
      // A single keystroke is enough to schedule a debounced `onApply`.
      await user.keyboard('2');

      // Sanity-check that an apply really is pending: stopping one tick short of the window
      // leaves it unfired, so the `clear` below genuinely lands inside the window.
      await clock.tickAsync(DEBOUNCE_MS - 1);
      expect(onApply).not.toHaveBeenCalled();

      // Clear before the window elapses — this must cancel the scheduled `onApply` rather
      // than let it fire afterward and silently resurrect the just-cleared date range.
      // Uses `fireEvent.click` (not `user.click`) to avoid the Tooltip-wrapped icon button's
      // hover-open simulation, whose own delayed state update would otherwise land while the
      // clock is being stepped below and trip `vitest-fail-on-console`'s act() warning —
      // unrelated to what this test verifies.
      fireEvent.click(screen.getByRole('button', { name: localeText.filterWidgetClearAriaLabel }));

      expect(onClear).toHaveBeenCalledOnce();

      // Run every remaining timer, not just past the window, so a merely-rescheduled (rather
      // than cancelled) apply would still be caught.
      await clock.tickAsync(DEBOUNCE_MS * 10);
      expect(onApply).not.toHaveBeenCalled();
    });

    it('cancels a pending debounced apply when the value is cleared EXTERNALLY (M8)', async () => {
      // Regression for M8: only this control's OWN Clear button cancelled the pending commit,
      // so every other clear surface raced it. Clearing this widget's row from the drawer's
      // Interactive filters section (`clearInteractiveFilter`) within the 300ms window emptied
      // the store, the blur handler then declined to resync because `pendingApply.current !==
      // null`, and the timer fired `onApply(value)` ~300ms later — re-creating the filter the
      // user had just cleared.
      const { user, onApply, setProps } = setup({
        currentValue: { from: '2024-01-01', to: '2024-01-31' },
      });

      const fromField = getDateField(localeText.filterWidgetDateFromLabel);
      await user.click(within(fromField).getByRole('spinbutton', { name: 'Month' }));
      await user.keyboard('2');

      // The apply really is pending: one tick short of the window leaves it unfired.
      await clock.tickAsync(DEBOUNCE_MS - 1);
      expect(onApply).not.toHaveBeenCalled();

      // The external clear arrives as a new `currentValue` — no local Clear click involved.
      setProps({ currentValue: null });

      // Drain every remaining timer so a merely-rescheduled apply would still be caught.
      await clock.tickAsync(DEBOUNCE_MS * 10);
      expect(onApply).not.toHaveBeenCalled();
    });

    it('cancels a pending debounced apply when an external edit replaces the range (M8)', async () => {
      // The same race for a non-null external transition — an undo/redo or a preset landing
      // inside the window. The externally stored value is authoritative; the stale in-flight
      // commit must not overwrite it moments later.
      const { user, onApply, setProps } = setup({
        currentValue: { from: '2024-01-01', to: '2024-01-31' },
      });

      const fromField = getDateField(localeText.filterWidgetDateFromLabel);
      await user.click(within(fromField).getByRole('spinbutton', { name: 'Month' }));
      await user.keyboard('2');
      await clock.tickAsync(DEBOUNCE_MS - 1);
      expect(onApply).not.toHaveBeenCalled();

      setProps({ currentValue: { from: '2023-06-01', to: '2023-06-30' } });

      await clock.tickAsync(DEBOUNCE_MS * 10);
      expect(onApply).not.toHaveBeenCalled();
    });
  });
});
