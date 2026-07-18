import type { DatasetRow, VegaFilterTransform, VegaTimeUnit } from '../types';
import type { GapCollector } from '../gaps';
import {
  compileExpression,
  compareValues,
  isTruthy,
  looseEquals,
  UnsupportedExpressionError,
} from './calculate';
import { resolveTimeUnit, unitValueToDate } from './timeUnit';
import { toDate } from '../compile/fieldTypes';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `filter` accepts several predicate shapes:
 *  - a Vega expression string (e.g. "datum.x > 5") — evaluated via the
 *    shared safe evaluator in calculate.ts (never eval()/new Function()).
 *  - a field predicate `{field, equal|lt|lte|gt|gte|oneOf|range|valid}`,
 *    optionally `timeUnit`-qualified: the field is truncated via
 *    `resolveTimeUnit` and each comparator value is converted to the
 *    equivalent synthetic date via `unitValueToDate`, matching how Vega-Lite
 *    itself compiles this predicate (`compileTimeUnitFieldPredicate`). Falls
 *    back to comparing the raw field value (with a 'partial' gap) only for
 *    comparator shapes `unitValueToDate` can't build a date from — a
 *    composite unit, `day`/`dayofyear`/`week`, or `valid`.
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

/**
 * Compiles a `timeUnit`-qualified comparator into an exact predicate: the
 * field is truncated via `resolveTimeUnit` (the same truncation the
 * `timeUnit` transform/encoding path uses) and each comparator value is
 * converted to the equivalent synthetic date via `unitValueToDate`
 * (mirroring how Vega-Lite itself compiles this predicate — both sides
 * become a `timeUnit`-truncated timestamp, not a raw-value comparison).
 * Returns `null` when a comparator value can't be converted this way (a
 * composite unit, `day`/`dayofyear`/`week`, or a non-numeric comparator like
 * `valid`), so the caller falls back to the raw comparison with its existing
 * `partial` gap.
 */
function compileTimeUnitFieldPredicate(
  pred: FieldPredicate,
  gaps: GapCollector,
  path: string,
): Predicate | null {
  if (pred.valid !== undefined) {
    return null;
  }
  const unit = pred.timeUnit as VegaTimeUnit;
  const convert = (value: unknown): Date | null => unitValueToDate(unit, value);

  const equal = pred.equal !== undefined ? convert(pred.equal) : undefined;
  if (pred.equal !== undefined && equal === null) {
    return null;
  }
  const lt = pred.lt !== undefined ? convert(pred.lt) : undefined;
  if (pred.lt !== undefined && lt === null) {
    return null;
  }
  const lte = pred.lte !== undefined ? convert(pred.lte) : undefined;
  if (pred.lte !== undefined && lte === null) {
    return null;
  }
  const gt = pred.gt !== undefined ? convert(pred.gt) : undefined;
  if (pred.gt !== undefined && gt === null) {
    return null;
  }
  const gte = pred.gte !== undefined ? convert(pred.gte) : undefined;
  if (pred.gte !== undefined && gte === null) {
    return null;
  }

  let rangeLo: Date | null | undefined;
  let rangeHi: Date | null | undefined;
  if (pred.range !== undefined) {
    const [lo, hi] = pred.range;
    rangeLo = lo == null ? null : convert(lo);
    if (lo != null && rangeLo === null) {
      return null;
    }
    rangeHi = hi == null ? null : convert(hi);
    if (hi != null && rangeHi === null) {
      return null;
    }
  }

  let oneOf: Array<Date | null> | undefined;
  if (pred.oneOf !== undefined) {
    oneOf = pred.oneOf.map(convert);
    if (oneOf.some((d) => d === null)) {
      return null;
    }
  }

  const { field } = pred;
  return (row) => {
    const date = toDate(row[field]);
    if (date == null) {
      return false;
    }
    const truncated = resolveTimeUnit(date, unit, gaps, path);
    if (truncated == null) {
      return 'unknown';
    }
    const t = truncated.getTime();
    if (equal != null) {
      return t === equal.getTime();
    }
    if (oneOf !== undefined) {
      return oneOf.some((d) => d !== null && t === d.getTime());
    }
    if (lt != null) {
      return t < lt.getTime();
    }
    if (lte != null) {
      return t <= lte.getTime();
    }
    if (gt != null) {
      return t > gt.getTime();
    }
    if (gte != null) {
      return t >= gte.getTime();
    }
    if (pred.range !== undefined) {
      const loOk = rangeLo == null || t >= rangeLo.getTime();
      const hiOk = rangeHi == null || t <= rangeHi.getTime();
      return loOk && hiOk;
    }
    return true;
  };
}

function compileFieldPredicate(pred: FieldPredicate, gaps: GapCollector, path: string): Predicate {
  if (!COMPARATOR_KEYS.some((key) => pred[key] !== undefined)) {
    gaps.add({
      code: 'filter:empty-predicate',
      message: `The filter predicate for field "${pred.field}" has no recognized comparator (equal/lt/lte/gt/gte/range/oneOf/valid); no rows were filtered by it.`,
      severity: 'unsupported',
      path,
    });
    return () => 'unknown';
  }
  if (pred.timeUnit !== undefined) {
    const exact = compileTimeUnitFieldPredicate(pred, gaps, path);
    if (exact) {
      return exact;
    }
    gaps.add({
      code: 'filter:timeUnit-predicate',
      message: `The \`timeUnit\`-qualified filter predicate on "${pred.field}" is compared against the raw field value (it is not truncated first), which may over- or under-match.`,
      severity: 'partial',
      path,
    });
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

function compileExpressionPredicate(
  filter: string,
  gaps: GapCollector,
  path: string,
  signals?: Readonly<Record<string, unknown>>,
): Predicate {
  let evaluator: (datum: DatasetRow) => unknown;
  try {
    evaluator = compileExpression(filter, signals);
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

function compilePredicate(
  filter: unknown,
  gaps: GapCollector,
  path: string,
  signals?: Readonly<Record<string, unknown>>,
): Predicate {
  if (typeof filter === 'string') {
    return compileExpressionPredicate(filter, gaps, path, signals);
  }

  if (filter && typeof filter === 'object') {
    const obj = filter as Record<string, unknown>;
    if (Array.isArray(obj.and)) {
      const predicates = obj.and.map((entry, index) =>
        compilePredicate(entry, gaps, `${path}.and[${index}]`, signals),
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
        compilePredicate(entry, gaps, `${path}.or[${index}]`, signals),
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
      const predicate = compilePredicate(obj.not, gaps, `${path}.not`, signals);
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
  signals?: Readonly<Record<string, unknown>>,
): readonly DatasetRow[] {
  const predicate = compilePredicate(transform.filter, gaps, path, signals);
  // 'unknown' (unsupported predicate) keeps the row: fail open.
  return rows.filter((row) => predicate(row) !== false);
}
