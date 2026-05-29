import { describe, expect, it } from 'vitest';
import {
  fillTemporalLabelGaps,
  formatPeriodLabel,
  formatTemporalAxisLabel,
  getTemporalAxisData,
  normalizeDataSourceRows,
  normalizeToDate,
  truncateToGranularity,
} from './temporalUtils';
import type { StudioDataSource } from '../models';

// ─── normalizeToDate ──────────────────────────────────────────────────────────

describe('normalizeToDate', () => {
  it('passes through a Date object unchanged', () => {
    const d = new Date('2024-03-15');
    expect(normalizeToDate(d)).toBe(d);
  });

  it('converts a numeric ms timestamp to Date', () => {
    const ms = new Date('2024-03-15').getTime();
    const result = normalizeToDate(ms);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getFullYear()).toBe(2024);
    expect((result as Date).getMonth()).toBe(2); // March = 2
  });

  it('converts an ISO date string to Date', () => {
    const result = normalizeToDate('2024-06-01');
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getFullYear()).toBe(2024);
  });

  it('returns null for unparseable string', () => {
    const result = normalizeToDate('not-a-date');
    expect(result).toBeNull();
  });
});

// ─── truncateToGranularity ────────────────────────────────────────────────────

describe('truncateToGranularity', () => {
  const d = new Date('2024-03-15');

  it('day: returns YYYY-MM-DD', () => {
    expect(truncateToGranularity(d, 'day')).toBe('2024-03-15');
  });

  it('month: returns YYYY-MM', () => {
    expect(truncateToGranularity(d, 'month')).toBe('2024-03');
  });

  it('quarter: returns YYYY-QN', () => {
    expect(truncateToGranularity(d, 'quarter')).toBe('2024-Q1');
    expect(truncateToGranularity(new Date('2024-07-20'), 'quarter')).toBe('2024-Q3');
  });

  it('year: returns YYYY', () => {
    expect(truncateToGranularity(d, 'year')).toBe('2024');
  });

  it('week: returns YYYY-WNN (ISO week)', () => {
    const key = truncateToGranularity(new Date('2024-01-08'), 'week');
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
    expect(key).toBe('2024-W02');
  });

  it('returns null for non-date input', () => {
    expect(truncateToGranularity('not-a-date', 'month')).toBeNull();
  });

  it('accepts ISO string input', () => {
    expect(truncateToGranularity('2024-06-20', 'month')).toBe('2024-06');
  });
});

// ─── formatPeriodLabel ────────────────────────────────────────────────────────

describe('formatPeriodLabel', () => {
  it('formats YYYY-MM as "Mon YYYY"', () => {
    expect(formatPeriodLabel('2024-01')).toBe('Jan 2024');
    expect(formatPeriodLabel('2024-12')).toBe('Dec 2024');
  });

  it('formats YYYY-QN as "QN YYYY"', () => {
    expect(formatPeriodLabel('2024-Q1')).toBe('Q1 2024');
    expect(formatPeriodLabel('2024-Q4')).toBe('Q4 2024');
  });

  it('formats YYYY as itself', () => {
    expect(formatPeriodLabel('2024')).toBe('2024');
  });

  it('formats YYYY-WNN as "Week N YYYY"', () => {
    expect(formatPeriodLabel('2024-W03')).toBe('Week 3 2024');
    expect(formatPeriodLabel('2024-W12')).toBe('Week 12 2024');
  });

  it('formats YYYY-MM-DD as locale day string', () => {
    const label = formatPeriodLabel('2024-03-15');
    expect(label).toMatch(/2024/);
    expect(label).toMatch(/15|Mar|March/);
  });

  it('returns unknown keys as-is', () => {
    expect(formatPeriodLabel('foo')).toBe('foo');
  });
});

