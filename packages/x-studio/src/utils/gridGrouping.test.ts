import { describe, expect, it } from 'vitest';

import { buildGroupedGridRows } from './gridGrouping';

describe('buildGroupedGridRows', () => {
  it('returns one row per group with aggregated numeric fields', () => {
    const rows = [
      { id: 'o1', company: 'Alpha', country: 'US', total: 10 },
      { id: 'o2', company: 'Alpha', country: 'US', total: 15 },
      { id: 'o3', company: 'Beta', country: 'DE', total: 25 },
    ];

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'country', 'id', 'total'],
      { id: 'count', total: 'sum' },
      'widget-1',
    );

    expect(result).toEqual([
      {
        __rowId: 'group-widget-1-0',
        company: 'Alpha',
        country: 'US',
        id: 2,
        total: 25,
      },
      {
        __rowId: 'group-widget-1-1',
        company: 'Beta',
        country: 'DE',
        id: 1,
        total: 25,
      },
    ]);
  });

  it('preserves a representative value for non-aggregated fields', () => {
    const rows = [
      { id: 'o1', company: 'Alpha', segment: 'Enterprise', total: 10 },
      { id: 'o2', company: 'Alpha', segment: 'Enterprise', total: 15 },
    ];

    const result = buildGroupedGridRows(
      rows,
      'company',
      ['company', 'segment', 'total'],
      { total: 'sum' },
      'widget-1',
    );

    expect(result[0]).toMatchObject({
      company: 'Alpha',
      segment: 'Enterprise',
      total: 25,
    });
  });
});