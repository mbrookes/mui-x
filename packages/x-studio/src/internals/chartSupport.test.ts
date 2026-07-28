import { describe, expect, it } from 'vitest';
import {
  analyzeChartSupport,
  chartTypeSupportsMeasure,
  resolveChartRowsForAggregation,
  CHART_TYPE_MEASURE_SUPPORT,
} from './chartSupport';
import { MAX_ENTRIES_PER_ROWS } from './rowCacheLru';
import type {
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioRelationship,
} from '../models';

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

// ─── L4 re-anchoring cache: ANCHOR source `fields` dependency ─────────────────
//
// Same class as the block above, one position over. `readSourceDeps` used to EXCLUDE the
// widget and anchor sources on the theory that the two WeakMap keys already covered them —
// but a WeakMap key pins `rows` only, and the anchor rows are read through
// `getCachedNormalizedDataSource`, which is keyed on rows AND fields.

describe('resolveChartRowsForAggregation — anchor source fields dependency', () => {
  const ORDER_DATE_AS_STRING: StudioDataField = { id: 'orderDate', label: 'Date', type: 'string' };
  const ORDER_DATE_AS_DATE: StudioDataField = { id: 'orderDate', label: 'Date', type: 'date' };

  it('invalidates when the ANCHOR source retypes a field without replacing its rows', () => {
    // Widget source is `customers` (the "one" side) while both chart fields live on `orders`
    // (the "many" side), so `analyzeChartSupport` sets `anchorSourceId = 'orders'` and L4 takes
    // the many-to-one anchor branch — which reads the anchor rows through
    // `getCachedNormalizedDataSource`.
    //
    // Retyping `orders.orderDate` from `string` to `date` in the data drawer
    // (`updateDataSourceField`) commits a NEW `fields` array with the SAME `rows` reference.
    // Every other validity signal is unchanged: outer key `widgetRows`, inner key
    // `dataSources.orders.rows`, `relationships`, the expression fields — and `orders`, being
    // the anchor, was filtered out of `readSourceDeps`. So the entry stayed "valid" and the
    // chart kept bucketing on the raw `'1/15/2024'` forever while the grid beside it showed the
    // canonicalized `'2024-01-15'`, with no recovery short of replacing `orders.rows`.
    const customersRows: Row[] = [{ id: 0, name: 'Ada' }];
    const ordersRows: Row[] = [{ id: 'o1', customerId: 0, amount: 10, orderDate: '1/15/2024' }];

    const makeSources = (orderDateField: StudioDataField): Record<string, StudioDataSource> => ({
      // SAME rows reference in both variants — only `fields` differs.
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'number' },
          { id: 'amount', label: 'Amount', type: 'number' },
          orderDateField,
        ],
        rows: ordersRows,
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'number' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: customersRows,
      },
    });

    // ONE relationships array and one expression-field array across both calls, so the only
    // thing that can invalidate the entry is the ANCHOR source's `fields` ref.
    const rels = [REL];
    const exprFields: never[] = [];
    const resolve = (orderDateField: StudioDataField): Row[] =>
      resolveChartRowsForAggregation(
        customersRows,
        'customers',
        'orderDate',
        ['amount'],
        undefined,
        makeSources(orderDateField),
        rels,
        exprFields,
      );

    const before = resolve(ORDER_DATE_AS_STRING);
    const after = resolve(ORDER_DATE_AS_DATE);

    expect(before).not.toBe(after);
    // Untyped, L1 leaves the ambiguous `M/D/YYYY` spelling alone; retyped, it canonicalizes to
    // the `YYYY-MM-DD` string every other layer already agrees on.
    expect(before[0].orderDate).toBe('1/15/2024');
    expect(after[0].orderDate).toBe('2024-01-15');
  });

  it('still hits the cache when the anchor source is untouched', () => {
    // The dep added above must not turn every re-render into a miss.
    const customersRows: Row[] = [{ id: 0, name: 'Ada' }];
    const ordersRows: Row[] = [{ id: 'o1', customerId: 0, amount: 10, orderDate: '1/15/2024' }];
    const dataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'number' },
          { id: 'amount', label: 'Amount', type: 'number' },
          ORDER_DATE_AS_DATE,
        ],
        rows: ordersRows,
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'number' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: customersRows,
      },
    };
    const rels = [REL];
    const resolve = (): Row[] =>
      resolveChartRowsForAggregation(
        customersRows,
        'customers',
        'orderDate',
        ['amount'],
        undefined,
        dataSources,
        rels,
        [],
      );

    expect(resolve()).toBe(resolve());
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

// ─── Measure expression fields (HIGH 1) ───────────────────────────────────────
//
// A measure (`isMeasure: true`) has no per-row value — `enrichRowsWithExpressions` skips
// measures, so `row[measureId]` is `undefined` everywhere — and `hasRowLevelField` therefore
// cannot resolve one. Every measure used to fall straight through to
// `field_not_found_or_not_direct`: "fields that are not available on the widget source", said
// about a measure the panel had just offered and the KPI card beside it was already computing.
// The measure-aware generic aggregators were unreachable from charts as a result.

