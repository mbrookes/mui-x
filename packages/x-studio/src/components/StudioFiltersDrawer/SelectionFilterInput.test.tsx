import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
import { SelectionFilterInput } from './SelectionFilterInput';
import { FIELD_VALUES_CAP } from './useFieldValues';

const { render } = createRenderer();

/**
 * Regression coverage for architecture-review finding 2.20: the high-cardinality cap hint
 * was a hardcoded English string with a code comment deferring localization. It must now
 * route through the `filterSelectionCapHint` locale key (added to `internals/localeText.ts`
 * and translated in every locale bundle) instead of a literal English template string.
 */
describe('SelectionFilterInput cap hint localization (finding 2.20)', () => {
  it('renders the English cap hint via the locale key when values reach the cap', () => {
    const values = Array.from({ length: FIELD_VALUES_CAP }, (_, i) => `v${i}`);
    render(<SelectionFilterInput values={values} selected={[]} onChange={vi.fn()} />);

    expect(
      screen.getByText(`Showing the first ${FIELD_VALUES_CAP} values. Type to narrow the list.`),
    ).not.toBe(null);
  });

  it('does not render the cap hint when values are below the cap', () => {
    const values = ['a', 'b', 'c'];
    render(<SelectionFilterInput values={values} selected={[]} onChange={vi.fn()} />);

    expect(screen.queryByTestId('selection-filter-cap-hint')).toBe(null);
  });

  it('renders a translated cap hint under a non-English locale', async () => {
    const { frLocaleText } = await import('../../locales/fr');
    const { StudioUIConfigContext } = await import('../../internals/StudioUIConfigContext');
    const values = Array.from({ length: FIELD_VALUES_CAP }, (_, i) => `v${i}`);
    const mergedLocaleText = { ...DEFAULT_STUDIO_LOCALE_TEXT, ...frLocaleText };
    render(
      <StudioUIConfigContext.Provider
        value={{
          tableSourceMode: 'explicit',
          localeText: mergedLocaleText,
          featureFlags: {},
        }}
      >
        <SelectionFilterInput values={values} selected={[]} onChange={vi.fn()} />
      </StudioUIConfigContext.Provider>,
    );

    expect(screen.getByTestId('selection-filter-cap-hint').textContent).toBe(
      mergedLocaleText.filterSelectionCapHint(FIELD_VALUES_CAP),
    );
    expect(
      screen.queryByText(`Showing the first ${FIELD_VALUES_CAP} values. Type to narrow the list.`),
    ).toBe(null);
  });
});

// Regression for finding 5: the checkboxes had no accessible name at all. `role="checkbox"`
// takes its name from the author, not from the adjacent (unassociated) Typography, so a screen
// reader announced a column of anonymous "checkbox" controls.
describe('SelectionFilterInput accessible names (finding 5)', () => {
  it('names each value checkbox after the value it toggles', () => {
    render(<SelectionFilterInput values={['DE', 'FR']} selected={['DE']} onChange={vi.fn()} />);

    const de = screen.getByRole('checkbox', { name: 'DE' }) as HTMLInputElement;
    const fr = screen.getByRole('checkbox', { name: 'FR' }) as HTMLInputElement;
    expect(de.checked).toBe(true);
    expect(fr.checked).toBe(false);
  });

  it('names the select-all checkbox and toggles every visible value through it', () => {
    const onChange = vi.fn();
    render(<SelectionFilterInput values={['DE', 'FR']} selected={[]} onChange={onChange} />);

    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
    fireEvent.click(selectAll);
    expect(onChange).toHaveBeenCalledWith(['DE', 'FR']);
  });
});
