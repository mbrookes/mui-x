import { describe, expect, it } from 'vitest';
import type { StudioFilterNode } from '@mui/x-studio';
import type { DataLayerFieldType } from './client';
import { toDataLayerWhere } from './filters';

const SOURCE = 'dl-pets';
const TYPES = new Map<string, DataLayerFieldType>([
  ['id', 'integer'],
  ['name', 'string'],
  ['status', 'string'],
  ['born', 'date'],
  ['updatedAt', 'datetime'],
]);

type Leaf = Extract<StudioFilterNode, { type: 'leaf' }>;

function leaf(field: string, op: Leaf['op'], value: unknown, extra: Partial<Leaf> = {}): Leaf {
  return { type: 'leaf', field, op, value, ...extra };
}

function where(node: StudioFilterNode) {
  return toDataLayerWhere(node, SOURCE, TYPES);
}

describe('toDataLayerWhere', () => {
  it('returns undefined without a filter', () => {
    expect(toDataLayerWhere(undefined, SOURCE, TYPES)).toBeUndefined();
  });

  it('maps an and group of comparisons', () => {
    expect(
      where({
        type: 'group',
        logic: 'and',
        children: [leaf('status', 'equals', 'sold'), leaf('name', 'contains', 'dog')],
      }),
    ).toEqual({
      and: [
        { field: 'status', op: 'eq', value: 'sold' },
        { field: 'name', op: 'contains', value: 'dog' },
      ],
    });
  });

  it('keeps null rows for negated ops, as Studio does', () => {
    expect(where(leaf('status', 'not_equals', 'sold'))).toEqual({
      or: [
        { field: 'status', op: 'neq', value: 'sold' },
        { field: 'status', op: 'isNull' },
      ],
    });
    expect(where(leaf('name', 'does_not_contain', 'cat'))).toEqual({
      or: [
        { not: { field: 'name', op: 'contains', value: 'cat' } },
        { field: 'name', op: 'isNull' },
      ],
    });
    expect(where(leaf('status', 'not_in', ['sold']))).toEqual({
      or: [
        { field: 'status', op: 'nin', value: ['sold'] },
        { field: 'status', op: 'isNull' },
      ],
    });
  });

  it('matches a whole calendar day for a bare date on a datetime field', () => {
    expect(where(leaf('updatedAt', 'equals', '2026-01-31'))).toEqual({
      and: [
        { field: 'updatedAt', op: 'gte', value: '2026-01-31' },
        { field: 'updatedAt', op: 'lt', value: '2026-02-01' },
      ],
    });
    expect(where(leaf('updatedAt', 'less_than_or_equal', '2026-12-31'))).toEqual({
      field: 'updatedAt',
      op: 'lt',
      value: '2027-01-01',
    });
    expect(where(leaf('updatedAt', 'greater_than', '2026-02-28'))).toEqual({
      field: 'updatedAt',
      op: 'gte',
      value: '2026-03-01',
    });
    // A date field compares days directly.
    expect(where(leaf('born', 'less_than_or_equal', '2026-12-31'))).toEqual({
      field: 'born',
      op: 'lte',
      value: '2026-12-31',
    });
  });

  it('maps between to two bounds and skips a blank one', () => {
    expect(where(leaf('id', 'between', { from: 1, to: 10 }))).toEqual({
      and: [
        { field: 'id', op: 'gte', value: 1 },
        { field: 'id', op: 'lte', value: 10 },
      ],
    });
    expect(where(leaf('id', 'between', { from: 5, to: '' }))).toEqual({
      field: 'id',
      op: 'gte',
      value: 5,
    });
  });

  it('matches every row for an empty selection and none for an empty condition list', () => {
    expect(where(leaf('status', 'in', [], { filterMode: 'selection' }))).toBeUndefined();
    expect(where(leaf('status', 'in', []))).toEqual({
      and: [
        { field: 'status', op: 'isNull' },
        { field: 'status', op: 'isNotNull' },
      ],
    });
  });

  it('matches empty strings for is_empty on a string field', () => {
    expect(where(leaf('name', 'is_empty', undefined))).toEqual({
      or: [
        { field: 'name', op: 'isNull' },
        { field: 'name', op: 'eq', value: '' },
      ],
    });
    expect(where(leaf('id', 'is_not_empty', undefined))).toEqual({ field: 'id', op: 'isNotNull' });
  });

  it('drops an or group that has a match-all child', () => {
    expect(
      where({
        type: 'group',
        logic: 'or',
        children: [leaf('status', 'equals', 'sold'), leaf('name', 'equals', null)],
      }),
    ).toBeUndefined();
  });

  it('applies the second condition of a compound leaf', () => {
    expect(
      where(leaf('id', 'greater_than', 1, { op2: 'less_than', value2: 9, conjunction: 'or' })),
    ).toEqual({
      or: [
        { field: 'id', op: 'gt', value: 1 },
        { field: 'id', op: 'lt', value: 9 },
      ],
    });
    // A blank second condition is inactive, even under `or`.
    expect(
      where(leaf('id', 'greater_than', 1, { op2: 'less_than', value2: '', conjunction: 'or' })),
    ).toEqual({ field: 'id', op: 'gt', value: 1 });
  });

  it('resolves a relative date', () => {
    const result = where(
      leaf('born', 'greater_than_or_equal', {
        relative: true,
        amount: 7,
        unit: 'day',
        direction: 'past',
      }),
    );
    expect(result).toMatchObject({ field: 'born', op: 'gte' });
    expect((result as { value: string }).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('leaves rank filters to Studio', () => {
    expect(where(leaf('id', 'in', [1], { filterMode: 'rank' }))).toBeUndefined();
  });

  it('rejects ops and filters the data layer cannot run', () => {
    expect(() => where(leaf('name', 'ends_with', 'y'))).toThrow(
      "OPERATOR_NOT_SUPPORTED: The data layer has no 'ends_with' operator (field: name).",
    );
    expect(() => where(leaf('name', 'equals', 'x', { filterSourceId: 'dl-owners' }))).toThrow(
      /OPERATOR_NOT_SUPPORTED/,
    );
  });
});
