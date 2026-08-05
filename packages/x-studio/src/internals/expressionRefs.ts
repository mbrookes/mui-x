import type { StudioExpression } from '../models';
import {
  isFieldExpression,
  isFunctionExpression,
  isJoinFieldExpression,
} from '../utils/expressionEvaluator';

/**
 * Walks a StudioExpression tree and collects all field IDs it references.
 *
 * JoinFieldExpression and ValueExpression contribute no refs: a join-field expression
 * resolves to a native column on a *different* source (not an expression-field ref on
 * this one), and a value expression references no column at all.
 */
export function collectExpressionRefs(expr: StudioExpression): string[] {
  const refs: string[] = [];
  const walk = (node: StudioExpression): void => {
    if (isFieldExpression(node)) {
      refs.push(node.id);
    } else if (isFunctionExpression(node)) {
      node.inputs.forEach(walk);
    }
    // JoinFieldExpression / ValueExpression reference no native column on this source.
  };
  walk(expr);
  return refs;
}

/**
 * Walks the FULL expression tree and collects every foreign `joinSourceId` a
 * `JoinFieldExpression` node references — including nested ones, e.g. the
 * `customers` join inside `if(customers.country == 'US', 1, 0)`.
 *
 * Checking only the top-level node (the previous behaviour) missed a join nested
 * inside a `FunctionExpression`, so the joined foreign source's rows were not tracked
 * as a dependency (stale cache) and the evaluator fell back to a slow per-row
 * linear scan.
 */
export function collectJoinSourceIds(expr: StudioExpression): string[] {
  const ids: string[] = [];
  const walk = (node: StudioExpression): void => {
    if (isJoinFieldExpression(node)) {
      ids.push(node.joinSourceId);
    } else if (isFunctionExpression(node)) {
      node.inputs.forEach(walk);
    }
    // FieldExpression / ValueExpression reference no foreign join source.
  };
  walk(expr);
  return ids;
}
