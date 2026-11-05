/**
 * Translates Studio's filter tree (`StudioFilterNode`) to the data layer filter AST.
 *
 * The translation keeps Studio's in-memory semantics where the two differ:
 * - negated ops (`not_equals`, `not_in`, `does_not_contain`, `not_starts_with`) keep null rows;
 * - a bare `YYYY-MM-DD` bound on a `datetime` field covers the whole calendar day (UTC);
 * - `is_empty` on a string field also matches `''`;
 * - a selection-mode `in []` matches every row, a condition-mode `in []` matches none.
 *
 * Ops with no data layer equivalent (`ends_with`, `not_ends_with`) and cross-source leaves
 * throw `OPERATOR_NOT_SUPPORTED`, so the widget shows why instead of returning wrong rows.
 * The server still checks `filterable`, op and field type, and `requiredFilters`.
 */
import { isRelativeDateValue, resolveRelativeDate } from '@mui/x-studio';
import type { StudioFilterNode, StudioFilterOperator } from '@mui/x-studio';
import {
  DataLayerError,
  type DataLayerFieldType,
  type DataLayerFilter,
  type DataLayerScalar,
} from './client';

type Leaf = Extract<StudioFilterNode, { type: 'leaf' }>;

/** Matches no row. The data layer has no constant node, and `in` needs a non-empty list. */
const MATCH_NONE = (field: string): DataLayerFilter => ({
  and: [
    { field, op: 'isNull' },
    { field, op: 'isNotNull' },
  ],
});

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function resolve(value: unknown): unknown {
  return isRelativeDateValue(value) ? resolveRelativeDate(value) : value;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function unsupported(message: string): never {
  throw new DataLayerError({ code: 'OPERATOR_NOT_SUPPORTED', message });
}

function orNull(field: string, filter: DataLayerFilter): DataLayerFilter {
  return { or: [filter, { field, op: 'isNull' }] };
}

function comparison(
  field: string,
  op: StudioFilterOperator,
  rawValue: unknown,
  type: DataLayerFieldType | undefined,
  filterMode: Leaf['filterMode'],
): DataLayerFilter | undefined {
  const value = resolve(rawValue);
  // A bare date on a datetime field means the whole day, so upper bounds move to the next day.
  const dayBound = type === 'datetime' && typeof value === 'string' && BARE_DATE.test(value);
  const scalar = value as DataLayerScalar;

  switch (op) {
    case 'is_empty':
      return type === 'string'
        ? {
            or: [
              { field, op: 'isNull' },
              { field, op: 'eq', value: '' },
            ],
          }
        : { field, op: 'isNull' };
    case 'is_not_empty':
      return type === 'string'
        ? {
            and: [
              { field, op: 'isNotNull' },
              { field, op: 'neq', value: '' },
            ],
          }
        : { field, op: 'isNotNull' };
    case 'in':
    case 'not_in': {
      if (!Array.isArray(value)) {
        return undefined;
      }
      if (value.length === 0) {
        return op === 'in' && filterMode !== 'selection' ? MATCH_NONE(field) : undefined;
      }
      const values = value.map(resolve) as DataLayerScalar[];
      return op === 'in'
        ? { field, op: 'in', value: values }
        : orNull(field, { field, op: 'nin', value: values });
    }
    case 'between': {
      const range = (value ?? {}) as { from?: unknown; to?: unknown };
      const parts = [
        comparison(field, 'greater_than_or_equal', range.from, type, filterMode),
        comparison(field, 'less_than_or_equal', range.to, type, filterMode),
      ].filter((part): part is DataLayerFilter => part !== undefined);
      return combine('and', parts);
    }
    default:
      break;
  }

  if (isBlank(value)) {
    return undefined;
  }
  switch (op) {
    case 'equals':
      return dayBound
        ? {
            and: [
              { field, op: 'gte', value: scalar },
              { field, op: 'lt', value: nextDay(value as string) },
            ],
          }
        : { field, op: 'eq', value: scalar };
    case 'not_equals':
      return dayBound
        ? {
            or: [
              { field, op: 'lt', value: scalar },
              { field, op: 'gte', value: nextDay(value as string) },
              { field, op: 'isNull' },
            ],
          }
        : orNull(field, { field, op: 'neq', value: scalar });
    case 'contains':
      return { field, op: 'contains', value: String(value) };
    case 'does_not_contain':
      return orNull(field, { not: { field, op: 'contains', value: String(value) } });
    case 'starts_with':
      return { field, op: 'startsWith', value: String(value) };
    case 'not_starts_with':
      return orNull(field, { not: { field, op: 'startsWith', value: String(value) } });
    case 'greater_than':
      return dayBound
        ? { field, op: 'gte', value: nextDay(value as string) }
        : { field, op: 'gt', value: scalar };
    case 'greater_than_or_equal':
      return { field, op: 'gte', value: scalar };
    case 'less_than':
      return { field, op: 'lt', value: scalar };
    case 'less_than_or_equal':
      return dayBound
        ? { field, op: 'lt', value: nextDay(value as string) }
        : { field, op: 'lte', value: scalar };
    default:
      return unsupported(`The data layer has no '${op}' operator (field: ${field}).`);
  }
}

/** `undefined` children match every row: they drop out of `and` and make `or` match all. */
function combine(
  logic: 'and' | 'or',
  children: (DataLayerFilter | undefined)[],
): DataLayerFilter | undefined {
  if (logic === 'or' && children.some((child) => child === undefined)) {
    return undefined;
  }
  const defined = children.filter((child): child is DataLayerFilter => child !== undefined);
  if (defined.length <= 1) {
    return defined[0];
  }
  return logic === 'and' ? { and: defined } : { or: defined };
}

function translate(
  node: StudioFilterNode,
  sourceId: string,
  fieldTypes: ReadonlyMap<string, DataLayerFieldType>,
): DataLayerFilter | undefined {
  if (node.type === 'group') {
    return combine(
      node.logic,
      node.children.map((child) => translate(child, sourceId, fieldTypes)),
    );
  }
  // Studio re-applies rank filters to the returned rows itself.
  if (node.filterMode === 'rank') {
    return undefined;
  }
  if (node.filterSourceId && node.filterSourceId !== sourceId) {
    return unsupported(`Filters on another data source are not supported (field: ${node.field}).`);
  }
  const type = fieldTypes.get(node.field);
  const first = comparison(node.field, node.op, node.value, type, node.filterMode);
  if (!node.op2) {
    return first;
  }
  const second = comparison(node.field, node.op2, node.value2, type, node.filterMode);
  // A blank condition is inactive, so the other one applies alone, even under `or`.
  if (first === undefined || second === undefined) {
    return first ?? second;
  }
  return combine(node.conjunction ?? 'and', [first, second]);
}

export function toDataLayerWhere(
  filter: StudioFilterNode | undefined,
  sourceId: string,
  fieldTypes: ReadonlyMap<string, DataLayerFieldType>,
): DataLayerFilter | undefined {
  return filter ? translate(filter, sourceId, fieldTypes) : undefined;
}
