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

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isFunctionExpression(expr: StudioExpression): expr is StudioFunctionExpression {
  return 'operator' in expr;
}

export function isValueExpression(expr: StudioExpression): expr is StudioValueExpression {
  return 'type' in expr && 'value' in expr;
}

export function isFieldExpression(expr: StudioExpression): expr is StudioFieldExpression {
  return 'id' in expr && !('operator' in expr) && !('type' in expr && 'value' in expr);
}

export function isJoinFieldExpression(expr: StudioExpression): expr is StudioJoinFieldExpression {
  return 'joinSourceId' in expr && 'fieldId' in expr;
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
  return Boolean(v);
}

function toDateString(v: unknown): string {
  return String(v ?? '');
}

/**
 * Evaluates a single expression node against a row context.
 * Returns a scalar value (number, string, boolean, null).
 */
export function evaluateExpression(
  expr: StudioExpression,
  context: EvaluationContext,
): ScalarValue {
  if (isValueExpression(expr)) {
    return expr.value as ScalarValue;
  }

  if (isJoinFieldExpression(expr)) {
    const { joinSourceId, fieldId } = expr;
    const { row, sourceId, dataSources, relationships } = context;
    if (!dataSources || !relationships || !sourceId) {
      return null;
    }
    const rel = relationships.find(
      (r) => r.sourceId === sourceId && r.targetId === joinSourceId,
    );
    if (!rel) {
      return null;
    }
    const fkValue = row[rel.sourceField];
    if (fkValue == null) {
      return null;
    }
    const relatedSource = dataSources[joinSourceId];
    const relatedRow = relatedSource?.rows?.find((r) => r[rel.targetField] === fkValue);
    return (relatedRow?.[fieldId] ?? null) as ScalarValue;
  }

  if (isFieldExpression(expr)) {
    const val = context.row[expr.id];
    if (val !== undefined) {
      return val as ScalarValue;
    }
    // Try evaluating a referenced expression field (calculated column only)
    const exprField = context.expressionFields.find(
      (ef) => ef.id === expr.id && !ef.isMeasure,
    );
    if (exprField) {
      return evaluateExpression(exprField.expression, context);
    }
    return null;
  }

  // Function expression
  return evaluateFunctionExpression(expr, context);
}

