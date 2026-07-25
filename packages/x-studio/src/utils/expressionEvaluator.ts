import dayjs from 'dayjs';

import type {
  StudioExpression,
  StudioExpressionField,
  StudioExpressionOperator,
  StudioDataField,
  StudioFunctionExpression,
  StudioValueExpression,
  StudioFieldExpression,
  StudioJoinFieldExpression,
  StudioKpiAggregation,
  StudioDataSource,
  StudioRelationship,
} from '../models';
import { aggregateNumbers, coerceAggregateValue, countDistinct } from '../internals/aggregate';
import { normalizeJoinKey } from '../internals/joinKeys';
import { collectJoinSourceIds } from '../internals/expressionRefs';
import { getCachedNormalizedDataSource } from '../internals/normalizedRowsCache';

// ─── Structural limits ────────────────────────────────────────────────────────

/**
 * Maximum nesting depth accepted for an expression AST.
 *
 * `JSON.parse` is iterative in V8, so a deeply nested persisted expression (e.g. ~20 000
 * nested `negate` nodes — only a few hundred KB of JSON) deserializes without complaint and
 * only blows the stack later, inside the recursive walkers below (`evaluateExpression`,
 * `validateExpression`, `collectFieldRefs`, `inferExpressionType`, `evalMeasureExpression`).
 * Every one of those walkers therefore carries a depth counter and bails at this bound
 * instead of recursing until `RangeError: Maximum call stack size exceeded` takes down the
 * whole drawer/page. 64 is far beyond anything the expression builder UI can author (its
 * deepest built-in template is ~4 levels).
 */
export const MAX_EXPRESSION_DEPTH = 64;

// ─── Type guards ──────────────────────────────────────────────────────────────

/**
 * Local structural check used by the expression type guards below.
 *
 * The guards are declared over `StudioExpression`, but they are routinely reached with
 * values that are only *typed* as one: `loadSerializedState` screens a persisted
 * `expressionFields[i]` for being a record and never looks at its `expression` at all, so a
 * corrupted/hostile doc can hand every walker in this module a string, a number, `null`, or
 * `undefined`. Applying `in` to such a value throws a raw
 * `TypeError: Cannot use 'in' operator to search for 'operator' in 1 + 1` — which, from a
 * render path, blanks the data drawer and every widget on the source. Screening with
 * `isRecord` first turns that crash into the module's normal "unresolvable node" fallback.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A function node must carry an `inputs` ARRAY, not merely an `operator` key: every walker
 * that accepts this guard immediately iterates `inputs` (here, and in
 * `internals/expressionRefs.ts`), so admitting `{ operator: 'add' }` or
 * `{ operator: 'add', inputs: 'nope' }` would just move the crash one line down. A node with
 * a missing/!Array `inputs` matches none of the four guards and is handled by each walker's
 * "unrecognized node" fallback (`null` when evaluating, an error when validating).
 */
export function isFunctionExpression(expr: StudioExpression): expr is StudioFunctionExpression {
  return isRecord(expr) && 'operator' in expr && Array.isArray(expr.inputs);
}

export function isValueExpression(expr: StudioExpression): expr is StudioValueExpression {
  return isRecord(expr) && 'type' in expr && 'value' in expr;
}

export function isFieldExpression(expr: StudioExpression): expr is StudioFieldExpression {
  return (
    isRecord(expr) && 'id' in expr && !('operator' in expr) && !('type' in expr && 'value' in expr)
  );
}

export function isJoinFieldExpression(expr: StudioExpression): expr is StudioJoinFieldExpression {
  return isRecord(expr) && 'joinSourceId' in expr && 'fieldId' in expr;
}

/**
 * The `inputs` of a function node, normalized to an array. `isFunctionExpression` already
 * guarantees this for every node that reaches a walker through the guards, but the
 * lower-level helpers below are also called directly, so they normalize defensively rather
 * than trusting the declared type.
 */
function expressionInputs(expr: StudioFunctionExpression): StudioExpression[] {
  return Array.isArray(expr.inputs) ? expr.inputs : [];
}

// ─── Evaluation context ───────────────────────────────────────────────────────

export interface EvaluationContext {
  /** All expression fields (for cross-expression-field reference resolution). */
  expressionFields: StudioExpressionField[];
  /** All physical + computed row values for the current row being evaluated. */
  row: Record<string, unknown>;
  /** All rows in the dataset (needed to evaluate measure sub-expressions inside non-measure contexts). */
  allRows: Record<string, unknown>[];
  /** The data source ID that owns the rows being evaluated. */
  sourceId?: string;
  /** All data sources (needed to resolve join field expressions). */
  dataSources?: Record<string, StudioDataSource>;
  /** Declared source relationships (needed to resolve join field expressions). */
  relationships?: StudioRelationship[];
  /**
   * Pre-built lookup indexes for JoinFieldExpression columns.
   * Keyed by joinSourceId → { sourceField: FK field on the current row, index: fkValue → related row }.
   * When present, avoids O(M) linear scans over the related source's rows per evaluated row.
   * Built by enrichRowsWithExpressions before the row loop.
   */
  joinIndexes?: Map<string, { sourceField: string; index: Map<string, Record<string, unknown>> }>;
  /**
   * Internal cycle guard: ids of expression fields currently being resolved via the
   * field-reference recursion in `evaluateExpression`'s `isFieldExpression` branch.
   * `detectCycles`/`validateExpressionField` reject cycles at the controller boundary
   * when fields are added/updated, but a persisted doc created before that validation
   * existed, or a host integration that bypasses the controller, could still hand the
   * evaluator a circular reference graph — this guard makes the evaluator itself safe
   * against that (finding 2.8) instead of relying solely on upstream validation.
   */
  resolvingFieldIds?: Set<string>;
}