describe('analyzeChartSupport — measure expression fields', () => {
  const AOV: StudioExpressionField = {
    id: 'aov',
    label: 'Avg order value',
    sourceId: 'orders',
    isMeasure: true,
    type: 'number',
    expression: {
      operator: 'divide',
      inputs: [
        { id: 'total', aggregation: 'sum' },
        { id: 'total', aggregation: 'count' },
      ],
    },
  };

  const SOURCES: Record<string, StudioDataSource> = {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'number' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [{ region: 'A', customerId: 0, total: 10 }],
    },
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'number' },
        { id: 'tier', label: 'Tier', type: 'string' },
        { id: 'credit', label: 'Credit', type: 'number' },
      ],
      rows: [{ id: 0, tier: 'gold', credit: 5 }],
    },
  };

  const analyze = (
    chartType: string | undefined,
    yFields: string[],
    opts: {
      xField?: string;
      seriesField?: string;
      extraFields?: (string | undefined)[];
      relationships?: StudioRelationship[];
      expressionFields?: StudioExpressionField[];
    } = {},
  ) =>
    analyzeChartSupport(
      'orders',
      'xField' in opts ? opts.xField : 'region',
      yFields,
      opts.seriesField,
      chartType,
      SOURCES,
      opts.relationships ?? [],
      opts.expressionFields ?? [AOV],
      undefined,
      undefined,
      opts.extraFields ?? [],
    );

  it('supports a widget-owned measure as the y-measure of a bucket-aggregating family', () => {
    // The whole point: this used to report `field_not_found_or_not_direct`, so `useChartRows`
    // short-circuited to `[]` and the chart showed "fields that are not available".
    const result = analyze('bar', ['aov']);
    expect(result.supported).toBe(true);
    // Deliberately absent from `fieldOwners`: `resolveRowsAtGrain` routes every entry through an
    // enrichment/expansion join, and a measure has no column for those to read.
    expect(result.fieldOwners?.has('aov')).toBe(false);
    expect(result.fieldOwners?.get('region')).toBe('orders');
    expect(result.anchorSourceId).toBe('orders');
  });

  it.each(['line', 'area', 'pie', 'donut', 'mixed', 'gauge'])(
    'supports a measure on %s',
    (chartType) => {
      expect(analyze(chartType, ['aov']).supported).toBe(true);
    },
  );

  it.each(['scatter', 'heatmap', 'funnel', 'sankey', 'gantt'])(
    'reports measure_not_supported on %s rather than letting it aggregate nothing',
    (chartType) => {
      const result = analyze(chartType, ['aov']);
      expect(result.supported).toBe(false);
      expect(result.reason).toBe('measure_not_supported');
    },
  );

  it('reports measure_not_supported for a measure used as a DIMENSION', () => {
    // A measure can never group, split or colour: those read a per-row value it does not have.
    expect(analyze('bar', [], { xField: 'aov' }).reason).toBe('measure_not_supported');
    expect(analyze('bar', ['total'], { seriesField: 'aov' }).reason).toBe('measure_not_supported');
    expect(analyze('heatmap', ['total'], { extraFields: ['aov'] }).reason).toBe(
      'measure_not_supported',
    );
  });

  it('keeps field_not_found_or_not_direct for a measure owned by another source', () => {
    // A measure is evaluated over the WIDGET's rows; another source's measure would need that
    // source's rows at that source's grain, which this analysis never produces.
    const foreign: StudioExpressionField = { ...AOV, id: 'foreign_aov', sourceId: 'customers' };
    const result = analyze('bar', ['foreign_aov'], { expressionFields: [foreign] });
    expect(result.supported).toBe(false);
    expect(result.reason).toBe('field_not_found_or_not_direct');
  });

  it('fails closed when a measure would be evaluated over a RE-ANCHORED row set', () => {
    // `credit` lives on `customers`, one many-to-one hop away, so the analysis re-anchors onto
    // the "many" side. The measure is written against the widget's own grain, so evaluating it
    // over the expanded row set would return a different number than the KPI on the same
    // measure — two answers to one question.
    const rel: StudioRelationship = {
      id: 'rel',
      type: 'many-to-one',
      sourceId: 'customers',
      sourceField: 'id',
      targetId: 'orders',
      targetField: 'customerId',
    };
    const result = analyze('bar', ['aov', 'credit'], { relationships: [rel] });
    expect(result.supported).toBe(false);
    expect(result.reason).toBe('mixed_cross_source_fields');
  });

  it('leaves non-measure expression fields and plain fields alone', () => {
    const calculated = {
      id: 'net',
      label: 'Net',
      sourceId: 'orders',
      type: 'number',
      expression: { operator: 'multiply', inputs: [{ id: 'total' }, 2] },
    } as unknown as StudioExpressionField;
    const result = analyze('scatter', ['net'], { expressionFields: [calculated] });
    expect(result.supported).toBe(true);
    expect(result.fieldOwners?.get('net')).toBe('orders');
  });
});

describe('chartTypeSupportsMeasure', () => {
  it('answers from the registry table for every declared chart type', () => {
    for (const [chartType, expected] of Object.entries(CHART_TYPE_MEASURE_SUPPORT)) {
      expect(chartTypeSupportsMeasure(chartType)).toBe(expected);
    }
  });

  it('answers true for an absent chart type and false for an unknown one', () => {
    // `undefined` is the non-chart callers (`resolveChartRowsForAggregation`'s internal
    // re-check, the KPI grain analysis): no chart family, so no family restriction.
    expect(chartTypeSupportsMeasure(undefined)).toBe(true);
    // An unknown (doc/AI-authored) type fails closed, and a prototype key resolves nothing.
    expect(chartTypeSupportsMeasure('sunburst')).toBe(false);
    expect(chartTypeSupportsMeasure('constructor')).toBe(false);
    expect(chartTypeSupportsMeasure('toString')).toBe(false);
  });
});
