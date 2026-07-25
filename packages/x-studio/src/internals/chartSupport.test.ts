import { describe, expect, it } from 'vitest';
import { resolveChartRowsForAggregation } from './chartSupport';
import { MAX_ENTRIES_PER_ROWS } from './rowCacheLru';
import type { StudioDataField, StudioDataSource, StudioRelationship } from '../models';

type Row = Record<string, unknown>;

const REL: StudioRelationship = {
  id: 'rel-orders-customers',
  type: 'many-to-one',
  sourceId: 'orders',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
};

const SIGNUP_AS_STRING: StudioDataField = { id: 'signupDate', label: 'Signup', type: 'string' };
const SIGNUP_AS_DATE: StudioDataField = { id: 'signupDate', label: 'Signup', type: 'date' };

// ─── L4 re-anchoring cache: foreign source `fields` dependency ────────────────

describe('resolveChartRowsForAggregation — foreign source fields dependency', () => {
  it('invalidates when a source it READ retypes a field without replacing its rows', () => {
    // The chart reads `customers` through `getCachedNormalizedDataSource`, which is keyed on
    // rows AND fields. `updateDataSourceField` commits a new `fields` array while leaving
    // `rows` reference-identical, so tracking rows alone kept serving the pre-retype
    // re-anchored rows — chart buckets split on a value the rest of the dashboard has
    // already canonicalized.
    const ordersRows: Row[] = [{ id: 'o1', customerId: 0, amount: 10 }];
    const customersRows: Row[] = [{ id: 0, signupDate: new Date('2024-01-15T12:00:00.000Z') }];

    const makeSources = (signupField: StudioDataField): Record<string, StudioDataSource> => ({
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'number' },
          { id: 'amount', label: 'Amount', type: 'number' },
        ],
        rows: ordersRows,
      },
      // SAME rows reference in both variants — only `fields` differs.
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'id', label: 'ID', type: 'number' }, signupField],
        rows: customersRows,
      },
    });

    // ONE relationships array and one expression-field array across both calls, so the only
    // thing that can invalidate the entry is the foreign source's `fields` ref.
    const rels = [REL];
    const exprFields: never[] = [];
    const resolve = (signupField: StudioDataField): Row[] =>
      resolveChartRowsForAggregation(
        ordersRows,
        'orders',
        'signupDate',
        ['amount'],
        undefined,
        makeSources(signupField),
        rels,
        exprFields,
      );

    const before = resolve(SIGNUP_AS_STRING);
    const after = resolve(SIGNUP_AS_DATE);

    expect(before).not.toBe(after);
    // Untyped, the joined value stays a raw Date; retyped, L1 canonicalizes it.
    expect(before[0].signupDate).toBeInstanceOf(Date);
    expect(after[0].signupDate).toBe('2024-01-15');
  });

  it('still hits the cache when nothing it depends on changed', () => {
    const ordersRows: Row[] = [{ id: 'o1', customerId: 0, amount: 10 }];
    const customersRows: Row[] = [{ id: 0, signupDate: new Date('2024-01-15T12:00:00.000Z') }];
    const dataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'number' },
          { id: 'amount', label: 'Amount', type: 'number' },
        ],
        rows: ordersRows,
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'id', label: 'ID', type: 'number' }, SIGNUP_AS_DATE],
        rows: customersRows,
      },
    };
    const rels = [REL];
    const first = resolveChartRowsForAggregation(
      ordersRows,
      'orders',
      'signupDate',
      ['amount'],
      undefined,
      dataSources,
      rels,
      [],
    );
    const second = resolveChartRowsForAggregation(
      ordersRows,
      'orders',
      'signupDate',
      ['amount'],
      undefined,
      dataSources,
      rels,
      [],
    );
    expect(second).toBe(first);
  });
});

// ─── L4 re-anchoring cache: shared LRU ───────────────────────────────────────
//
// The two WeakMap keys (widget rows × anchor rows) bound nothing on their own: the inner
// `configKey` is derived from widget config, which churns on every chart-config edit while
// both rows arrays stay alive, and each entry pins a full re-anchored result array.

describe('resolveChartRowsForAggregation — inner cache is LRU-bounded', () => {
  const ordersRows: Row[] = [{ id: 'o1', customerId: 0, amount: 10, m0: 1 }];
  const customersRows: Row[] = [{ id: 0, country: 'FR' }];
  const measureFields: StudioDataField[] = Array.from(
    { length: MAX_ENTRIES_PER_ROWS + 2 },
    (unused, i) => ({ id: `m${i}`, label: `M${i}`, type: 'number' }),
  );
  const dataSources: Record<string, StudioDataSource> = {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'number' },
        ...measureFields,
      ],
      rows: ordersRows,
    },
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'number' },
        { id: 'country', label: 'Country', type: 'string' },
      ],
      rows: customersRows,
    },
  };
  const rels = [REL];

  const resolve = (measure: string): Row[] =>
    resolveChartRowsForAggregation(
      ordersRows,
      'orders',
      'country',
      [measure],
      undefined,
      dataSources,
      rels,
      [],
    );

  it('evicts the least-recently-used config past MAX_ENTRIES_PER_ROWS', () => {
    const first = resolve('m0');
    expect(resolve('m0')).toBe(first);

    for (let i = 1; i <= MAX_ENTRIES_PER_ROWS; i += 1) {
      resolve(`m${i}`);
    }

    // `m0` aged out, so the config recomputes instead of being pinned forever.
    expect(resolve('m0')).not.toBe(first);
  });
});
