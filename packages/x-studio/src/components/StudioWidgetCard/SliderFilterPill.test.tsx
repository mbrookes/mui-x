import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { formatFieldValue } from '@mui/x-studio-core/engine';
import type { StudioDataField, StudioDataSource } from '../../models';
import { SliderFilterPill } from './SliderFilterPill';

const { render } = createRenderer();

/**
 * The pill renders the same range as the `SliderControl` sitting directly below it in the
 * filter widget, so the two must agree. Before this fix the pill used
 * `dayjs(v).format('DD MMM YYYY')` while the control had already moved to
 * `toLocaleDateString(undefined, …)` — under a German dashboard the control read
 * `15. Jan. 2024` and the pill `15 Jan 2024`, with DMY order fixed regardless of locale
 * (nothing in this package ever calls `dayjs.locale(...)`). The pill also ignored the field's
 * `format`/`currencyCode`/`precision` and omitted the field name entirely, so a bare
 * `10 – 100` chip with a delete affordance said nothing about what clearing it would clear.
 */

function makeSource(fields: StudioDataSource['fields']): StudioDataSource {
  return { id: 'orders', label: 'Orders', fields, rows: [] };
}

/** Expected date text, derived through the same `Intl` options the component uses. */
function expectDate(value: number) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

describe('<SliderFilterPill />', () => {
  it('formats a numeric range through the field format and prefixes the field label', () => {
    const amountField: StudioDataField = {
      id: 'amount',
      label: 'Amount',
      type: 'number',
      format: 'currency',
      currencyCode: 'USD',
    };
    render(
      <SliderFilterPill
        filter={{ field: 'amount', value: { from: 1000, to: 5000 } }}
        source={makeSource([amountField])}
        onClear={vi.fn()}
      />,
    );

    // The shared formatter every other surface uses for this field. The old
    // `Number(v).toLocaleString()` produced a bare `1,000` with no currency at all, so this
    // assertion fails against it while staying locale-independent.
    expect(
      screen.getByText(
        `Amount: ${formatFieldValue(1000, amountField)} – ${formatFieldValue(5000, amountField)}`,
      ),
    ).not.toBe(null);
  });

  it('formats a date range through the runtime locale, matching SliderControl', () => {
    const from = Date.UTC(2024, 0, 15);
    const to = Date.UTC(2024, 1, 20);
    render(
      <SliderFilterPill
        filter={{ field: 'ordered_at', value: { from, to } }}
        source={makeSource([{ id: 'ordered_at', label: 'Ordered at', type: 'date' }])}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText(`Ordered at: ${expectDate(from)} – ${expectDate(to)}`)).not.toBe(null);
  });

  it('resolves the label from an expression (computed) field too', () => {
    render(
      <SliderFilterPill
        filter={{ field: 'margin', value: { from: 1, to: 9 } }}
        source={makeSource([])}
        expressionFields={[
          {
            id: 'margin',
            label: 'Margin',
            sourceId: 'orders',
            isMeasure: false,
            expression: { id: 'amount' },
            type: 'number',
          },
        ]}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText(/^Margin: /)).not.toBe(null);
  });

  it('falls back to the raw field id when the field cannot be resolved', () => {
    render(
      <SliderFilterPill
        filter={{ field: 'unknown_field', value: { from: 10, to: 100 } }}
        source={undefined}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText(/^unknown_field: /)).not.toBe(null);
  });

  it('exposes a named delete control instead of an unlabeled icon', () => {
    const onClear = vi.fn();
    render(
      <SliderFilterPill
        filter={{ field: 'amount', value: { from: 1, to: 2 } }}
        source={makeSource([{ id: 'amount', label: 'Amount', type: 'number' }])}
        onClear={onClear}
      />,
    );

    // MUI's default `Chip` delete icon is an unlabeled `<svg>` with no role, so this control
    // previously had no accessible name at all.
    const remove = screen.getByRole('button', { name: 'Remove filter' });
    fireEvent.click(remove);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the filter has no value', () => {
    const { container } = render(
      <SliderFilterPill
        filter={{ field: 'amount', value: null }}
        source={makeSource([{ id: 'amount', label: 'Amount', type: 'number' }])}
        onClear={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });
});
