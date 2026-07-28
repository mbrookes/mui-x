import type { StudioExpressionField } from '../../models';
import { findMeasureExpressionField, resolveMeasureAggregate } from '../aggregate';

type Row = Record<string, unknown>;

/** Node + link data shaped for the `@mui/x-charts-pro` Sankey chart. */
export interface SankeyAggregateData {
  /** Unique node ids, in first-seen order. */
  nodes: { id: string }[];
  /** One link per unique (source, target) pair, with summed value. */
  links: { source: string; target: string; value: number }[];
}

/**
 * Aggregates flat rows into Sankey node/link data.
 *
 * Each row contributes a flow from `sourceField` to `targetField` weighted by
 * `valueField`. Rows are grouped by the unique `(source, target)` pair and their
 * values summed. Rows with an empty source/target, a self-referencing link
 * (`source === target`), or a non-positive value are skipped.
 *
 * The Sankey layout requires a directed acyclic graph and throws on circular
 * references, so any link whose target can already reach its source through
 * previously-accepted links is dropped (the back-edge of a cycle, chosen by
 * first-seen order). Only nodes that appear in a kept link are returned.
 *
 * @param rows - The rows to aggregate.
 * @param sourceField - Field providing the source ("from") node id.
 * @param targetField - Field providing the target ("to") node id.
 * @param valueField - Numeric field summed per source→target pair.
 * @param expressionFields - See the parameter's own doc: enables a MEASURE `valueField`.
 */
export function aggregateSankey(
  rows: Row[],
  sourceField: string,
  targetField: string,
  valueField: string,
  /**
   * The dashboard's expression fields, so a MEASURE `valueField` can be evaluated.
   *
   * A measure (`isMeasure: true`) has NO per-row value — `enrichRowsWithExpressions` deliberately
   * skips measures, so `row[measureId]` is `undefined` on every row. Read per-row (as this reducer
   * used to), `Number(undefined)` is `NaN`, so the `Number.isFinite` guard below dropped EVERY row
   * and the chart rendered nothing at all. When this is supplied and `valueField` resolves to a
   * measure, each (source, target) pair keeps its contributing ROWS and the measure is evaluated
   * over them via the shared `resolveMeasureAggregate` — the same entry point the KPI, the pivot
   * and the generic chart aggregators use.
   *
   * The `> 0` requirement is unchanged and simply moves after the evaluation: the Sankey layout
   * has no way to draw a zero-or-negative-width ribbon, so a pair whose measure is `null`
   * (unevaluable) or non-positive is dropped exactly as a non-positive raw weight already was.
   */
  expressionFields?: StudioExpressionField[],
): SankeyAggregateData {
  const measure = findMeasureExpressionField(valueField, expressionFields);

  // 1. Sum values per unique (source, target) pair, preserving first-seen order.
  const linkMap = new Map<string, { source: string; target: string; value: number }>();
  // A measure's pairs keep their contributing ROWS instead, in the same first-seen order, and are
  // evaluated once each into `linkMap` below (see the `expressionFields` param).
  const pairRows = measure
    ? new Map<string, { source: string; target: string; rows: Row[] }>()
    : undefined;
  for (const row of rows) {
    const source = String(row[sourceField] ?? '');
    const target = String(row[targetField] ?? '');
    if (!source || !target || source === target) {
      continue;
    }
    const key = `${source}\x00${target}`;
    if (pairRows) {
      const bucket = pairRows.get(key);
      if (bucket) {
        bucket.rows.push(row);
      } else {
        pairRows.set(key, { source, target, rows: [row] });
      }
      continue;
    }
    const value = Number(row[valueField]);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const existing = linkMap.get(key);
    if (existing) {
      existing.value += value;
    } else {
      linkMap.set(key, { source, target, value });
    }
  }
  if (pairRows) {
    // Evaluated ONCE per pair — the DAG pass below iterates `linkMap` a single time and never
    // re-reads a weight, so materializing here is all the memoization this shape needs.
    for (const [key, pair] of pairRows) {
      const value = resolveMeasureAggregate(pair.rows, valueField, expressionFields!);
      if (value === null || !Number.isFinite(value) || value <= 0) {
        continue;
      }
      linkMap.set(key, { source: pair.source, target: pair.target, value });
    }
  }

  // 2. Keep only links that preserve a directed acyclic graph.
  const adjacency = new Map<string, Set<string>>();
  const canReach = (from: string, to: string): boolean => {
    const stack = [from];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === to) {
        return true;
      }
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);
      const next = adjacency.get(node);
      if (next) {
        stack.push(...next);
      }
    }
    return false;
  };

  const nodeOrder: string[] = [];
  const seenNodes = new Set<string>();
  const addNode = (id: string) => {
    if (!seenNodes.has(id)) {
      seenNodes.add(id);
      nodeOrder.push(id);
    }
  };

  const links: { source: string; target: string; value: number }[] = [];
  for (const link of linkMap.values()) {
    // Adding source→target would close a cycle if target already reaches source.
    if (canReach(link.target, link.source)) {
      continue;
    }
    addNode(link.source);
    addNode(link.target);
    let out = adjacency.get(link.source);
    if (!out) {
      out = new Set<string>();
      adjacency.set(link.source, out);
    }
    out.add(link.target);
    links.push(link);
  }

  return {
    nodes: nodeOrder.map((id) => ({ id })),
    links,
  };
}
