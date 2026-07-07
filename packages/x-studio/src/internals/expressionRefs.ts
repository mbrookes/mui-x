import type { StudioExpression } from '../models';
import { isFieldExpression, isFunctionExpression } from '../utils/expressionEvaluator';

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
