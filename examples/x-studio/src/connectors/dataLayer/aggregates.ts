/**
 * Maps a Studio query descriptor to a data layer `aggregate`, and the result back to Studio rows.
 *
 * The data layer computes one row per group at the descriptor's `preAggregationGrain`, so Studio
 * gets exact totals instead of aggregating a capped page of raw rows. Anything the aggregate can't
 * answer exactly returns a `fallback` reason, and the adapter reads raw rows instead.
 */
import type { StudioQueryDescriptor } from '@mui/x-studio';
import {
  DATA_LAYER_LIMITS,
  type DataLayerAggregate,
  type DataLayerAggregateOp,
  type DataLayerFieldType,
} from './client';

type StudioAggregation = NonNullable<StudioQueryDescriptor['aggregations']>[number];

/** A data layer aggregate and the Studio row key of each output. */
export interface DataLayerAggregatePlan {
  aggregate: DataLayerAggregate;
  /** Output name (`g0`, `m0`, …) → Studio row key (grain field or aggregation alias). */
  keys: Record<string, string>;
}

const NUMERIC: readonly DataLayerFieldType[] = ['integer', 'number'];

// Studio coerces values to numbers before `sum`, `avg`, `min`, and `max`. The data layer orders
// strings and dates natively, so only numeric fields give the same answer.
const OPS: Record<
  StudioAggregation['fn'],
  { op: DataLayerAggregateOp; types?: readonly DataLayerFieldType[]; rowCount?: boolean }
> = {
  sum: { op: 'sum', types: NUMERIC },
  avg: { op: 'avg', types: NUMERIC },
  min: { op: 'min', types: NUMERIC },
  max: { op: 'max', types: NUMERIC },
  // Studio's `count` is COUNT(*), so it sends no field.
  count: { op: 'count', rowCount: true },
  count_non_null: { op: 'count' },
  count_distinct: { op: 'countDistinct' },
};

/**
 * @returns The aggregate to send, or why the widget must read raw rows instead.
 */
export function toDataLayerAggregate(
  descriptor: StudioQueryDescriptor,
  fieldTypes: ReadonlyMap<string, DataLayerFieldType>,
): DataLayerAggregatePlan | { fallback: string } {
  const { aggregations = [], preAggregationGrain: grain } = descriptor;
  if (aggregations.length === 0) {
    return { fallback: 'the widget has no aggregations' };
  }
  if (!grain || grain.length === 0) {
    return { fallback: "the widget can't read pre-aggregated rows" };
  }
  if (descriptor.hasIncomingCrossOrInteractiveFilters) {
    return { fallback: 'cross-filters and filter-widget selections apply to raw rows' };
  }
  if (descriptor.hasRankFilters) {
    return { fallback: 'a Top-N filter ranks raw rows' };
  }
  if (grain.length > DATA_LAYER_LIMITS.maxGroupBy) {
    return { fallback: `the data layer groups by at most ${DATA_LAYER_LIMITS.maxGroupBy} fields` };
  }
  if (aggregations.length > DATA_LAYER_LIMITS.maxMetrics) {
    return { fallback: `the data layer computes at most ${DATA_LAYER_LIMITS.maxMetrics} metrics` };
  }

  const measured = new Set(aggregations.map((aggregation) => aggregation.field));
  const extra = descriptor.select.find((field) => !grain.includes(field) && !measured.has(field));
  if (extra !== undefined) {
    // For example the inputs of an expression field, which Studio computes per raw row.
    return { fallback: `the widget reads "${extra}", which is neither grouped nor aggregated` };
  }

  const aggregate: DataLayerAggregate = { groupBy: [], metrics: [] };
  const keys: Record<string, string> = {};
  for (const [index, field] of grain.entries()) {
    const type = fieldTypes.get(field);
    if (type === undefined || type === 'json') {
      return { fallback: `"${field}" is not a groupable entity field` };
    }
    const bucket = index === 0 ? descriptor.xGroupBy : undefined;
    if (bucket && type !== 'date' && type !== 'datetime') {
      return { fallback: `"${field}" is not a date, so the data layer can't bucket it` };
    }
    const as = `g${index}`;
    aggregate.groupBy.push(bucket ? { field, bucket, as } : { field, as });
    keys[as] = field;
  }

  for (const [index, { field, fn, alias }] of aggregations.entries()) {
    const spec = OPS[fn];
    const type = fieldTypes.get(field);
    if (!spec || type === undefined) {
      return { fallback: `"${fn}" of "${field}" has no data layer form` };
    }
    if ((spec.types && !spec.types.includes(type)) || type === 'json') {
      return { fallback: `"${fn}" of a ${type} field would not match Studio's result` };
    }
    if (Object.values(keys).includes(alias)) {
      return { fallback: `"${alias}" is both a group and a measure` };
    }
    const as = `m${index}`;
    aggregate.metrics.push(spec.rowCount ? { op: spec.op, as } : { op: spec.op, field, as });
    keys[as] = alias;
  }
  return { aggregate, keys };
}

/** Renames the data layer's outputs (`g0`, `m0`, …) to the keys Studio reads. */
export function fromDataLayerAggregateRows(
  rows: Record<string, unknown>[],
  keys: Record<string, string>,
): Record<string, unknown>[] {
  const entries = Object.entries(keys);
  return rows.map((row) => Object.fromEntries(entries.map(([as, key]) => [key, row[as]])));
}