// ─── Core evaluator ──────────────────────────────────────────────────────────

type ScalarValue = string | number | boolean | null | undefined;

function toNumber(v: unknown): number {
  if (v == null) {
    return 0;
  }
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function toBoolean(v: unknown): boolean {
  if (v == null) {
    return false;
  }
  if (typeof v === 'boolean') {
    return v;
  }
  // A CSV/API-sourced boolean column often serializes as the strings "true"/"false" rather than
  // an actual JS boolean. `Boolean("false") === true` in JS, so without this explicit check every
  // such row evaluated truthy here (e.g. `if(on_time, 1, 0)` always took the truthy branch) —
  // diverging from `filterUtils.ts`'s explicit string-boolean `equals` branch (~267-269), which
  // string-compares rather than relying on JS truthy coercion and handles the identical data
  // correctly. Matching that policy here keeps expression evaluation and filtering in agreement
  // (finding 12).
  if (typeof v === 'string') {
    if (v === 'false') {
      return false;
    }
    if (v === 'true') {
      return true;
    }
  }
  return Boolean(v);
}

function toDateString(v: unknown): string {
  return String(v ?? '');
}

/**
 * True when `v` should be compared numerically by `compareOrdered` below: actual numbers,
 * booleans (mirroring the previous `toNumber`-based behavior, where `Number(true) === 1`), and
 * strings that parse cleanly as a number. A non-empty string that does NOT parse as a number
 * (e.g. an ISO date string, or an arbitrary label) is deliberately excluded so it falls through
 * to the lexicographic string comparison instead of silently coercing to `NaN`/0.
 */
function isNumericLike(v: unknown): boolean {
  if (typeof v === 'number') {
    return Number.isFinite(v);
  }
  if (typeof v === 'boolean') {
    return true;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    return !Number.isNaN(Number(v));
  }
  return false;
}

/**
 * Ordering comparator backing the `lessThan`/`greaterThan`/`lessThanOrEqual`/
 * `greaterThanOrEqual` operators. Returns `null` when either operand is null/undefined —
 * mirroring the filter engine's explicit `rv != null` null-guard policy (`filterUtils.ts`'s
 * `greater_than`/`less_than`) — instead of the previous `toNumber` coercion, where
 * `toNumber(null) === 0` silently turned "no value" into a real (and often wrong) comparison
 * result: e.g. `lessThan(price, 10)` with `price: null` used to evaluate `true`.
 *
 * When both operands are numeric-like (see `isNumericLike`), compares numerically — matching
 * the historical behavior for actual numeric fields. Otherwise falls back to a lexicographic
 * string comparison: this also handles ISO-8601 date strings correctly (their lexicographic
 * order matches chronological order) and arbitrary string fields sensibly, rather than both
 * sides coercing to `NaN` → `0` and the comparison silently evaluating to a constant result for
 * every row (e.g. `if(order_date >= '2024-01-01', 'new', 'old')` previously always took the
 * 'new' branch).
 */
function compareOrdered(a: ScalarValue, b: ScalarValue): number | null {
  if (a == null || b == null) {
    return null;
  }
  if (isNumericLike(a) && isNumericLike(b)) {
    const an = Number(a);
    const bn = Number(b);
    if (an < bn) {
      return -1;
    }
    return an > bn ? 1 : 0;
  }
  const as = String(a);
  const bs = String(b);
  if (as < bs) {
    return -1;
  }
  return as > bs ? 1 : 0;
}

/**
 * Evaluates a single expression node against a row context.
 * Returns a scalar value (number, string, boolean, null).
 */
export function evaluateExpression(
  expr: StudioExpression,
  context: EvaluationContext,
): ScalarValue {
  return evaluateExpressionAtDepth(expr, context, 0);
}

function evaluateExpressionAtDepth(
  expr: StudioExpression,
  context: EvaluationContext,
  depth: number,
): ScalarValue {
  // Depth bound (see `MAX_EXPRESSION_DEPTH`): an over-deep persisted tree resolves to the
  // module's standard "unresolvable" value instead of overflowing the stack.
  if (depth > MAX_EXPRESSION_DEPTH) {
    return null;
  }

  if (isValueExpression(expr)) {
    return expr.value as ScalarValue;
  }

  if (isJoinFieldExpression(expr)) {
    const { joinSourceId, fieldId } = expr;
    const { row, sourceId, dataSources, relationships, joinIndexes } = context;
    if (!sourceId) {
      return null;
    }

    // Fast path: use pre-built index from enrichRowsWithExpressions (O(1) lookup).
    const precomputed = joinIndexes?.get(joinSourceId);
    if (precomputed) {
      // Keys are normalized (finding 3.16) so a numeric FK matches a string PK, the
      // same policy `gridGrouping.symmetricAggregate` uses for the same kind of
      // cross-source join — see `normalizeJoinKey`'s doc comment.
      const fkKey = normalizeJoinKey(row[precomputed.sourceField]);
      if (fkKey === null) {
        return null;
      }
      return (precomputed.index.get(fkKey)?.[fieldId] ?? null) as ScalarValue;
    }

    // Slow path fallback: used when called without a pre-built index (e.g. single-row eval).
    if (!dataSources || !relationships) {
      return null;
    }
    const rel = relationships.find((r) => r.sourceId === sourceId && r.targetId === joinSourceId);
    if (!rel) {
      return null;
    }
    const fkKey = normalizeJoinKey(row[rel.sourceField]);
    if (fkKey === null) {
      return null;
    }
    const relatedSource = dataSources[joinSourceId];
    // Route through `getCachedNormalizedDataSource` for L1 normalization (canonical date
    // strings, etc.) — same as `grainResolution.ts`/`crossSourceEnrichment.ts`/
    // `dataSourceGraph.ts` — instead of reading `.rows` raw. A raw `Date`/non-ISO string
    // copied from a foreign row here can bucket differently downstream in UTC-based chart
    // grouping vs. the local-calendar filter engine, and never matches an equality
    // cross-filter on that column (finding 10).
    const relatedRows = relatedSource
      ? getCachedNormalizedDataSource(relatedSource).rows
      : undefined;
    const relatedRow = relatedRows?.find((r) => normalizeJoinKey(r[rel.targetField]) === fkKey);
    return (relatedRow?.[fieldId] ?? null) as ScalarValue;
  }

  if (isFieldExpression(expr)) {
    const val = context.row[expr.id];
    if (val !== undefined) {
      return val as ScalarValue;
    }
    // Try evaluating a referenced expression field (calculated column only). Guard
    // against cyclic field references (finding 2.8): if `expr.id` is already being
    // resolved somewhere up this recursion chain, bail out to the same "unresolvable"
    // fallback (`null`) used elsewhere in this branch instead of recursing forever.
    const resolvingFieldIds = context.resolvingFieldIds ?? new Set<string>();
    if (resolvingFieldIds.has(expr.id)) {
      return null;
    }
    const exprField = context.expressionFields.find((ef) => ef.id === expr.id && !ef.isMeasure);
    if (exprField) {
      const nextResolving = new Set(resolvingFieldIds);
      nextResolving.add(expr.id);
      return evaluateExpressionAtDepth(
        exprField.expression,
        {
          ...context,
          resolvingFieldIds: nextResolving,
        },
        depth + 1,
      );
    }
    return null;
  }

  // Function expression. Anything that matches none of the four node shapes above is a
  // malformed persisted node (a string, a number, `null`, a function node with no `inputs`
  // array, …) — resolve it to `null` rather than destructuring it and throwing.
  if (!isFunctionExpression(expr)) {
    return null;
  }
  return evaluateFunctionExpression(expr, context, depth);
}

function evaluateFunctionExpression(
  expr: StudioFunctionExpression,
  context: EvaluationContext,
  depth: number = 0,
): ScalarValue {
  const { operator } = expr;
  const inputs = expressionInputs(expr);

  const evalNode = (inp: StudioExpression): ScalarValue =>
    evaluateExpressionAtDepth(inp, context, depth + 1);

  const evalInput = (index: number): ScalarValue =>
    inputs[index] !== undefined ? evalNode(inputs[index]) : null;

  switch (operator) {
    // ── Arithmetic ──────────────────────────────────────────────────────────
    case 'add':
      return inputs.reduce((acc, inp) => acc + toNumber(evalNode(inp)), 0);
    case 'subtract': {
      if (inputs.length === 0) {
        return 0;
      }
      const [first, ...rest] = inputs;
      return rest.reduce(
        (acc, inp) => acc - toNumber(evalNode(inp)),
        toNumber(evalNode(first)),
      );
    }
    case 'multiply':
      return inputs.reduce((acc, inp) => acc * toNumber(evalNode(inp)), 1);
    case 'divide': {
      const numerator = toNumber(evalInput(0));
      const denominator = toNumber(evalInput(1));
      return denominator === 0 ? null : numerator / denominator;
    }
    case 'modulo': {
      const dividend = toNumber(evalInput(0));
      const divisor = toNumber(evalInput(1));
      return divisor === 0 ? null : dividend % divisor;
    }
    case 'negate':
      return -toNumber(evalInput(0));

    // ── Comparison ──────────────────────────────────────────────────────────
    case 'equals':
      // eslint-disable-next-line eqeqeq
      return evalInput(0) == evalInput(1);
    case 'notEqual':
      // eslint-disable-next-line eqeqeq
      return evalInput(0) != evalInput(1);
    case 'lessThan': {
      const cmp = compareOrdered(evalInput(0), evalInput(1));
      return cmp === null ? null : cmp < 0;
    }
    case 'greaterThan': {
      const cmp = compareOrdered(evalInput(0), evalInput(1));
      return cmp === null ? null : cmp > 0;
    }
    case 'lessThanOrEqual': {
      const cmp = compareOrdered(evalInput(0), evalInput(1));
      return cmp === null ? null : cmp <= 0;
    }
    case 'greaterThanOrEqual': {
      const cmp = compareOrdered(evalInput(0), evalInput(1));
      return cmp === null ? null : cmp >= 0;
    }

    // ── Logical ─────────────────────────────────────────────────────────────
    case 'and':
      return inputs.every((inp) => toBoolean(evalNode(inp)));
    case 'or':
      return inputs.some((inp) => toBoolean(evalNode(inp)));
    case 'not':
      return !toBoolean(evalInput(0));
    case 'isTrue':
      return evalInput(0) === true;
    case 'isFalse':
      return evalInput(0) === false;
    case 'isNull':
      return evalInput(0) == null;
    case 'isNotNull':
      return evalInput(0) != null;

    // ── Conditional ─────────────────────────────────────────────────────────
    case 'if':
      // inputs[0] = condition, inputs[1] = then, inputs[2] = else
      return toBoolean(evalInput(0)) ? evalInput(1) : (evalInput(2) ?? null);

    case 'in': {
      // inputs[0] = value, inputs[1..n] = candidates
      const target = evalInput(0);
      return (
        inputs
          .slice(1)
          // eslint-disable-next-line eqeqeq
          .some((inp) => target == evalNode(inp))
      );
    }

    // ── Date ────────────────────────────────────────────────────────────────
    case 'datediff': {
      // inputs[0] = unit (string literal), inputs[1] = date1, inputs[2] = date2
      const unit = String(evalInput(0) ?? 'day') as dayjs.ManipulateType;
      const d1 = dayjs(toDateString(evalInput(1)));
      const d2 = dayjs(toDateString(evalInput(2)));
      if (!d1.isValid() || !d2.isValid()) {
        return null;
      }
      return d2.diff(d1, unit);
    }

    default: {
      const exhaustiveCheck: never = operator;
      void exhaustiveCheck;
      return null;
    }
  }
}

// ─── Row-level enrichment ─────────────────────────────────────────────────────

/**
 * Enriches rows with values computed by non-measure expression fields.
 * Returns a new array of rows with expression field values added.
 * Does NOT mutate the input rows.
 */
export function enrichRowsWithExpressions(
  rows: Record<string, unknown>[],
  expressionFields: StudioExpressionField[],
  sourceId: string,
  dataSources?: Record<string, StudioDataSource>,
  relationships?: StudioRelationship[],
): Record<string, unknown>[] {
  const columnFields = expressionFields.filter((ef) => ef.sourceId === sourceId && !ef.isMeasure);

  if (columnFields.length === 0) {
    return rows;
  }

  // Topologically sort expression fields so that fields that reference other
  // expression fields are computed after their dependencies.
  const sorted = topoSortExpressionFields(columnFields);

  // Pre-build join indexes for all JoinFieldExpression columns.
  // This converts the O(N×M) unindexed .find() per row into an O(M) one-time build
  // plus O(1) Map.get() per row — a dramatic speedup for large datasets.
  const joinIndexes = new Map<
    string,
    { sourceField: string; index: Map<string, Record<string, unknown>> }
  >();
  if (dataSources && relationships) {
    // Pre-build relationship index: targetId → relationship for O(1) lookup
    const relByTargetId = new Map<string, (typeof relationships)[number]>();
    for (const r of relationships) {
      if (r.sourceId === sourceId) {
        relByTargetId.set(r.targetId, r);
      }
    }
    for (const ef of sorted) {
      // Walk the FULL expression tree (`collectJoinSourceIds`) rather than checking only the
      // root node (the previous `isJoinFieldExpression(ef.expression)` check) — a join nested
      // inside a function call (e.g. `if(join(customers.country) == 'US', 1, 0)`) has a
      // FunctionExpression root, so the root-only check skipped the prebuild for it entirely
      // and fell back to the O(n×m) per-row linear scan in the slow path above (finding 11).
      for (const joinSourceId of collectJoinSourceIds(ef.expression)) {
        if (!joinIndexes.has(joinSourceId)) {
          const rel = relByTargetId.get(joinSourceId);
          if (rel) {
            // Keys are normalized (finding 3.16) via the shared `normalizeJoinKey`
            // policy so a numeric FK matches a string PK, same as
            // `gridGrouping.symmetricAggregate`'s cross-source join.
            const index = new Map<string, Record<string, unknown>>();
            // Route through `getCachedNormalizedDataSource` for L1 normalization, same as
            // the slow-path fallback above and every other reader in this codebase
            // (`grainResolution.ts`/`crossSourceEnrichment.ts`/`dataSourceGraph.ts`) —
            // instead of reading `.rows` raw (finding 10).
            const joinDataSource = dataSources[joinSourceId];
            const normalizedJoinRows = joinDataSource
              ? (getCachedNormalizedDataSource(joinDataSource).rows ?? [])
              : [];
            for (const r of normalizedJoinRows) {
              const key = normalizeJoinKey(r[rel.targetField]);
              // First-write-wins: preserves uniqueness for PK fields. Rows whose
              // key normalizes to null (missing/object) are skipped so they never
              // become a spurious join target.
              if (key !== null && !index.has(key)) {
                index.set(key, r as Record<string, unknown>);
              }
            }
            joinIndexes.set(joinSourceId, { sourceField: rel.sourceField, index });
          }
        }
      }
    }
  }

  return rows.map((originalRow) => {
    let row = originalRow;
    for (const ef of sorted) {
      const ctx: EvaluationContext = {
        expressionFields,
        row,
        allRows: rows,
        sourceId,
        dataSources,
        relationships,
        joinIndexes: joinIndexes.size > 0 ? joinIndexes : undefined,
      };
      const value = evaluateExpression(ef.expression, ctx);
      if (!(ef.id in row)) {
        row = { ...row, [ef.id]: value };
      }
    }
    return row;
  });
}

// ─── Measure evaluation ───────────────────────────────────────────────────────

/**
 * Evaluates a measure expression field over a (filtered) dataset.
 * Returns a single aggregate value, or `null` when the expression's own root
 * node is a `divide`/`modulo` by zero (finding 3.16 — matches the row-context
 * policy in `evaluateFunctionExpression`, where a fabricated `0` would be
 * misleading: "no valid result" is `null` in both contexts, not a silent 0).
 */
export function evaluateMeasure(
  exprField: StudioExpressionField,
  rows: Record<string, unknown>[],
  expressionFields: StudioExpressionField[],
): number | null {
  if (!exprField.isMeasure) {
    return 0;
  }
  return evalMeasureExpression(exprField.expression, rows, expressionFields, 0);
}

function evalMeasureExpression(
  expr: StudioExpression,
  rows: Record<string, unknown>[],
  expressionFields: StudioExpressionField[],
  depth: number,
): number | null {
  // Depth bound (see `MAX_EXPRESSION_DEPTH`) — same rationale as `evaluateExpressionAtDepth`.
  // `0` is this walker's established "nothing to contribute" value (its `default:` case).
  if (depth > MAX_EXPRESSION_DEPTH) {
    return 0;
  }

  if (isValueExpression(expr)) {
    return toNumber(expr.value);
  }

  if (isFieldExpression(expr)) {
    const { aggregation = 'sum' } = expr;
    if (aggregation === 'count_distinct') {
      // Distinctness is over the RAW cell values (strings, dates, …), not the numeric
      // coercion below — coercing first drops every non-numeric value to `null`, so a
      // `count_distinct` measure over a string field would collapse to 0 while the KPI
      // and grid paths over the same field return the true distinct count. Route through
      // the shared `countDistinct` (excludes null/undefined) so all three agree — the
      // "KPI over a raw field and a measure expression return the same number" invariant
      // (finding 2.23).
      return countDistinct(rows.map((r) => r[expr.id]));
    }
    if (aggregation === 'count') {
      // Pre-detect whether the field is numeric-like, mirroring the chart aggregators'
      // "treat as numeric if ANY non-null value coerces to a number" pre-detect
      // (`aggregators.ts`'s `aggregateByField`). When the field IS numeric-like, keep the
      // existing "count of numerically-valid values" semantics — this is deliberately pinned
      // by the `evaluateMeasure` test "counts only the numeric rows", which skips BOTH null
      // and non-numeric-string rows the same way `avg`/`min`/`max`'s denominator does. When
      // the field is genuinely non-numeric (e.g. a string `status` column), fall back to the
      // standard SQL `COUNT(col)` semantic — the non-null count of RAW values — instead of
      // silently returning 0 for every row, which disagreed with the KPI/grid `count` over the
      // same field (finding 4). Per `aggregate.ts`'s guidance, this counts directly from
      // `rows`, not from a null-filtered numeric value array.
      const isNumericField = rows.some((r) => coerceAggregateValue(r[expr.id]) !== null);
      if (isNumericField) {
        let numericCount = 0;
        for (const r of rows) {
          if (coerceAggregateValue(r[expr.id]) !== null) {
            numericCount += 1;
          }
        }
        return numericCount;
      }
      let nonNullCount = 0;
      for (const r of rows) {
        if (r[expr.id] != null) {
          nonNullCount += 1;
        }
      }
      return nonNullCount;
    }
    // Skip null / non-numeric rows BEFORE coercing (mirrors `computeAggregate`). The
    // previous `toNumber`-then-`isNaN` guard was dead code — `toNumber` maps null and
    // unparseable values to 0, so null rows silently entered every aggregate as 0,
    // inflating avg denominators and skewing min/count (finding 1.6).
    const values = rows.flatMap((r) => {
      const v = coerceAggregateValue(r[expr.id]);
      return v === null ? [] : [v];
    });
    return aggregate(values, aggregation);
  }

  if (isJoinFieldExpression(expr)) {
    // Join field expressions yield string values — treat as 0 in numeric measure context
    return 0;
  }

  // Anything matching none of the four node shapes above is a malformed persisted node —
  // fall back to this walker's `default:` value instead of destructuring it and throwing.
  if (!isFunctionExpression(expr)) {
    return 0;
  }

  // FunctionExpression — recursively evaluate each input as a measure scalar,
  // then apply the operator to those scalars. Nested `null` results (from a
  // divide/modulo by zero elsewhere in the tree) coerce to 0 here — the same
  // "null surfaces only at the top level, 0 once nested inside other arithmetic"
  // behavior the row-context evaluator gets from `toNumber(null) === 0`.
  const { operator } = expr;
  const inputs = expressionInputs(expr);
  const evalMeasureNode = (inp: StudioExpression): number | null =>
    evalMeasureExpression(inp, rows, expressionFields, depth + 1);
  const evalIn = (i: number): number =>
    inputs[i] !== undefined ? (evalMeasureNode(inputs[i]) ?? 0) : 0;

  switch (operator as StudioExpressionOperator) {
    case 'add':
      return inputs.reduce(
        (acc, inp) => acc + (evalMeasureNode(inp) ?? 0),
        0,
      );
    case 'subtract': {
      if (inputs.length === 0) {
        return 0;
      }
      const [first, ...rest] = inputs;
      return rest.reduce(
        (acc, inp) => acc - (evalMeasureNode(inp) ?? 0),
        evalMeasureNode(first) ?? 0,
      );
    }
    case 'multiply':
      return inputs.reduce(
        (acc, inp) => acc * (evalMeasureNode(inp) ?? 0),
        1,
      );
    case 'divide': {
      const n = evalIn(0);
      const d = evalIn(1);
      return d === 0 ? null : n / d;
    }
    case 'modulo': {
      const d = evalIn(1);
      return d === 0 ? null : evalIn(0) % d;
    }
    case 'negate':
      return -evalIn(0);
    case 'if':
    case 'isTrue':
    case 'isFalse':
    case 'isNull':
    case 'isNotNull':
    case 'equals':
    case 'notEqual':
    case 'lessThan':
    case 'greaterThan':
    case 'lessThanOrEqual':
    case 'greaterThanOrEqual':
    case 'and':
    case 'or':
    case 'not':
    case 'in': {
      // Conditional and logical operators: evaluate row-by-row then aggregate (sum).
      // This enables conditional sums like: if(on_time, 1, 0) → sum per-row results.
      // Coerce with the shared policy (booleans → 0/1) and skip null/non-numeric row
      // results before aggregating, mirroring the field-expression branch (finding 1.6).
      const rowValues = rows.flatMap((row) => {
        const v = coerceAggregateValue(
          evaluateFunctionExpression(expr, { row, expressionFields, allRows: rows }, depth),
        );
        return v === null ? [] : [v];
      });
      return aggregate(rowValues, 'sum');
    }
    case 'datediff': {
      // A measure whose root is a bare `datediff` (e.g. "avg days-to-ship") previously fell
      // through to the `default: return 0` case below, silently zeroing out the metric instead
      // of erroring or computing something meaningful. Reuse the row-context `datediff`
      // evaluation (the same `evaluateFunctionExpression` case used outside measures) per row,
      // and skip null/invalid results (mirrors the field-expression branch's null-skip policy).
      // Aggregate with `avg`: summing raw day-differences across an arbitrary row count has no
      // sensible business meaning, whereas an average always does — and it matches this
      // operator's only documented real-world use, "average days to ship" (finding 6).
      const rowValues = rows.flatMap((row) => {
        const v = coerceAggregateValue(
          evaluateFunctionExpression(expr, { row, expressionFields, allRows: rows }, depth),
        );
        return v === null ? [] : [v];
      });
      return aggregate(rowValues, 'avg');
    }
    default:
      return 0;
  }
}

// Thin alias over the shared reducer so measure aggregation shares the one
// null-skip / boolean-coercion policy (finding 2.1). `StudioKpiAggregation` is the
// same union as the shared `AggregateFn`.
function aggregate(values: number[], aggregation: StudioKpiAggregation): number {
  return aggregateNumbers(values, aggregation);
}

// ─── Type inference ───────────────────────────────────────────────────────────

const NUMERIC_OPERATORS = new Set<StudioExpressionOperator>([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'negate',
  'datediff',
]);

const BOOLEAN_OPERATORS = new Set<StudioExpressionOperator>([
  'equals',
  'notEqual',
  'lessThan',
  'greaterThan',
  'lessThanOrEqual',
  'greaterThanOrEqual',
  'and',
  'or',
  'not',
  'isTrue',
  'isFalse',
  'isNull',
  'isNotNull',
  'in',
]);

/**
 * Infers the output type of an expression from its structure.
 * Falls back to 'string' if the type cannot be determined.
 */
export function inferExpressionType(
  expr: StudioExpression,
  sourceFields: StudioDataField[],
  expressionFields: StudioExpressionField[],
): StudioDataField['type'] {
  return inferExpressionTypeInternal(expr, sourceFields, expressionFields, new Set(), 0);
}

function inferExpressionTypeInternal(
  expr: StudioExpression,
  sourceFields: StudioDataField[],
  expressionFields: StudioExpressionField[],
  /**
   * Cycle guard over the expression-FIELD reference graph, matching the guards every other
   * walker over the same graph already carries (`evaluateExpression`'s `resolvingFieldIds`,
   * `detectCycles`, `topoSortExpressionFields`). Without it, a persisted `a → b → a` pair —
   * which `deserializeState` accepts, since only the controller's add/update path runs
   * `hasExpressionCycle` — hard-crashes this function with a `RangeError` on the render path
   * (`StudioMapWidget`) and in the expression dialog.
   */
  seen: Set<string>,
  /** AST depth guard, see `MAX_EXPRESSION_DEPTH`. */
  depth: number,
): StudioDataField['type'] {
  if (depth > MAX_EXPRESSION_DEPTH) {
    return 'string';
  }

  if (isValueExpression(expr)) {
    if (expr.type === 'number') {
      return 'number';
    }
    if (expr.type === 'boolean') {
      return 'boolean';
    }
    return 'string';
  }

  if (isFieldExpression(expr)) {
    const physical = sourceFields.find((f) => f.id === expr.id);
    if (physical) {
      return physical.type;
    }
    if (seen.has(expr.id)) {
      return 'string';
    }
    const exprField = expressionFields.find((ef) => ef.id === expr.id);
    if (exprField) {
      if (exprField.type) {
        return exprField.type;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(expr.id);
      return inferExpressionTypeInternal(
        exprField.expression,
        sourceFields,
        expressionFields,
        nextSeen,
        depth + 1,
      );
    }
    return 'string';
  }

  if (isJoinFieldExpression(expr)) {
    // Type is unknown without schema info — default to string
    return 'string';
  }

  if (!isFunctionExpression(expr)) {
    // Malformed persisted node — same 'cannot be determined' fallback as everything else here.
    return 'string';
  }

  const { operator } = expr;
  const inputs = expressionInputs(expr);

  if (NUMERIC_OPERATORS.has(operator)) {
    return 'number';
  }
  if (BOOLEAN_OPERATORS.has(operator)) {
    return 'boolean';
  }
  // 'if' — infer from the then-branch
  if (operator === 'if' && inputs[1]) {
    return inferExpressionTypeInternal(inputs[1], sourceFields, expressionFields, seen, depth + 1);
  }

  return 'string';
}

// ─── Validation ───────────────────────────────────────────────────────────────

interface ExpressionValidationError {
  message: string;
  /** Expression path for nested errors, e.g. ['inputs', '0', 'inputs', '1'] */
  path?: string[];
}

/**
 * Validates an expression field definition.
 * Returns an array of errors. An empty array means the expression is valid.
 */
export function validateExpressionField(
  exprField: StudioExpressionField,
  allExpressionFields: StudioExpressionField[],
  sourceFields: StudioDataField[],
): ExpressionValidationError[] {
  const errors: ExpressionValidationError[] = [];

  if (!exprField.id) {
    errors.push({ message: 'Expression field must have an id.' });
  }
  if (!exprField.label) {
    errors.push({ message: 'Expression field must have a label.' });
  }
  if (!exprField.sourceId) {
    errors.push({ message: 'Expression field must have a sourceId.' });
  }

  const cycleErrors = detectCycles(exprField, allExpressionFields);
  errors.push(...cycleErrors);

  const exprErrors = validateExpression(
    exprField.expression,
    allExpressionFields,
    sourceFields,
    [],
    0,
  );
  errors.push(...exprErrors);

  return errors;
}

function validateExpression(
  expr: StudioExpression,
  expressionFields: StudioExpressionField[],
  sourceFields: StudioDataField[],
  path: string[],
  depth: number,
): ExpressionValidationError[] {
  const errors: ExpressionValidationError[] = [];

  // Depth bound (see `MAX_EXPRESSION_DEPTH`). Reported as a validation error rather than
  // silently truncated: this is the boundary where a hostile/corrupted persisted expression
  // should be rejected outright, and recursing further would overflow the stack.
  if (depth > MAX_EXPRESSION_DEPTH) {
    errors.push({
      message: `Expression is nested more than ${MAX_EXPRESSION_DEPTH} levels deep.`,
      path,
    });
    return errors;
  }

  if (isValueExpression(expr)) {
    return errors;
  }

  if (isFieldExpression(expr)) {
    const physical = sourceFields.find((f) => f.id === expr.id);
    const computed = expressionFields.find((ef) => ef.id === expr.id);
    if (!physical && !computed) {
      errors.push({
        message: `Field "${expr.id}" not found in source fields or expression fields.`,
        path,
      });
    }
    return errors;
  }

  if (isJoinFieldExpression(expr)) {
    // Join field expressions are structurally valid by construction
    return errors;
  }

  if (!isFunctionExpression(expr)) {
    errors.push({
      message:
        'Expression node is malformed: expected an operator node (with an `inputs` array), a ' +
        'literal value, a field reference, or a join-field reference.',
      path,
    });
    return errors;
  }

  const { operator } = expr;
  const inputs = expressionInputs(expr);

  // Validate arity
  const minArity: Partial<Record<StudioExpressionOperator, number>> = {
    add: 2,
    subtract: 2,
    multiply: 2,
    divide: 2,
    modulo: 2,
    negate: 1,
    equals: 2,
    notEqual: 2,
    lessThan: 2,
    greaterThan: 2,
    lessThanOrEqual: 2,
    greaterThanOrEqual: 2,
    not: 1,
    isTrue: 1,
    isFalse: 1,
    isNull: 1,
    isNotNull: 1,
    if: 2,
    in: 2,
    datediff: 3,
    and: 2,
    or: 2,
  };

  const required = minArity[operator] ?? 1;
  if (inputs.length < required) {
    errors.push({
      message: `Operator "${operator}" requires at least ${required} input(s), got ${inputs.length}.`,
      path,
    });
  }

  // Recurse into inputs
  for (let i = 0; i < inputs.length; i += 1) {
    const childErrors = validateExpression(
      inputs[i],
      expressionFields,
      sourceFields,
      [...path, 'inputs', String(i)],
      depth + 1,
    );
    errors.push(...childErrors);
  }

  return errors;
}

// ─── Cycle detection ──────────────────────────────────────────────────────────

/**
 * True when adding/updating `startField` would introduce a circular dependency
 * among `allFields` (which must already INCLUDE `startField` in its final,
 * post-mutation form). Exposed so the controller can enforce cycle-freedom at the
 * mutation boundary (`addExpressionField`/`updateExpressionField`), matching the
 * dialog's save-time `validateExpressionField` guard — a persisted doc or host/AI
 * call must not be able to introduce a cycle that later hard-crashes
 * `enrichRowsWithExpressions` with unbounded recursion.
 */
export function hasExpressionCycle(
  startField: StudioExpressionField,
  allFields: StudioExpressionField[],
): boolean {
  return detectCycles(startField, allFields).length > 0;
}

/**
 * Detects if the given expression field creates a cycle in the dependency graph
 * of expression fields.
 */
function detectCycles(
  startField: StudioExpressionField,
  allFields: StudioExpressionField[],
): ExpressionValidationError[] {
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(fieldId: string): boolean {
    if (stack.has(fieldId)) {
      return true; // cycle detected
    }
    if (visited.has(fieldId)) {
      return false;
    }
    visited.add(fieldId);
    stack.add(fieldId);

    const field = allFields.find((ef) => ef.id === fieldId);
    if (field) {
      const deps = collectFieldRefs(field.expression);
      for (const dep of deps) {
        if (allFields.some((ef) => ef.id === dep)) {
          if (dfs(dep)) {
            stack.delete(fieldId);
            return true;
          }
        }
      }
    }

    stack.delete(fieldId);
    return false;
  }

  if (dfs(startField.id)) {
    return [
      {
        message: `Expression field "${startField.id}" creates a circular dependency.`,
      },
    ];
  }
  return [];
}

/**
 * Collects all field IDs referenced in an expression tree.
 */
function collectFieldRefs(expr: StudioExpression): Set<string> {
  const refs = new Set<string>();

  function walk(node: StudioExpression, depth: number): void {
    // Depth bound (see `MAX_EXPRESSION_DEPTH`). This walker backs `detectCycles` and
    // `topoSortExpressionFields`, both of which run on the persisted-doc load path, so an
    // over-deep tree must not overflow the stack here either. Refs below the bound are
    // dropped; the tree is rejected by `validateExpression` for the same reason.
    if (depth > MAX_EXPRESSION_DEPTH) {
      return;
    }
    if (isFieldExpression(node)) {
      refs.add(node.id);
    } else if (isFunctionExpression(node)) {
      for (const input of node.inputs) {
        walk(input, depth + 1);
      }
    }
  }

  walk(expr, 0);
  return refs;
}

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Returns expression fields in evaluation order (dependencies before dependents).
 * Fields with no inter-dependencies come first.
 * If cycles exist, they are broken arbitrarily (cycle detection should be done
 * separately via validateExpressionField before calling this).
 */
export function topoSortExpressionFields(fields: StudioExpressionField[]): StudioExpressionField[] {
  const fieldIds = new Set(fields.map((f) => f.id));
  const fieldIndex = new Map(fields.map((f) => [f.id, f]));
  const visited = new Set<string>();
  const result: StudioExpressionField[] = [];

  function visit(field: StudioExpressionField, ancestors: Set<string>): void {
    if (visited.has(field.id)) {
      return;
    }
    if (ancestors.has(field.id)) {
      // Cycle — skip to avoid infinite recursion
      return;
    }
    const deps = collectFieldRefs(field.expression);
    const next = new Set(ancestors);
    next.add(field.id);
    for (const dep of deps) {
      if (fieldIds.has(dep)) {
        const depField = fieldIndex.get(dep);
        if (depField) {
          visit(depField, next);
        }
      }
    }
    visited.add(field.id);
    result.push(field);
  }

  for (const field of fields) {
    visit(field, new Set());
  }

  return result;
}
