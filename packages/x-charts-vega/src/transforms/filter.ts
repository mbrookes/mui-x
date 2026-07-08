import type { DatasetRow, VegaFilterTransform } from '../types';
import type { GapCollector } from '../gaps';
import {
  compileExpression,
  compareValues,
  isTruthy,
  looseEquals,
  UnsupportedExpressionError,
} from './calculate';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `filter` accepts several predicate shapes:
 *  - a Vega expression string (e.g. "datum.x > 5") — evaluated via the
 *    shared safe evaluator in calculate.ts (never eval()/new Function()).
 *  - a field predicate `{field, equal|lt|lte|gt|gte|oneOf|range|valid}`,
 *    optionally `timeUnit`-qualified (compared against the raw field value,
 *    reported as a 'partial' gap since the value isn't actually truncated).
 *  - logical composition `{and: [...]}`, `{or: [...]}`, `{not: ...}`.
 *  - anything else (selection/param predicates, malformed predicates) is
 *    reported as an 'unsupported' gap and treated as UNKNOWN (fail open —
 *    rows are kept rather than silently dropped).
 *
 * Predicates evaluate to three-valued logic: `true`, `false`, or `'unknown'`
 * for unsupported predicates. `'unknown'` propagates through and/or/not
 * (notably `not: <unsupported>` stays `'unknown'` instead of inverting the
 * fail-open default into dropping every row) and only collapses to "keep the
 * row" at the top level.
 */

type PredicateResult = boolean | 'unknown';
type Predicate = (row: DatasetRow) => PredicateResult;

interface FieldPredicate {
  field: string;
  timeUnit?: unknown;
  equal?: unknown;
  lt?: unknown;
  lte?: unknown;
  gt?: unknown;
  gte?: unknown;
  range?: [unknown, unknown];
  oneOf?: unknown[];
  valid?: boolean;
}

function isFieldPredicate(value: unknown): value is FieldPredicate {
  return (
    !!value && typeof value === 'object' && typeof (value as { field?: unknown }).field === 'string'
  );
}

const COMPARATOR_KEYS = ['equal', 'lt', 'lte', 'gt', 'gte', 'range', 'oneOf', 'valid'] as const;

function compileFieldPredicate(pred: FieldPredicate, gaps: GapCollector, path: string): Predicate {
  if (pred.timeUnit !== undefined) {
    gaps.add({
      code: 'filter:timeUnit-predicate',
      message: `The \`timeUnit\`-qualified filter predicate on "${pred.field}" is compared against the raw field value (it is not truncated first), which may over- or under-match.`,
      severity: 'partial',
      path,
    });
  }
  if (!COMPARATOR_KEYS.some((key) => pred[key] !== undefined)) {
    gaps.add({
      code: 'filter:empty-predicate',
      message: `The filter predicate for field "${pred.field}" has no recognized comparator (equal/lt/lte/gt/gte/range/oneOf/valid); no rows were filtered by it.`,
      severity: 'unsupported',
      path,
    });
    return () => 'unknown';
  }
  const { field } = pred;
  return (row) => {
    const raw = row[field];
    if (pred.valid !== undefined) {
      const isValid =
        raw != null &&
        !(typeof raw === 'number' && Number.isNaN(raw)) &&
        !(raw instanceof Date && Number.isNaN(raw.getTime()));
      return pred.valid ? isValid : !isValid;
    }
    if (pred.equal !== undefined) {
      return looseEquals(raw, pred.equal);
    }
    if (pred.oneOf !== undefined) {
      return pred.oneOf.some((candidate) => looseEquals(raw, candidate));
    }
    // lt/lte/gt/gte/range require an orderable raw value; a missing value
    // never satisfies an order comparison (matches Vega-Lite's own behavior,
    // and avoids nonsensical string-coerced comparisons against null).
    if (raw == null) {
      return false;
    }
    if (pred.lt !== undefined) {
      return compareValues(raw, pred.lt) < 0;
    }
    if (pred.lte !== undefined) {
      return compareValues(raw, pred.lte) <= 0;
    }
    if (pred.gt !== undefined) {
      return compareValues(raw, pred.gt) > 0;
    }
    if (pred.gte !== undefined) {
      return compareValues(raw, pred.gte) >= 0;
    }
    if (pred.range !== undefined) {
      const [lo, hi] = pred.range;
      return compareValues(raw, lo) >= 0 && compareValues(raw, hi) <= 0;
    }
    return true;
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compileExpressionPredicate(filter: string, gaps: GapCollector, path: string): Predicate {
  let evaluator: (datum: DatasetRow) => unknown;
  try {
    evaluator = compileExpression(filter);
  } catch (err) {
    if (!(err instanceof UnsupportedExpressionError)) {
      throw err;
    }
    gaps.add({
      code: 'transform:filter-expression',
      message: `The filter expression "${filter}" uses unsupported syntax (${errorMessage(err)}); no rows were filtered by it.`,
      severity: 'unsupported',
      path,
    });
    return () => 'unknown';
  }
  return (row) => {
    try {
      return isTruthy(evaluator(row));
    } catch (err) {
      // Only UnsupportedExpressionError is an expected outcome (an
      // unsupported construct reached at runtime). Anything else is a bug in
      // the evaluator — rethrow instead of silently keeping the row.
      if (!(err instanceof UnsupportedExpressionError)) {
        throw err;
      }
      gaps.add({
        code: 'transform:filter-expression',
        message: `The filter expression "${filter}" uses unsupported syntax (${errorMessage(err)}) for some rows; those rows were kept.`,
        severity: 'unsupported',
        path,
      });
      return 'unknown';
    }
  };
}

function compilePredicate(filter: unknown, gaps: GapCollector, path: string): Predicate {
  if (typeof filter === 'string') {
    return compileExpressionPredicate(filter, gaps, path);
  }

  if (filter && typeof filter === 'object') {
    const obj = filter as Record<string, unknown>;
    if (Array.isArray(obj.and)) {
      const predicates = obj.and.map((entry, index) =>
        compilePredicate(entry, gaps, `${path}.and[${index}]`),
      );
      return (row) => {
        let unknown = false;
        for (const predicate of predicates) {
          const result = predicate(row);
          if (result === false) {
            return false;
          }
          if (result === 'unknown') {
            unknown = true;
          }
        }
        return unknown ? 'unknown' : true;
      };
    }
    if (Array.isArray(obj.or)) {
      const predicates = obj.or.map((entry, index) =>
        compilePredicate(entry, gaps, `${path}.or[${index}]`),
      );
      return (row) => {
        let unknown = false;
        for (const predicate of predicates) {
          const result = predicate(row);
          if (result === true) {
            return true;
          }
          if (result === 'unknown') {
            unknown = true;
          }
        }
        return unknown ? 'unknown' : false;
      };
    }
    if (obj.not !== undefined) {
      const predicate = compilePredicate(obj.not, gaps, `${path}.not`);
      return (row) => {
        const result = predicate(row);
        return result === 'unknown' ? 'unknown' : !result;
      };
    }
    if (isFieldPredicate(filter)) {
      return compileFieldPredicate(filter, gaps, path);
    }
    gaps.add({
      code: 'filter:unsupported-shape',
      message:
        'This filter predicate shape (likely a selection/parameter reference) is not supported; no rows were filtered by it.',
      severity: 'unsupported',
      path,
    });
    return () => 'unknown';
  }

  gaps.add({
    code: 'filter:unsupported-shape',
    message: 'Unrecognized filter predicate; no rows were filtered by it.',
    severity: 'unsupported',
    path,
  });
  return () => 'unknown';
}

export function applyFilterTransform(
  rows: readonly DatasetRow[],
  transform: VegaFilterTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const predicate = compilePredicate(transform.filter, gaps, path);
  // 'unknown' (unsupported predicate) keeps the row: fail open.
  return rows.filter((row) => predicate(row) !== false);
}
