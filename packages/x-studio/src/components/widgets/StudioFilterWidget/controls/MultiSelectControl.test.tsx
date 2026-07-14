import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../../../internals/test-utils';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../../../internals/StudioUIConfigContext';
import { MultiSelectControl } from './MultiSelectControl';

const { render } = createRenderer();

const localeText = DEFAULT_STUDIO_LOCALE_TEXT;

function setup(props: Partial<React.ComponentProps<typeof MultiSelectControl>> = {}) {
  const onApply = vi.fn();
  const onClear = vi.fn();
  const { wrapper } = createStudioHarness();
  const utils = render(
    <MultiSelectControl
      label="Country"
      values={['US', 'DE', 'FR']}
      selected={[]}
      onApply={onApply}
      onClear={onClear}
      {...props}
    />,
    { wrapper },
  );
  return { onApply, onClear, ...utils };
}

async function openSelect(user: ReturnType<typeof setup>['user']) {
  await user.click(screen.getByRole('combobox'));
}

describe('MultiSelectControl', () => {
  it('renders one option per value when opened', async () => {
    const { user } = setup();
    await openSelect(user);

    // MUI computes each option's accessible name from both its checkbox's
    // aria-label and its ListItemText (e.g. "US US") — match loosely rather
    // than anchoring to the raw value.
    expect(screen.getByRole('option', { name: /\bUS\b/ })).not.toBe(null);
    expect(screen.getByRole('option', { name: /\bDE\b/ })).not.toBe(null);
    expect(screen.getByRole('option', { name: /\bFR\b/ })).not.toBe(null);
  });

  it('filters visible options by a case-insensitive search substring', async () => {
    const { user } = setup();
    await openSelect(user);

    const search = screen.getByRole('textbox', { name: localeText.filterSearchValues });
    await user.type(search, 'de');

    expect(screen.getByRole('option', { name: /\bDE\b/ })).not.toBe(null);
    expect(screen.queryByRole('option', { name: /\bUS\b/ })).toBe(null);
    expect(screen.queryByRole('option', { name: /\bFR\b/ })).toBe(null);
  });

  it('shows a no-options hint when the search matches nothing', async () => {
    const { user } = setup();
    await openSelect(user);

    const search = screen.getByRole('textbox', { name: localeText.filterSearchValues });
    await user.type(search, 'zzz');

    expect(screen.getByText(localeText.filterWidgetNoOptionsLabel)).not.toBe(null);
  });

  it('applies all values when "Select all" is clicked', async () => {
    const { user, onApply } = setup();
    await openSelect(user);

    await user.click(screen.getByRole('button', { name: localeText.filterWidgetSelectAllLabel }));

    expect(onApply).toHaveBeenCalledWith(['US', 'DE', 'FR']);
  });

  // Regression coverage for architecture-review finding 3.13: "Select all" used to apply
  // every `values` regardless of the active search, disagreeing with the drawer's
  // `SelectionFilterInput`, whose select-all operates on the filtered subset only.
  it('applies only the filtered subset when "Select all" is clicked with an active search', async () => {
    const { user, onApply } = setup();
    await openSelect(user);

    const search = screen.getByRole('textbox', { name: localeText.filterSearchValues });
    await user.type(search, 'de');

    await user.click(screen.getByRole('button', { name: localeText.filterWidgetSelectAllLabel }));

    expect(onApply).toHaveBeenCalledWith(['DE']);
  });

  it('clears the selection when "Clear all" is clicked', async () => {
    const { user, onClear } = setup({ selected: ['US', 'DE'] });
    await openSelect(user);

    await user.click(screen.getByRole('button', { name: localeText.filterWidgetClearAllLabel }));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it('does not render an exclude toggle when onExcludeChange is not passed', async () => {
    const { user } = setup();
    await openSelect(user);

    expect(screen.queryByRole('button', { name: localeText.filterWidgetExcludeLabel })).toBe(null);
  });

  it('toggles include/exclude mode and reflects it via aria-pressed', async () => {
    const onExcludeChange = vi.fn();
    const { user } = setup({ onExcludeChange });
    await openSelect(user);

    const excludeButton = screen.getByRole('button', {
      name: localeText.filterWidgetExcludeLabel,
    });
    expect(excludeButton.getAttribute('aria-pressed')).toBe('false');

    await user.click(excludeButton);
    expect(onExcludeChange).toHaveBeenCalledWith(true);
  });

  it('reflects the exclude state via aria-pressed and label when exclude is active', async () => {
    const onExcludeChange = vi.fn();
    const { user } = setup({ exclude: true, onExcludeChange });
    await openSelect(user);

    const excludingButton = screen.getByRole('button', {
      name: localeText.filterWidgetExcludingLabel,
    });
    expect(excludingButton.getAttribute('aria-pressed')).toBe('true');

    await user.click(excludingButton);
    expect(onExcludeChange).toHaveBeenCalledWith(false);
  });

  it('applies the updated selection when an option checkbox is checked', async () => {
    const { user, onApply } = setup();
    await openSelect(user);

    await user.click(screen.getByRole('checkbox', { name: 'US' }));

    expect(onApply).toHaveBeenCalledWith(['US']);
  });

  it('clears when the last checked option is unchecked', async () => {
    const { user, onClear } = setup({ selected: ['US'] });
    await openSelect(user);

    await user.click(screen.getByRole('checkbox', { name: 'US' }));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it('shows the clear affordance and clears when it is clicked', async () => {
    const { user, onClear } = setup({ selected: ['US'] });

    await user.click(screen.getByRole('button', { name: localeText.filterWidgetClearAriaLabel }));

    expect(onClear).toHaveBeenCalledOnce();
  });
});