function evaluateFunctionExpression(
  expr: StudioFunctionExpression,
  context: EvaluationContext,
): ScalarValue {
  const { operator, inputs } = expr;

  const evalInput = (index: number): ScalarValue =>
    inputs[index] !== undefined ? evaluateExpression(inputs[index], context) : null;

  switch (operator) {
    // ── Arithmetic ──────────────────────────────────────────────────────────
    case 'add':
      return inputs.reduce((acc, inp) => acc + toNumber(evaluateExpression(inp, context)), 0);
    case 'subtract': {
      if (inputs.length === 0) {
        return 0;
      }
      const [first, ...rest] = inputs;
      return rest.reduce(
        (acc, inp) => acc - toNumber(evaluateExpression(inp, context)),
        toNumber(evaluateExpression(first, context)),
      );
    }
    case 'multiply':
      return inputs.reduce((acc, inp) => acc * toNumber(evaluateExpression(inp, context)), 1);
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
    case 'lessThan':
      return toNumber(evalInput(0)) < toNumber(evalInput(1));
    case 'greaterThan':
      return toNumber(evalInput(0)) > toNumber(evalInput(1));
    case 'lessThanOrEqual':
      return toNumber(evalInput(0)) <= toNumber(evalInput(1));
    case 'greaterThanOrEqual':
      return toNumber(evalInput(0)) >= toNumber(evalInput(1));

    // ── Logical ─────────────────────────────────────────────────────────────
    case 'and':
      return inputs.every((inp) => toBoolean(evaluateExpression(inp, context)));
    case 'or':
      return inputs.some((inp) => toBoolean(evaluateExpression(inp, context)));
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
      return toBoolean(evalInput(0)) ? evalInput(1) : evalInput(2) ?? null;

    case 'in': {
      // inputs[0] = value, inputs[1..n] = candidates
      const target = evalInput(0);
      return inputs
        .slice(1)
        // eslint-disable-next-line eqeqeq
        .some((inp) => target == evaluateExpression(inp, context));
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
  const columnFields = expressionFields.filter(
    (ef) => ef.sourceId === sourceId && !ef.isMeasure,
  );

  if (columnFields.length === 0) {
    return rows;
  }

  // Topologically sort expression fields so that fields that reference other
  // expression fields are computed after their dependencies.
  const sorted = topoSortExpressionFields(columnFields);

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
 * Returns a single aggregate value.
 */
export function evaluateMeasure(
  exprField: StudioExpressionField,
  rows: Record<string, unknown>[],
  expressionFields: StudioExpressionField[],
): number {
  if (!exprField.isMeasure) {
    return 0;
  }
  return evalMeasureExpression(exprField.expression, rows, expressionFields);
}

function evalMeasureExpression(
  expr: StudioExpression,
  rows: Record<string, unknown>[],
  expressionFields: StudioExpressionField[],
): number {
  if (isValueExpression(expr)) {
    return toNumber(expr.value);
  }

  if (isFieldExpression(expr)) {
    const { aggregation = 'sum' } = expr;
    const values = rows.map((r) => toNumber(r[expr.id])).filter((v) => !Number.isNaN(v));
    return aggregate(values, aggregation);
  }

  if (isJoinFieldExpression(expr)) {
    // Join field expressions yield string values — treat as 0 in numeric measure context
    return 0;
  }

  // FunctionExpression — recursively evaluate each input as a measure scalar,
  // then apply the operator to those scalars.
  const { operator, inputs } = expr;
  const evalIn = (i: number): number =>
    inputs[i] !== undefined ? evalMeasureExpression(inputs[i], rows, expressionFields) : 0;

  switch (operator as StudioExpressionOperator) {
    case 'add':
      return inputs.reduce((acc, inp) => acc + evalMeasureExpression(inp, rows, expressionFields), 0);
    case 'subtract': {
      if (inputs.length === 0) {
        return 0;
      }
      const [first, ...rest] = inputs;
      return rest.reduce(
        (acc, inp) => acc - evalMeasureExpression(inp, rows, expressionFields),
        evalMeasureExpression(first, rows, expressionFields),
      );
    }
    case 'multiply':
      return inputs.reduce(
        (acc, inp) => acc * evalMeasureExpression(inp, rows, expressionFields),
        1,
      );
    case 'divide': {
      const n = evalIn(0);
      const d = evalIn(1);
      return d === 0 ? 0 : n / d;
    }
    case 'modulo': {
      const d = evalIn(1);
      return d === 0 ? 0 : evalIn(0) % d;
    }
    case 'negate':
      return -evalIn(0);
    default:
      return 0;
  }
}

function aggregate(values: number[], aggregation: StudioKpiAggregation): number {
  if (values.length === 0) {
    return 0;
  }
  switch (aggregation) {
    case 'sum':
      return values.reduce((a, v) => a + v, 0);
    case 'avg':
      return values.reduce((a, v) => a + v, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'count':
      return values.length;
    default:
      return values.reduce((a, v) => a + v, 0);
  }
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
    const exprField = expressionFields.find((ef) => ef.id === expr.id);
    if (exprField) {
      return exprField.type ?? inferExpressionType(exprField.expression, sourceFields, expressionFields);
    }
    return 'string';
  }

  if (isJoinFieldExpression(expr)) {
    // Type is unknown without schema info — default to string
    return 'string';
  }

  const { operator } = expr as StudioFunctionExpression;

  if (NUMERIC_OPERATORS.has(operator)) {
    return 'number';
  }
  if (BOOLEAN_OPERATORS.has(operator)) {
    return 'boolean';
  }
  // 'if' — infer from the then-branch
  if (operator === 'if' && expr.inputs[1]) {
    return inferExpressionType(expr.inputs[1], sourceFields, expressionFields);
  }

  return 'string';
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ExpressionValidationError {
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

  const exprErrors = validateExpression(exprField.expression, allExpressionFields, sourceFields, []);
  errors.push(...exprErrors);

  return errors;
}

function validateExpression(
  expr: StudioExpression,
  expressionFields: StudioExpressionField[],
  sourceFields: StudioDataField[],
  path: string[],
): ExpressionValidationError[] {
  const errors: ExpressionValidationError[] = [];

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

  const { operator, inputs } = expr as StudioFunctionExpression;

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
    const childErrors = validateExpression(inputs[i], expressionFields, sourceFields, [
      ...path,
      'inputs',
      String(i),
    ]);
    errors.push(...childErrors);
  }

  return errors;
}

// ─── Cycle detection ──────────────────────────────────────────────────────────

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

  function walk(node: StudioExpression): void {
    if (isFieldExpression(node)) {
      refs.add(node.id);
    } else if (isFunctionExpression(node)) {
      for (const input of node.inputs) {
        walk(input);
      }
    }
  }

  walk(expr);
  return refs;
}

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Returns expression fields in evaluation order (dependencies before dependents).
 * Fields with no inter-dependencies come first.
 * If cycles exist, they are broken arbitrarily (cycle detection should be done
 * separately via validateExpressionField before calling this).
 */
export function topoSortExpressionFields(
  fields: StudioExpressionField[],
): StudioExpressionField[] {
  const fieldIds = new Set(fields.map((f) => f.id));
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
        const depField = fields.find((f) => f.id === dep);
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
