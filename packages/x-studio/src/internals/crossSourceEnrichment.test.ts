import { describe, expect, it } from 'vitest';

import { enrichWithCrossSourceColumns } from './crossSourceEnrichment';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';

const relationships: StudioRelationship[] = [
  {
    id: 'rel-orders-customers',
    type: 'many-to-one',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
  },
];

const customerSource: StudioDataSource = {
  id: 'customers',
  label: 'Customers',
  fields: [
    { id: 'id', label: 'ID', type: 'string' },
    { id: 'company', label: 'Company', type: 'string' },
    { id: 'segment', label: 'Segment', type: 'string' },
  ],
  rows: [
    { id: 'c1', company: 'Acme', segment: 'Enterprise' },
    { id: 'c2', company: 'Globex', segment: 'SMB' },
  ],
};

const dataSources: Record<string, StudioDataSource> = {
  customers: customerSource,
};

const orderRows = [
  { id: 'o1', customerId: 'c1', total: 100 },
  { id: 'o2', customerId: 'c2', total: 50 },
  { id: 'o3', customerId: 'c1', total: 75 },
];

describe('enrichWithCrossSourceColumns', () => {
  it('returns rows unchanged when there are no cross-source columns', () => {
    const columns = [{ fieldId: 'id' }, { fieldId: 'total' }];
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      columns,
      dataSources,
      relationships,
    );
    expect(result).toBe(orderRows); // same reference
  });

  it('joins across a numeric-vs-string FK/PK type mismatch (shared normalizeJoinKey policy)', () => {
    // orders.customerId is numeric, customers.id is a string — a realistic type drift.
    const numericFkOrders = [
      { id: 'o1', customerId: 1, total: 100 },
      { id: 'o2', customerId: 2, total: 50 },
    ];
    const stringPkCustomers: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'company', label: 'Company', type: 'string' },
      ],
      rows: [
        { id: '1', company: 'Acme' },
        { id: '2', company: 'Globex' },
      ],
    };
    const result = enrichWithCrossSourceColumns(
      numericFkOrders,
      'orders',
      [{ fieldId: 'company', sourceId: 'customers' }],
      { customers: stringPkCustomers },
      relationships,
    );
    expect(result[0]).toMatchObject({ id: 'o1', company: 'Acme' });
    expect(result[1]).toMatchObject({ id: 'o2', company: 'Globex' });
  });

  it('joins a many-to-one related source field onto primary rows', () => {
    const columns = [
      { fieldId: 'id' },
      { fieldId: 'total' },
      { fieldId: 'company', sourceId: 'customers' },
    ];
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      columns,
      dataSources,
      relationships,
    );

    expect(result[0]).toMatchObject({ id: 'o1', total: 100, company: 'Acme' });
    expect(result[1]).toMatchObject({ id: 'o2', total: 50, company: 'Globex' });
    expect(result[2]).toMatchObject({ id: 'o3', total: 75, company: 'Acme' });
  });

  it('joins multiple fields from the same related source in one pass', () => {
    const columns = [
      { fieldId: 'id' },
      { fieldId: 'company', sourceId: 'customers' },
      { fieldId: 'segment', sourceId: 'customers' },
    ];
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      columns,
      dataSources,
      relationships,
    );

    expect(result[0]).toMatchObject({ company: 'Acme', segment: 'Enterprise' });
    expect(result[1]).toMatchObject({ company: 'Globex', segment: 'SMB' });
  });

  it('L1-normalizes a related-source date column to a canonical string (finding 4)', () => {
    // `joinedDate` lives on the related source (`customers`) and carries a RAW `Date` object —
    // exactly what an un-normalized foreign-source read still has, unlike the widget's own
    // `useWidgetRows`-normalized rows. Before the fix, `enrichWithCrossSourceFields` read
    // `dataSources[ref.sourceId]?.rows` directly, so this cross-source display column (a grid
    // column or map field referencing a related source) stayed a raw `Date` object here —
    // bucketing differently than an L1-normalized date on the primary source for a non-UTC
    // viewer.
    const dateDataSources: Record<string, StudioDataSource> = {
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'joinedDate', label: 'Joined Date', type: 'date' },
        ],
        rows: [
          { id: 'c1', joinedDate: new Date(2024, 0, 15) },
          { id: 'c2', joinedDate: new Date(2024, 2, 3) },
        ],
      },
    };
    const columns = [{ fieldId: 'id' }, { fieldId: 'joinedDate', sourceId: 'customers' }];
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      columns,
      dateDataSources,
      relationships,
    );
    expect(typeof result[0].joinedDate).toBe('string');
    expect(result[0].joinedDate).toBe('2024-01-15'); // o1 → c1
    expect(result[1].joinedDate).toBe('2024-03-03'); // o2 → c2
  });

  it('skips cross-source columns with no declared relationship', () => {
    const columns = [
      { fieldId: 'productName', sourceId: 'products' }, // no relationship declared
    ];
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      columns,
      dataSources,
      relationships,
    );
    expect(result).toBe(orderRows); // returns same reference, no enrichment
    expect(result[0].productName).toBeUndefined();
  });

  it('skips cross-source columns whose related source has no in-memory rows', () => {
    const sourcesNoRows: Record<string, StudioDataSource> = {
      customers: { ...customerSource, rows: undefined },
    };
    const columns = [{ fieldId: 'company', sourceId: 'customers' }];
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      columns,
      sourcesNoRows,
      relationships,
    );
    expect(result).toBe(orderRows);
    expect(result[0].company).toBeUndefined();
  });

  it('does not mutate the original rows', () => {
    const original = [{ id: 'o1', customerId: 'c1', total: 100 }];
    const columns = [{ fieldId: 'company', sourceId: 'customers' }];
    const result = enrichWithCrossSourceColumns(
      original,
      'orders',
      columns,
      dataSources,
      relationships,
    );
    expect(result).not.toBe(original);
    expect((original[0] as Record<string, unknown>).company).toBeUndefined(); // original unchanged
  });

  it('does not overwrite a primary column value when a cross-source column shares its bare field id (finding T1.2)', () => {
    // Both `orders` and `customers` own a `name` field. A cross-source `customers.name`
    // column must NOT clobber the primary `orders.name` cell on every joined row.
    const namedOrders = [
      { id: 'o1', customerId: 'c1', name: 'Order One' },
      { id: 'o2', customerId: 'c2', name: 'Order Two' },
    ];
    const namedCustomers: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'name', label: 'Name', type: 'string' },
      ],
      rows: [
        { id: 'c1', name: 'Acme' },
        { id: 'c2', name: 'Globex' },
      ],
    };
    const result = enrichWithCrossSourceColumns(
      namedOrders,
      'orders',
      [{ fieldId: 'name' }, { fieldId: 'name', sourceId: 'customers' }],
      { customers: namedCustomers },
      relationships,
    );
    // The primary `name` survives; each row is returned un-cloned since the guard
    // skipped the colliding cross-source write (row object identity preserved).
    expect(result[0]).toBe(namedOrders[0]);
    expect(result[1]).toBe(namedOrders[1]);
    expect(result[0].name).toBe('Order One');
    expect(result[1].name).toBe('Order Two');
  });

  it('handles a missing FK value gracefully (no match → field stays undefined)', () => {
    const rowsWithBadFk = [{ id: 'o99', customerId: 'unknown', total: 0 }];
    const columns = [{ fieldId: 'company', sourceId: 'customers' }];
    const result = enrichWithCrossSourceColumns(
      rowsWithBadFk,
      'orders',
      columns,
      dataSources,
      relationships,
    );
    expect(result[0].company).toBeUndefined();
  });

  it('returns unchanged rows when widgetSourceId is undefined', () => {
    const columns = [{ fieldId: 'company', sourceId: 'customers' }];
    const result = enrichWithCrossSourceColumns(
      orderRows,
      undefined,
      columns,
      dataSources,
      relationships,
    );
    expect(result).toBe(orderRows);
  });

  // ─── Related-source EXPRESSION (calculated) columns (finding 2.3) ──────────────
  //
  // A related source's calculated column (a non-measure expression field owned by that
  // source) has no value on its RAW rows — it only exists after an L2 pass. The setup
  // panel offers such columns, but without passing `expressionFields` the enrichment
  // indexes the raw related rows and resolves every value to `undefined`. Passing
  // `expressionFields` routes the related source through the shared L2 cache first.

  // customers.bonus = spend * 2 (a calculated column owned by the customers source).
  const customerBonusExpr: StudioExpressionField = {
    id: 'bonus',
    label: 'Bonus',
    sourceId: 'customers',
    isMeasure: false,
    expression: {
      operator: 'multiply',
      inputs: [{ id: 'spend' }, { type: 'number', value: 2 }],
    },
  } as unknown as StudioExpressionField;

  const customersWithSpend: StudioDataSource = {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'spend', label: 'Spend', type: 'number' },
    ],
    rows: [
      { id: 'c1', spend: 100 },
      { id: 'c2', spend: 50 },
    ],
  };

  it('resolves a related-source calculated column to undefined when expressionFields are omitted', () => {
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      [{ fieldId: 'bonus', sourceId: 'customers' }],
      { customers: customersWithSpend },
      relationships,
      // No expressionFields passed — the raw related rows have no `bonus`.
    );
    expect(result[0].bonus).toBeUndefined();
  });

  it('resolves a related-source calculated column via the L2 pass when expressionFields are provided', () => {
    const result = enrichWithCrossSourceColumns(
      orderRows,
      'orders',
      [{ fieldId: 'bonus', sourceId: 'customers' }],
      { customers: customersWithSpend },
      relationships,
      [customerBonusExpr],
    );
    // bonus = spend * 2 → c1: 200, c2: 100; fanned onto every order sharing the FK.
    expect(result[0]).toMatchObject({ id: 'o1', customerId: 'c1', bonus: 200 });
    expect(result[1]).toMatchObject({ id: 'o2', customerId: 'c2', bonus: 100 });
    expect(result[2]).toMatchObject({ id: 'o3', customerId: 'c1', bonus: 200 });
  });
});
