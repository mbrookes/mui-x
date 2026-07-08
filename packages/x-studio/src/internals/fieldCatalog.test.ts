import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioExpressionField } from '../models';
import { buildFieldCatalog, buildFieldLabelMap, buildSourceFieldEntries } from './fieldCatalog';

function makeSource(overrides: Partial<StudioDataSource> = {}): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'Order ID', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    ...overrides,
  };
}

function makeExpressionField(
  overrides: Partial<StudioExpressionField> = {},
): StudioExpressionField {
  return {
    id: 'ef1',
    label: 'Margin',
    sourceId: 'orders',
    isMeasure: false,
    expression: { type: 'number', value: 1 },
    ...overrides,
  };
}

describe('buildSourceFieldEntries', () => {
  it('skips hidden physical fields', () => {
    const source = makeSource({
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'secret', label: 'Secret', type: 'string', hidden: true },
      ],
    });
    const entries = buildSourceFieldEntries(source, []);
    expect(entries.map((entry) => entry.id)).toEqual(['id']);
  });

  it('skips hidden expression fields', () => {
    const source = makeSource();
    const ef = makeExpressionField({ hidden: true });
    const entries = buildSourceFieldEntries(source, [ef]);
    expect(entries.some((entry) => entry.id === 'ef1')).toBe(false);
  });

  it('emits an expression entry shaped with type defaulted to number and generated: true', () => {
    const source = makeSource();
    const ef = makeExpressionField({ type: undefined });
    const entries = buildSourceFieldEntries(source, [ef]);
    const entry = entries.find((entry) => entry.id === 'ef1');
    expect(entry).toMatchObject({
      id: 'ef1',
      label: 'Margin',
      type: 'number',
      generated: true,
      sourceId: 'orders',
      sourceLabel: 'Orders',
    });
  });

  it('excludes measures when expression policy is non-measure', () => {
    const source = makeSource();
    const measure = makeExpressionField({ id: 'ef-measure', isMeasure: true });
    const column = makeExpressionField({ id: 'ef-column', isMeasure: false });
    const entries = buildSourceFieldEntries(source, [measure, column], {
      expression: 'non-measure',
    });
    expect(entries.map((entry) => entry.id)).toEqual(['id', 'total', 'ef-column']);
  });

  it('excludes all expression fields when policy is none', () => {
    const source = makeSource();
    const entries = buildSourceFieldEntries(source, [makeExpressionField()], {
      expression: 'none',
    });
    expect(entries.some((entry) => entry.id === 'ef1')).toBe(false);
  });

  it('only includes expression fields belonging to the given source', () => {
    const source = makeSource();
    const other = makeExpressionField({ id: 'ef-other', sourceId: 'customers' });
    const entries = buildSourceFieldEntries(source, [other]);
    expect(entries.some((entry) => entry.id === 'ef-other')).toBe(false);
  });
});

describe('buildFieldCatalog', () => {
  it('skips hidden sources and hidden fields by default', () => {
    const dataSources: Record<string, StudioDataSource> = {
      orders: makeSource(),
      hiddenSource: makeSource({
        id: 'hiddenSource',
        label: 'Hidden Source',
        hidden: true,
        fields: [{ id: 'x', label: 'X', type: 'string' }],
      }),
    };
    const withHiddenField = {
      ...dataSources,
      orders: makeSource({
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'secret', label: 'Secret', type: 'string', hidden: true },
        ],
      }),
    };
    const entries = buildFieldCatalog(withHiddenField, []);
    expect(entries.map((entry) => entry.id).sort()).toEqual(['id']);
  });

  it('includes hidden sources and hidden fields when includeHidden: true', () => {
    const dataSources: Record<string, StudioDataSource> = {
      orders: makeSource({
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'secret', label: 'Secret', type: 'string', hidden: true },
        ],
      }),
      hiddenSource: makeSource({
        id: 'hiddenSource',
        label: 'Hidden Source',
        hidden: true,
        fields: [{ id: 'x', label: 'X', type: 'string' }],
      }),
    };
    const entries = buildFieldCatalog(dataSources, [], { includeHidden: true, sort: false });
    expect(entries.map((entry) => entry.id).sort()).toEqual(['id', 'secret', 'x']);
  });

  it('falls back to the raw sourceId as sourceLabel for an orphaned expression field', () => {
    const dataSources: Record<string, StudioDataSource> = { orders: makeSource() };
    const orphan = makeExpressionField({ id: 'ef-orphan', sourceId: 'does-not-exist' });
    const entries = buildFieldCatalog(dataSources, [orphan]);
    const entry = entries.find((entry) => entry.id === 'ef-orphan');
    expect(entry?.sourceLabel).toBe('does-not-exist');
  });

  it('excludes measures when expression policy is non-measure', () => {
    const dataSources: Record<string, StudioDataSource> = { orders: makeSource() };
    const measure = makeExpressionField({ id: 'ef-measure', isMeasure: true });
    const entries = buildFieldCatalog(dataSources, [measure], { expression: 'non-measure' });
    expect(entries.some((entry) => entry.id === 'ef-measure')).toBe(false);
  });

  it('sorts by sourceLabel using localeCompare', () => {
    const dataSources: Record<string, StudioDataSource> = {
      zed: makeSource({
        id: 'zed',
        label: 'Zed Source',
        fields: [{ id: 'z', label: 'Z', type: 'string' }],
      }),
      alpha: makeSource({
        id: 'alpha',
        label: 'Alpha Source',
        fields: [{ id: 'a', label: 'A', type: 'string' }],
      }),
    };
    const entries = buildFieldCatalog(dataSources, []);
    expect(entries.map((entry) => entry.sourceLabel)).toEqual(['Alpha Source', 'Zed Source']);
  });

  it('does not sort when sort: false', () => {
    const dataSources: Record<string, StudioDataSource> = {
      zed: makeSource({
        id: 'zed',
        label: 'Zed Source',
        fields: [{ id: 'z', label: 'Z', type: 'string' }],
      }),
    };
    const entries = buildFieldCatalog(dataSources, [], { sort: false });
    expect(entries).toHaveLength(1);
  });
});

describe('buildFieldLabelMap', () => {
  it('first-writer-wins on a duplicate field id across two sources (known limitation, finding 2.4)', () => {
    // KNOWN, DOCUMENTED limitation: this is NOT fixed by this refactor — the map
    // resolves whichever source is encountered first in `Object.values()` order.
    const dataSources: Record<string, StudioDataSource> = {
      orders: makeSource({
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'country', label: 'Orders Country', type: 'string' }],
      }),
      customers: makeSource({
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'country', label: 'Customers Country', type: 'string' }],
      }),
    };
    const map = buildFieldLabelMap(dataSources);
    expect(map.get('country')).toBe('Orders Country');
  });

  it('includes hidden fields', () => {
    const dataSources: Record<string, StudioDataSource> = {
      orders: makeSource({
        fields: [{ id: 'secret', label: 'Secret', type: 'string', hidden: true }],
      }),
    };
    const map = buildFieldLabelMap(dataSources);
    expect(map.get('secret')).toBe('Secret');
  });

  it('does not include expression-field labels unless expressionFields is passed', () => {
    const dataSources: Record<string, StudioDataSource> = { orders: makeSource() };
    const withoutArg = buildFieldLabelMap(dataSources);
    expect(withoutArg.has('ef1')).toBe(false);

    const withArg = buildFieldLabelMap(dataSources, [makeExpressionField()]);
    expect(withArg.get('ef1')).toBe('Margin');
  });
});
