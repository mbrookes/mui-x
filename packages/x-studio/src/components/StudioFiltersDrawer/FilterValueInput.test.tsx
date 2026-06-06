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
  products: {
    id: 'products',
    label: 'Products',
    fields: [{ id: 'price', type: 'number' }],
    rows: [{ id: 'P-001', name: 'Helmet', price: 55 }],
  },
};

vi.mock('../context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context')>();
  return {
    ...actual,
    useStudioSelector: (selector: (state: { dataSources: typeof mockDataSources }) => unknown) =>
      selector({ dataSources: mockDataSources }),
  };
});

const { render } = createRenderer();

describe('FilterValueInput', () => {
  it('renders the link button inline with the amount field for relative date inputs', async () => {
    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 3, unit: 'day', direction: 'past' }}
        onChange={() => {}}
        onValueRefChange={() => {}}
      />,
    );

    const amountField = await screen.findByLabelText('Amount');
    const linkButton = screen.getByRole('button', { name: 'Link to field' });

    // input > MuiInputBase-root > MuiFormControl-root > flex Box
    expect(amountField.parentElement?.parentElement?.parentElement).toBe(linkButton.parentElement);
  });

  it('shows the linked field name as hint text when a valueRef is set', () => {
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

    expect(screen.getByText('Pipeline')).not.toBe(null);
  });

  it('disables the amount field and shows remove-link button when a field is linked', () => {
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

    expect((screen.getByLabelText('Amount') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Link to field' })).toBe(null);
    expect(screen.getByRole('button', { name: 'Remove field link' })).not.toBe(null);
  });

  it('clears the field link when the remove-link button is clicked', () => {
    const handleValueRefChange = vi.fn();

    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 12, unit: 'day', direction: 'past' }}
        valueRef={{ sourceId: 'metrics', rowId: 'BM-001', field: 'value' }}
        onChange={() => {}}
        onValueRefChange={handleValueRefChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove field link' }));

    expect(handleValueRefChange).toHaveBeenCalledWith(undefined);
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
        // react-doctor-disable-next-line react-doctor/no-generic-handler-names -- test spy named generically intentionally
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

  it('applies a selected field to the relative date amount and sets valueRef', () => {
    const handleChange = vi.fn();
    const handleValueRefChange = vi.fn();

    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 3, unit: 'day', direction: 'past' }}
        // react-doctor-disable-next-line react-doctor/no-generic-handler-names -- test spy named generically intentionally
        onChange={handleChange}
        onValueRefChange={handleValueRefChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Link to field' }));
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

  it('shows all sources with suitable fields in the picker menu', () => {
    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 3, unit: 'day', direction: 'past' }}
        onChange={() => {}}
        onValueRefChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Link to field' }));

    expect(screen.getByRole('menuitem', { name: 'Pipeline' })).not.toBe(null);
    expect(screen.getByRole('menuitem', { name: 'Helmet' })).not.toBe(null);
  });

  it('supports an atomic field link callback', () => {
    const handleChange = vi.fn();
    const handleMetricSelect = vi.fn();

    render(
      <FilterValueInput
        fieldType="date"
        operator="greater_than"
        value={{ relative: true, amount: 3, unit: 'day', direction: 'past' }}
        // react-doctor-disable-next-line react-doctor/no-generic-handler-names -- test spy named generically intentionally
        onChange={handleChange}
        onValueRefChange={() => {}}
        onMetricSelect={handleMetricSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Link to field' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pipeline' }));

    expect(handleChange).not.toHaveBeenCalled();
    expect(handleMetricSelect).toHaveBeenCalledWith(
      {
        relative: true,
        amount: 12,
        unit: 'day',
        direction: 'past',
      },
      {
        sourceId: 'metrics',
        rowId: 'BM-001',
        field: 'value',
      },
    );
  });
});