describe('fillTemporalLabelGaps', () => {
  it('fills missing day buckets for date labels', () => {
    expect(fillTemporalLabelGaps(['2024-01-01', '2024-01-03'])).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
    ]);
  });

  it('fills missing month buckets for grouped month labels', () => {
    expect(fillTemporalLabelGaps(['2024-01', '2024-03'])).toEqual([
      '2024-01',
      '2024-02',
      '2024-03',
    ]);
  });

  it('preserves non-temporal labels unchanged', () => {
    const labels = ['North', 'South'];
    expect(fillTemporalLabelGaps(labels)).toBe(labels);
  });
});

describe('getTemporalAxisData', () => {
  it('converts grouped month labels into UTC dates', () => {
    const result = getTemporalAxisData(['2024-01', '2024-03']);
    expect(result).toHaveLength(2);
    expect(result?.map((value) => value.toISOString())).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2024-03-01T00:00:00.000Z',
    ]);
  });

  it('converts raw ISO dates into UTC dates', () => {
    const result = getTemporalAxisData(['2024-01-15', '2024-02-20']);
    expect(result).toHaveLength(2);
    expect(result?.[0].toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('returns null for non-temporal labels', () => {
    expect(getTemporalAxisData(['North', 'South'])).toBeNull();
  });
});

describe('formatTemporalAxisLabel', () => {
  it('formats grouped month dates using period labels', () => {
    expect(formatTemporalAxisLabel(new Date('2024-03-01T00:00:00.000Z'), 'month')).toBe('Mar 2024');
  });
});

describe('normalizeDataSourceRows', () => {
  const fields = [
    { id: 'id', label: 'ID', type: 'string' as const },
    { id: 'date', label: 'Date', type: 'date' as const },
    { id: 'ts', label: 'Timestamp', type: 'datetime' as const },
  ];

  const makeNormSource = (rows: Record<string, unknown>[]): StudioDataSource => ({
    id: 's1',
    label: 'Source',
    fields,
    rows,
  });

  it('converts Date objects to ISO strings', () => {
    const d = new Date('2024-03-15T12:00:00Z');
    const result = normalizeDataSourceRows(makeNormSource([{ id: 1, date: d, ts: d }]));
    expect(result.rows![0].date).toBe('2024-03-15');
    expect(result.rows![0].ts).toBe('2024-03-15T12:00:00.000Z');
  });

  it('converts millisecond timestamps to ISO strings', () => {
    const ms = new Date('2024-06-01T00:00:00Z').getTime();
    const result = normalizeDataSourceRows(makeNormSource([{ id: 1, date: ms, ts: ms }]));
    expect(result.rows![0].date).toBe('2024-06-01');
    expect(result.rows![0].ts).toBe('2024-06-01T00:00:00.000Z');
  });

  it('leaves already-canonical ISO strings untouched (returns same row reference)', () => {
    const row = { id: 1, date: '2024-01-01', ts: '2024-01-01T00:00:00.000Z' };
    const source = makeNormSource([row]);
    const result = normalizeDataSourceRows(source);
    expect(result.rows![0]).toBe(row); // same reference — no copy made
  });

  it('leaves null/undefined values untouched', () => {
    const result = normalizeDataSourceRows(makeNormSource([{ id: 1, date: null, ts: undefined }]));
    expect(result.rows![0].date).toBeNull();
    expect(result.rows![0].ts).toBeUndefined();
  });

  it('does not touch non-date fields', () => {
    const result = normalizeDataSourceRows(makeNormSource([{ id: 'abc', date: '2024-01-01' }]));
    expect(result.rows![0].id).toBe('abc');
  });

  it('returns original data source reference when there are no rows', () => {
    const source: StudioDataSource = { id: 's1', label: 'S', fields, rows: [] };
    expect(normalizeDataSourceRows(source)).toBe(source);
  });

  it('builds fieldDistinctValues for string fields even when no date fields require normalization', () => {
    const source: StudioDataSource = {
      id: 's1',
      label: 'S',
      fields: [{ id: 'name', label: 'Name', type: 'string' }],
      rows: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.name).toEqual(['Alice', 'Bob']);
  });
});

// ─── Performance: Batch 3 — fillTemporalLabelGaps in-place Date mutation ──────

describe('fillTemporalLabelGaps — perf: in-place Date mutation', () => {
  it('fills daily gaps the same as the original allocation-per-step approach', () => {
    const result = fillTemporalLabelGaps(['2024-01-01', '2024-01-05']);
    expect(result).toEqual(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']);
  });

  it('fills monthly gaps correctly with in-place mutation', () => {
    const result = fillTemporalLabelGaps(['2024-01', '2024-04']);
    expect(result).toEqual(['2024-01', '2024-02', '2024-03', '2024-04']);
  });

  it('fills yearly gaps correctly', () => {
    const result = fillTemporalLabelGaps(['2021', '2024']);
    expect(result).toEqual(['2021', '2022', '2023', '2024']);
  });

  it('returns original labels when last label has a different kind than first', () => {
    // First label is year (2024), last is month (2024-03) — mixed kind, return original
    const labels = ['2024', '2024-03'];
    const result = fillTemporalLabelGaps(labels);
    expect(result).toBe(labels);
  });

  it('returns original labels when no gaps to fill', () => {
    const labels = ['2024-01', '2024-02', '2024-03'];
    const result = fillTemporalLabelGaps(labels);
    // No gaps — filled array would not be longer, so original is returned
    expect(result).toBe(labels);
  });

  it('fills weekly gaps correctly', () => {
    const result = fillTemporalLabelGaps(['2024-W01', '2024-W03']);
    expect(result).toEqual(['2024-W01', '2024-W02', '2024-W03']);
  });

  it('fills quarterly gaps correctly', () => {
    const result = fillTemporalLabelGaps(['2024-Q1', '2024-Q3']);
    expect(result).toEqual(['2024-Q1', '2024-Q2', '2024-Q3']);
  });
});

// ─── Performance: Batch 3 — normalizeDataSourceRows fieldDistinctValues ───────

describe('normalizeDataSourceRows — fieldDistinctValues', () => {
  it('builds sorted distinct values for string fields', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'country', label: 'Country', type: 'string' }],
      rows: [
        { country: 'Germany' },
        { country: 'France' },
        { country: 'Germany' },
        { country: 'US' },
      ],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.country).toEqual(['France', 'Germany', 'US']);
  });

  it('builds distinct values for boolean fields', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'active', label: 'Active', type: 'boolean' }],
      rows: [{ active: true }, { active: false }, { active: true }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.active).toEqual(['false', 'true']);
  });

  it('excludes null and empty-string values from distinct index', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'tier', label: 'Tier', type: 'string' }],
      rows: [{ tier: 'gold' }, { tier: null }, { tier: '' }, { tier: 'silver' }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.tier).toEqual(['gold', 'silver']);
  });

  it('does not build index for number fields', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [{ amount: 10 }, { amount: 20 }],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.fieldDistinctValues?.amount).toBeUndefined();
  });

  it('returns source by reference when no rows', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [{ id: 'x', label: 'X', type: 'string' }],
      rows: [],
    };
    expect(normalizeDataSourceRows(source)).toBe(source);
  });

  it('combines date normalization and fieldDistinctValues in a single pass', () => {
    const source: StudioDataSource = {
      id: 'src',
      label: 'S',
      fields: [
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'date', label: 'Date', type: 'date' },
      ],
      rows: [
        { region: 'EU', date: new Date('2024-01-15') },
        { region: 'US', date: new Date('2024-02-20') },
      ],
    };
    const result = normalizeDataSourceRows(source);
    expect(result.rows![0].date).toBe('2024-01-15');
    expect(result.fieldDistinctValues?.region).toEqual(['EU', 'US']);
  });
});
