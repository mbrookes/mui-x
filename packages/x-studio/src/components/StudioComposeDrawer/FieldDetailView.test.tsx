import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { FieldDetailView } from './FieldDetailView';

const { render } = createRenderer();

const SOURCE = {
  id: 'src',
  label: 'Sales',
  fields: [{ id: 'amount', label: 'Amount', type: 'number' as const }],
  rows: [],
};

function renderFieldDetailView() {
  const { wrapper } = createStudioHarness({
    initialState: {
      runtime: { dataSources: { src: SOURCE } },
      session: {
        shell: {
          openDrawers: { data: true, compose: false, filters: false },
          selectedWidgetId: null,
          selectedFieldId: 'amount',
          selectedSourceId: 'src',
        },
      },
    },
  });
  return render(<FieldDetailView />, { wrapper });
}

/**
 * Regression coverage for architecture-review Tier3 finding #9: the number-format label used
 * a STATIC DOM id (`"field-number-format-label"`), breaking the documented multi-instance
 * guarantee — two mounted `<Studio>` instances showing the field detail view at the same time
 * would emit duplicate ids. `StudioDateRangeBar.tsx` already fixes the analogous case via
 * `React.useId()`; `FieldDetailView` now does the same.
 */
describe('FieldDetailView number-format label id (Tier3 #9)', () => {
  it('does not use the legacy static id', () => {
    renderFieldDetailView();
    expect(document.getElementById('field-number-format-label')).toBe(null);
  });

  it('produces distinct label ids across two simultaneously-mounted instances', () => {
    const { container: containerA } = renderFieldDetailView();
    const { container: containerB } = renderFieldDetailView();

    const selectA = within(containerA).getByRole('combobox');
    const selectB = within(containerB).getByRole('combobox');
    const labelIdA = selectA.getAttribute('aria-labelledby');
    const labelIdB = selectB.getAttribute('aria-labelledby');
    expect(labelIdA).toBeTruthy();
    expect(labelIdB).toBeTruthy();
    // The two mounted instances must never collide on the same DOM id.
    expect(labelIdA).not.toBe(labelIdB);

    // Each Select's `aria-labelledby` must resolve to a label that actually lives in ITS
    // OWN container, not the other instance's.
    expect(within(containerA).getByText('Number Format', { selector: `#${labelIdA}` })).not.toBe(
      null,
    );
    expect(within(containerB).getByText('Number Format', { selector: `#${labelIdB}` })).not.toBe(
      null,
    );
  });

  it('still renders the number format Select with the expected label text', () => {
    renderFieldDetailView();
    // MUI's outlined variant renders the label text twice (the floating label + the
    // fieldset legend notch) — assert at least one match rather than a single unique node.
    expect(screen.getAllByText('Number Format').length).toBeGreaterThan(0);
  });
});
