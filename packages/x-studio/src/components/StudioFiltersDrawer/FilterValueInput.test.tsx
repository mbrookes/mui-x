import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { FilterValueInput } from './FilterValueInput';

const { render } = createRenderer();

describe('FilterValueInput', () => {
  it('renders a text field for string operators', () => {
    render(
      <FilterValueInput fieldType="string" operator="contains" value="hello" onChange={() => {}} />,
    );
    expect(screen.getByRole('textbox')).not.toBe(null);
  });

  it('renders relative date input for date fields', () => {
    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 7, unit: 'day', direction: 'past' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText('Amount')).not.toBe(null);
  });

  it('renders nothing for is_empty operator', () => {
    const { container } = render(
      <FilterValueInput fieldType="string" operator="is_empty" value="" onChange={() => {}} />,
    );
    expect(container.firstChild).toBe(null);
  });
});
