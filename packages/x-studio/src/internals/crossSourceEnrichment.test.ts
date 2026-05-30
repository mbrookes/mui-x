import { describe, expect, it } from 'vitest';

import { enrichWithCrossSourceColumns } from './crossSourceEnrichment';
import type { StudioDataSource, StudioRelationship } from '../models';

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
});
