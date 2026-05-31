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
  /** ISO 4217 currency code for currency format. Defaults to 'USD'. */
  currencyCode?: string;
  /** When true, the expression field is hidden from pickers. */
  hidden?: boolean;
}

export interface StudioRelationship {
  id: string;
  /**
   * For `many-to-one` / `one-to-one`: the "many" (or first) side source ID (e.g. `order_items`).
   * For `many-to-many`: one of the two endpoint source IDs (e.g. `products`).
   */
  sourceId: string;
  /**
   * For `many-to-one` / `one-to-one`: FK field in `sourceId` joining to `targetId`.
   * For `many-to-many`: PK/FK field in `sourceId` that the junction table references
   * (e.g. `id` on products, matched by `junctionSourceField`).
   */
  sourceField: string;
  /**
   * For `many-to-one` / `one-to-one`: the "one" side source ID (e.g. `customers`).
   * For `many-to-many`: the other endpoint source ID (e.g. `orders`).
   */
  targetId: string;
  /**
   * For `many-to-one` / `one-to-one`: PK field in `targetId`.
   * For `many-to-many`: PK/FK field in `targetId` that the junction table references
   * (e.g. `id` on orders, matched by `junctionTargetField`).
   */
  targetField: string;
  type: 'many-to-one' | 'one-to-one' | 'many-to-many';
  /**
   * **Required when `type === 'many-to-many'`.**
   * The ID of the junction (bridge) `StudioDataSource` (e.g. `order_items`).
   */
  junctionSourceId?: string;
  /**
   * **Required when `type === 'many-to-many'`.**
   * The field in the junction source that references `sourceId.sourceField`
   * (e.g. `product_id` on `order_items`).
   */
  junctionSourceField?: string;
  /**
   * **Required when `type === 'many-to-many'`.**
   * The field in the junction source that references `targetId.targetField`
   * (e.g. `order_id` on `order_items`).
   */
  junctionTargetField?: string;
  /**
   * When `true`, this relationship is defined by the data layer (not the user) and
   * should be displayed read-only — the Edit and Delete controls are hidden.
   */
  predefined?: boolean;
}

/**
 * Preset options for the dashboard-level date range bar.
 * - `'this_month'` — first day of the current month through today
 * - `'last_3_months'` — three months ago through today
 * - `'last_12_months'` — twelve months ago through today
 * - `'ytd'` — January 1 of the current year through today
 * - `'custom'` — user-supplied start/end dates
 */
