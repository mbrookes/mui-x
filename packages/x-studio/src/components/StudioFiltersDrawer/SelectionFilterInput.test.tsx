import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
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
