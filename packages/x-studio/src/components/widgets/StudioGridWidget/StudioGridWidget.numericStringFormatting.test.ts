/**
 * A `number` field's `valueFormatter` used to discriminate on the VALUE's runtime type:
 * any `string` was assumed to be a pre-formatted cell from the pinned summary row and
 * passed straight through. But `aggregate.ts` documents that CSV/JSON sources routinely
 * deliver measures as numeric strings, and L1 `normalizeDataSourceRows` canonicalizes
 * only `date`/`datetime` — numbers are never coerced. So an ordinary data cell holding
 * `'1234.5'` took the summary branch and rendered raw, while the pinned summary row and
 * a KPI over the same field both rendered `$1,234.50`: three renderings of one column,
 * with the currency symbol missing from the only place users read individual values.
 *
 * The discriminator must be the ROW (the pinned summary row is stamped
 * `__rowId: '__summary__'`), not the value type.
 */
import { describe, expect, it } from 'vitest';
import type { GridColDef, GridValidRowModel } from '@mui/x-data-grid-premium';
import type { StudioDataSource } from '../../../models';
import { GRID_SUMMARY_ROW_ID, buildGridColumnDefs } from './StudioGridWidget';

const dataSource: StudioDataSource = {
  id: 'sales',
  label: 'Sales',
  fields: [
    { id: 'id', label: 'ID', type: 'string' },
    {
      id: 'amount',
      label: 'Amount',
      type: 'number',
      format: 'currency',
      currencyCode: 'USD',
      precision: 2,
    },
  ],
  rows: [],
};

function amountFormatter() {
  const columns = buildGridColumnDefs(['amount'], dataSource, [], new Map(), false, undefined);
  const column = columns.find((c) => c.field === 'amount')!;
  const formatter = column.valueFormatter!;
  return (value: unknown, row: GridValidRowModel) =>
    (formatter as (v: unknown, r: GridValidRowModel, c: GridColDef, a: unknown) => string)(
      value,
      row,
      column,
      null,
    );
}

describe('buildGridColumnDefs numeric formatting', () => {
  it('formats a numeric-string data cell the same as a native number', () => {
    const format = amountFormatter();
    const dataRow = { id: 'r1', amount: '1234.5' };
    expect(format('1234.5', dataRow)).toBe(format(1234.5, { id: 'r1', amount: 1234.5 }));
    expect(format('1234.5', dataRow)).toBe('$1,234.50');
  });

  it('passes the pinned summary row cell through unformatted', () => {
    const format = amountFormatter();
    const summaryRow = { amount: 'Total: $1,234.50', __rowId: GRID_SUMMARY_ROW_ID };
    expect(format('Total: $1,234.50', summaryRow)).toBe('Total: $1,234.50');
  });

  it('leaves a genuinely non-numeric data cell alone', () => {
    const format = amountFormatter();
    expect(format('n/a', { id: 'r1', amount: 'n/a' })).toBe('n/a');
    expect(format(null, { id: 'r1', amount: null })).toBe('');
    expect(format(undefined, { id: 'r1' })).toBe('');
  });

  it('formats a zero and an empty string correctly', () => {
    const format = amountFormatter();
    expect(format(0, { id: 'r1', amount: 0 })).toBe('$0.00');
    expect(format('0', { id: 'r1', amount: '0' })).toBe('$0.00');
    // `Number('')` is 0 — an empty cell must not become "$0.00".
    expect(format('', { id: 'r1', amount: '' })).toBe('');
  });
});
