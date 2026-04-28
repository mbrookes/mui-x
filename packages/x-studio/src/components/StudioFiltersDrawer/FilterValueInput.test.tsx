import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { FilterValueInput } from './FilterValueInput';

const mockDataSources = {
  metrics: {
    id: 'metrics',
    label: 'Metrics',
    fields: [{ id: 'value', type: 'number' }],
    rows: [{ id: 'BM-001', name: 'Pipeline', value: 12 }],
  },
};

vi.mock('../../context', () => ({
  useStudioSelector: (selector: (state: { dataSources: typeof mockDataSources }) => unknown) =>
    selector({ dataSources: mockDataSources }),
}));

const { render } = createRenderer();

describe('FilterValueInput', () => {
  it('renders the metric picker inline for relative date inputs and shows the selected metric hint', () => {
    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 3, unit: 'day', direction: 'past' }}
        valueRef={{ sourceId: 'metrics', rowId: 'BM-001', field: 'value' }}
        onChange={() => {}}
        onValueRefChange={() => {}}
      />,
    );

    const amountFieldRoot = screen.getByLabelText('Amount').closest('.MuiFormControl-root');
    const metricButton = screen.getByRole('button', { name: 'Set from metric' });

    expect(amountFieldRoot).not.toBe(null);
    expect(metricButton.parentElement).toBe(amountFieldRoot?.parentElement);
    expect(screen.getByText('Pipeline')).not.toBe(null);
  });

  it('clears the metric selection when the relative date amount is manually edited', () => {
    const handleChange = vi.fn();
    const handleValueRefChange = vi.fn();

    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 3, unit: 'day', direction: 'past' }}
        valueRef={{ sourceId: 'metrics', rowId: 'BM-001', field: 'value' }}
        onChange={handleChange}
        onValueRefChange={handleValueRefChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } });

    expect(handleChange).toHaveBeenCalledWith({
      relative: true,
      amount: 5,
      unit: 'day',
      direction: 'past',
    });
    expect(handleValueRefChange).toHaveBeenCalledWith(undefined);
  });

  it('applies a selected metric to the relative date amount', () => {
    const handleChange = vi.fn();
    const handleValueRefChange = vi.fn();

    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 3, unit: 'day', direction: 'past' }}
        onChange={handleChange}
        onValueRefChange={handleValueRefChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set from metric' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pipeline' }));

    expect(handleChange).toHaveBeenCalledWith({
      relative: true,
      amount: 12,
      unit: 'day',
      direction: 'past',
    });
    expect(handleValueRefChange).toHaveBeenCalledWith({
      sourceId: 'metrics',
      rowId: 'BM-001',
      field: 'value',
    });
  });
});