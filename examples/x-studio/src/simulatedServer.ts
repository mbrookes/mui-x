import type {
  StudioDataSourceAdapter,
  StudioFilterNode,
  StudioQueryDescriptor,
  StudioQueryResult,
} from '@mui/x-studio';

type Row = Record<string, unknown>;

// ── Filter tree evaluator ───────────────────────────────────────────────────

function matchLeaf(row: Row, node: Extract<StudioFilterNode, { type: 'leaf' }>): boolean {
  const rawVal = row[node.field];
  const { op, value } = node;

  // Date normalisation: coerce to comparable string/number
  const coerce = (v: unknown): string | number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return String(v);
  };

  const rv = coerce(rawVal);
  const fv = coerce(value);
  const fv2 = coerce(node.value2);

  switch (op) {
    case 'equals':
      return rv === fv;
    case 'not_equals':
      return rv !== fv;
    case 'greater_than':
      return rv !== null && fv !== null && rv > fv;
    case 'greater_than_or_equal':
      return rv !== null && fv !== null && rv >= fv;
    case 'less_than':
      return rv !== null && fv !== null && rv < fv;
    case 'less_than_or_equal':
      return rv !== null && fv !== null && rv <= fv;
    case 'contains':
      return (
        rv !== null &&
        String(rv)
          .toLowerCase()
          .includes(String(fv ?? '').toLowerCase())
      );
    case 'does_not_contain':
      return (
        rv !== null &&
        !String(rv)
          .toLowerCase()
          .includes(String(fv ?? '').toLowerCase())
      );
    case 'starts_with':
      return (
        rv !== null &&
        String(rv)
          .toLowerCase()
          .startsWith(String(fv ?? '').toLowerCase())
      );
    case 'not_starts_with':
      return (
        rv !== null &&
        !String(rv)
          .toLowerCase()
          .startsWith(String(fv ?? '').toLowerCase())
      );
    case 'ends_with':
      return (
        rv !== null &&
        String(rv)
          .toLowerCase()
          .endsWith(String(fv ?? '').toLowerCase())
      );
    case 'not_ends_with':
      return (
        rv !== null &&
        !String(rv)
          .toLowerCase()
          .endsWith(String(fv ?? '').toLowerCase())
      );
    case 'is_empty':
      return rv === null || String(rv).trim() === '';
    case 'is_not_empty':
      return rv !== null && String(rv).trim() !== '';
    case 'in': {
      const list = Array.isArray(value) ? (value as unknown[]).map(coerce) : [fv];
      return list.includes(rv);
    }
    case 'between':
      return rv !== null && fv !== null && fv2 !== null && rv >= fv && rv <= fv2;
    default:
      return true;
  }
}

function applyFilterNode(row: Row, node: StudioFilterNode | undefined): boolean {
  if (!node) return true;

  if (node.type === 'leaf') {
    const primaryMatch = matchLeaf(row, node);
    if (!node.conjunction || !node.op2) {
      return primaryMatch;
    }
    const secondaryLeaf: Extract<StudioFilterNode, { type: 'leaf' }> = {
      ...node,
      op: node.op2,
      value: node.value2,
    };
    const secondaryMatch = matchLeaf(row, secondaryLeaf);
    return node.conjunction === 'or'
      ? primaryMatch || secondaryMatch
      : primaryMatch && secondaryMatch;
  }

  // group node
  const { logic, children } = node;
  if (logic === 'or') {
    return children.some((child) => applyFilterNode(row, child));
  }
  return children.every((child) => applyFilterNode(row, child));
}

function filterRows(rows: Row[], filter: StudioFilterNode | undefined): Row[] {
  if (!filter) return rows;
  return rows.filter((row) => applyFilterNode(row, filter));
}

// ── Aggregation ─────────────────────────────────────────────────────────────

type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

function aggregate(rows: Row[], field: string, fn: AggFn): number {
  const values = rows.map((r) => r[field]).filter((v): v is number => typeof v === 'number');

  switch (fn) {
    case 'count':
      return rows.length;
    case 'count_distinct':
      return new Set(rows.map((r) => r[field])).size;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case 'min':
      return values.length > 0 ? Math.min(...values) : 0;
    case 'max':
      return values.length > 0 ? Math.max(...values) : 0;
    default:
      return 0;
  }
}

// ── Adapter factory ─────────────────────────────────────────────────────────

/**
 * Creates a StudioDataSourceAdapter backed by an in-memory array of rows.
 * Simulates a server by applying filters and (optionally) aggregations from the
 * query descriptor, with a configurable artificial latency.
 *
 * @param rows - The raw data rows to query against.
 * @param minLatencyMs - Minimum artificial latency in ms (default: 80).
 * @param maxLatencyMs - Maximum artificial latency in ms (default: 280).
 */
export function createAdapter(
  rows: Row[],
  minLatencyMs = 80,
  maxLatencyMs = 280,
): StudioDataSourceAdapter {
  return {
    async getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      // Simulate network latency
      const delay = minLatencyMs + Math.random() * (maxLatencyMs - minLatencyMs);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });

      // Step 1: apply filter tree
      const filtered = filterRows(rows, descriptor.filter);

      // Step 2: if aggregations are requested, group + aggregate
      if (descriptor.groupBy && descriptor.aggregations && descriptor.aggregations.length > 0) {
        const groups = new Map<string, Row[]>();

        for (const row of filtered) {
          const key = String(row[descriptor.groupBy] ?? '__null__');
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key)!.push(row);
        }

        const aggregatedRows: Row[] = [];
        for (const [groupKey, groupRows] of groups) {
          const aggRow: Row = { [descriptor.groupBy]: groupKey === '__null__' ? null : groupKey };
          for (const agg of descriptor.aggregations) {
            aggRow[agg.alias] = aggregate(groupRows, agg.field, agg.fn as AggFn);
          }
          aggregatedRows.push(aggRow);
        }

        return { rows: aggregatedRows, totalCount: aggregatedRows.length };
      }

      // Step 3: return raw filtered rows (select projection is optional — return all fields)
      return { rows: filtered, totalCount: filtered.length };
    },
  };
}
