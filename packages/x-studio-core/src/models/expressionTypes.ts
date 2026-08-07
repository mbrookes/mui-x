// Moved to `@mui/x-studio-schema`. Re-exported here — scoped to just the names
// that live in the schema package's own `expressionTypes.ts` module — so
// existing deep imports (`../models/expressionTypes`) keep working without
// surfacing the entire schema package.
export type {
  StudioExpressionOperator,
  StudioFunctionExpression,
  StudioValueExpression,
  StudioFieldExpression,
  StudioJoinFieldExpression,
  StudioExpression,
  StudioExpressionField,
} from '@mui/x-studio-schema';
