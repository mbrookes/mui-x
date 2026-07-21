import { describe, expect, it } from 'vitest';
import type {
  StudioConditionalFormat,
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
  StudioWidget,
} from '../../../models';
import { resolveRows } from '../../../internals/dataSourceGraph';
import { evalConditionalFormat, makeFanoutSafeAggregationFunction } from './StudioGridWidget';

function makeWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'widget-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'orders',
    config: {},
    ...overrides,
  };
}

function makeDataSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
      { id: 'status', label: 'Status', type: 'string' },
    ],
    rows: [],
  };
}

describe('StudioGridWidget', () => {
  it('makeWidget produces a valid grid widget', () => {
    const widget = makeWidget();
    expect(widget.kind).toBe('grid');
  });

  it('makeDataSource produces a valid data source', () => {
    const ds = makeDataSource();
    expect(ds.fields).toHaveLength(3);
  });
});

// ─── Cross-source filter regression ──────────────────────────────────────────
// Selecting a carrier in a multi-select filter (source: shipments) should
// filter an orders grid (source: orders) via the shipments→orders relationship,
// not apply the carrier field directly to order rows (which don't have that field).

describe('StudioGridWidget — cross-source interactive filter', () => {
  const ordersSource: StudioDataSource = {
    id: 'source-orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [
      { id: 'O1', amount: 100 },
      { id: 'O2', amount: 200 },
      { id: 'O3', amount: 300 },
    ],
  };

  const shipmentsSource: StudioDataSource = {
    id: 'source-shipments',
    label: 'Shipments',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'orderId', label: 'Order', type: 'string' },
      { id: 'carrier', label: 'Carrier', type: 'string' },
    ],
    rows: [
      { id: 'S1', orderId: 'O1', carrier: 'DHL' },
      { id: 'S2', orderId: 'O2', carrier: 'FedEx' },
      { id: 'S3', orderId: 'O3', carrier: 'DHL' },
    ],
  };

  const dataSources: Record<string, StudioDataSource> = {
    'source-orders': ordersSource,
    'source-shipments': shipmentsSource,
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-1',
      sourceId: 'source-shipments',
      sourceField: 'orderId',
      targetId: 'source-orders',
      targetField: 'id',
      type: 'many-to-one' as const,
    },
  ];

  it('cross-source multi-select filter returns only orders fulfilled by selected carrier', () => {
    const interactiveFilter: StudioFilterState = {
      id: 'filter-carrier',
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget-1', pageId: 'page-1' },
      field: 'carrier',
      operator: 'in',
      value: ['DHL'],
      filterMode: 'selection',
      filterSourceId: 'source-shipments',
    };

    const result = resolveRows(
      ordersSource.rows!,
      'source-orders',
      [interactiveFilter],
      dataSources,
      relationships,
    );

    // O1 and O3 were shipped by DHL; O2 was shipped by FedEx
    expect(result.map((r) => r.id)).toEqual(['O1', 'O3']);
  });

  it('regression: without filterSourceId, carrier filter on orders returns no rows', () => {
    // This is the bug: omitting filterSourceId causes carrier to be applied as
    // a native filter on orders rows, which have no carrier field → empty result.
    const badFilter: StudioFilterState = {
      id: 'filter-carrier',
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget-1', pageId: 'page-1' },
      field: 'carrier',
      operator: 'in',
      value: ['DHL'],
      filterMode: 'selection',
      // No filterSourceId — treated as native filter
    };

    const result = resolveRows(
      ordersSource.rows!,
      'source-orders',
      [badFilter],
      dataSources,
      relationships,
    );

    expect(result).toHaveLength(0);
  });

  it('selecting all carriers returns all orders', () => {
    const interactiveFilter: StudioFilterState = {
      id: 'filter-carrier',
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget-1', pageId: 'page-1' },
      field: 'carrier',
      operator: 'in',
      value: ['DHL', 'FedEx'],
      filterMode: 'selection',
      filterSourceId: 'source-shipments',
    };

    const result = resolveRows(
      ordersSource.rows!,
      'source-orders',
      [interactiveFilter],
      dataSources,
      relationships,
    );

    expect(result).toHaveLength(3);
  });

  it('clearing the filter (empty selection) returns all orders', () => {
    const result = resolveRows(ordersSource.rows!, 'source-orders', [], dataSources, relationships);

    expect(result).toHaveLength(3);
  });
});

// ─── Conditional-format numeric rules must not match empty cells (finding 3.5) ──
// `Number(null)` / `Number(undefined)` / `Number('')` all coerce to 0, so a
// `less_than 5` rule used to highlight genuinely empty cells as if they held 0.

