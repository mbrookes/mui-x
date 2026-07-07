import type { StudioNumberFormat, StudioKpiAggregation } from './baseTypes';
import type { StudioDataField } from './dataTypes';

// ─── Expression field types ───────────────────────────────────────────────────

export type StudioExpressionOperator =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'equals'
  | 'notEqual'
  | 'lessThan'
  | 'greaterThan'
  | 'lessThanOrEqual'
  | 'greaterThanOrEqual'
  | 'and'
  | 'or'
  | 'not'
  | 'negate'
  | 'if'
  | 'in'
  | 'isTrue'
  | 'isFalse'
  | 'isNull'
  | 'isNotNull'
  | 'datediff';

/** A function/operator node with one or more input sub-expressions. */
export interface StudioFunctionExpression {
  operator: StudioExpressionOperator;
  inputs: StudioExpression[];
}

/** A literal constant value. */
export interface StudioValueExpression {
  type: 'number' | 'string' | 'boolean';
  value: string | number | boolean | null;
}

/** A reference to a physical or expression field, with optional aggregation. */
export interface StudioFieldExpression {
  id: string;
  /** Aggregation to apply when this field is used as a measure input. */
  aggregation?: StudioKpiAggregation;
}

/**
 * A reference to a field on a related (joined) record, resolved at evaluation
 * time via the declared source relationships.
 *
 * Example: pull `country` from the customers source for each order row.
 */
export interface StudioJoinFieldExpression {
  joinSourceId: string;
  fieldId: string;
}

export type StudioExpression =
  | StudioFunctionExpression
  | StudioValueExpression
  | StudioFieldExpression
  | StudioJoinFieldExpression;

/** A user-defined computed field derived from an expression tree. */
export interface StudioExpressionField {
  id: string;
  label: string;
  description?: string;
  /** The data source this expression field computes over. */
  sourceId: string;
  /**
   * When true, this is a Measure: a single aggregate value over the full (filtered) dataset.
   * When false (default), this is a Calculated Column: a per-row scalar value.
   */
  isMeasure: boolean;
  expression: StudioExpression;
  /**
   * Output type override. Inferred from the expression tree if omitted.
   * Arithmetic operators infer 'number'; comparison/logical infer 'boolean'.
   */
  type?: StudioDataField['type'];
  /** Display format for numeric expression fields. */
  format?: StudioNumberFormat;
  /** Decimal places used when formatting numeric expression fields. */
  precision?: number;
  /** ISO 4217 currency code for currency format. Defaults to 'USD'. */
  currencyCode?: string;
  /** When true, the expression field is hidden from pickers. */
  hidden?: boolean;
}
