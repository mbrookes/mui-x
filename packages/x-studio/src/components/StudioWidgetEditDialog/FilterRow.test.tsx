import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioFilterState } from '../../models';
import { FilterRow, type FieldOption } from './FilterRow';

const { render } = createRenderer();

function makeFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'f1',
    field: 'amount',
    operator: 'equals',
    value: '',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

const numberField: FieldOption = { id: 'amount', label: 'Amount', type: 'number' };

describe('FilterRow', () => {
  it('renders the "Between" operator label for a between filter on a number field', () => {
    // Regression for finding #6: `between` used to be missing from the drawer's
    // operator table but present here — this only asserts FilterRow itself still
    // offers/labels it; the cross-surface round-trip is covered in
    // `StudioFiltersDrawer/filterOperatorMetadata.test.ts`.
    render(
      <FilterRow
        filter={makeFilter({ field: 'amount', operator: 'between', fieldType: 'number' })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.getByText('Between')).not.toBe(null);
  });

  it('hides the value input for is_empty/is_not_empty operators', () => {
    const { rerender } = render(
      <FilterRow
        filter={makeFilter({ field: 'amount', operator: 'is_empty', fieldType: 'number' })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.queryByPlaceholderText('Value')).toBe(null);

    rerender(
      <FilterRow
        filter={makeFilter({ field: 'amount', operator: 'equals', fieldType: 'number' })}
        fieldOptions={[numberField]}
        onRemove={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText('Value')).not.toBe(null);
  });

  it('calls onRemove when the delete button is clicked', () => {
    const onRemove = vi.fn();
    render(
      <FilterRow
        filter={makeFilter()}
        fieldOptions={[numberField]}
        onRemove={onRemove}
        onUpdate={() => {}}
      />,
    );
    screen.getByRole('button').click();
    expect(onRemove).toHaveBeenCalled();
  });
});