describe('evalConditionalFormat — numeric rules exclude empty cells', () => {
  function rule(
    operator: StudioConditionalFormat['operator'],
    value: unknown,
  ): StudioConditionalFormat {
    return { fieldId: 'amount', operator, value, style: {} };
  }

  it('does not match null/undefined/empty-string cells for numeric comparisons', () => {
    for (const empty of [null, undefined, '']) {
      expect(evalConditionalFormat(rule('less_than', 5), empty)).toBe(false);
      expect(evalConditionalFormat(rule('less_than_or_equal', 5), empty)).toBe(false);
      expect(evalConditionalFormat(rule('greater_than', -5), empty)).toBe(false);
      expect(evalConditionalFormat(rule('greater_than_or_equal', -5), empty)).toBe(false);
    }
  });

  it('still matches a genuine 0 cell (0 is not empty)', () => {
    expect(evalConditionalFormat(rule('less_than', 5), 0)).toBe(true);
    expect(evalConditionalFormat(rule('greater_than_or_equal', 0), 0)).toBe(true);
  });

  it('matches populated numeric cells as before', () => {
    expect(evalConditionalFormat(rule('less_than', 5), 3)).toBe(true);
    expect(evalConditionalFormat(rule('less_than', 5), 10)).toBe(false);
    expect(evalConditionalFormat(rule('greater_than', 5), 10)).toBe(true);
  });

  it('leaves is_empty / is_not_empty semantics intact', () => {
    expect(evalConditionalFormat(rule('is_empty', undefined), '')).toBe(true);
    expect(evalConditionalFormat(rule('is_empty', undefined), 0)).toBe(false);
    expect(evalConditionalFormat(rule('is_not_empty', undefined), 0)).toBe(true);
  });
});

// ─── Conditional-format equals/not_equals must coerce a boolean cell against a
// string-committed rule value (finding 8) ────────────────────────────────────────
// `GridConditionalFormatSection` routes every non-number field (including boolean)
// through a plain string text input, so `rule.value` for a boolean column is
// committed as the STRING "true"/"false" — while `cellValue` for that column is a
// raw JS boolean. `true == "true"` is `false` under JS loose-equality coercion, so
// an equals rule never matched and a not_equals rule matched every row.

describe('evalConditionalFormat — boolean columns compared against a string-committed value', () => {
  function rule(
    operator: StudioConditionalFormat['operator'],
    value: unknown,
  ): StudioConditionalFormat {
    return { fieldId: 'active', operator, value, style: {} };
  }

  it('equals matches a true cell against the string "true"', () => {
    expect(evalConditionalFormat(rule('equals', 'true'), true)).toBe(true);
  });

  it('equals does not match a false cell against the string "true"', () => {
    expect(evalConditionalFormat(rule('equals', 'true'), false)).toBe(false);
  });

  it('equals matches a false cell against the string "false"', () => {
    expect(evalConditionalFormat(rule('equals', 'false'), false)).toBe(true);
  });

  it('not_equals does not match when the boolean cell agrees with the string value', () => {
    expect(evalConditionalFormat(rule('not_equals', 'false'), false)).toBe(false);
    expect(evalConditionalFormat(rule('not_equals', 'true'), true)).toBe(false);
  });

  it('not_equals matches when the boolean cell disagrees with the string value', () => {
    expect(evalConditionalFormat(rule('not_equals', 'true'), false)).toBe(true);
    expect(evalConditionalFormat(rule('not_equals', 'false'), true)).toBe(true);
  });
});

// ─── Custom min/max fan-out-safe aggregation is number-only (finding T3.6) ──────
// The custom override routes every value through the shared reducer, which coerces
// dates to `null`. Claiming `date`/`dateTime` column types made this override the
// registered min/max for date columns, so they resolved to blank. The override must
// only claim `number` columns (leaving date min/max to a date-aware path).

describe('makeFanoutSafeAggregationFunction — min/max restrict to number columns', () => {
  it('registers only the number column type for min and max', () => {
    const emptyFk = new Map<string, string>();
    expect(makeFanoutSafeAggregationFunction('min', emptyFk, ['number']).columnTypes).toEqual([
      'number',
    ]);
    expect(makeFanoutSafeAggregationFunction('max', emptyFk, ['number']).columnTypes).toEqual([
      'number',
    ]);
  });

  it('cannot produce a date aggregate (dates coerce to null → no value)', () => {
    const fn = makeFanoutSafeAggregationFunction('min', new Map(), ['number']);
    const dates = ['2024-03-01', '2024-01-15', '2024-02-20'];
    const values = dates.map((d, i) => ({ dedupeKey: `k${i}`, value: d }));
    // The shared reducer coerces every date string to null → empty numeric set → null.
    expect(fn.apply({ values } as any)).toBe(null);
  });
});
