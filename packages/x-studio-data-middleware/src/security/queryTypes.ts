/**
 * The batch-query wire protocol moved to `@mui/x-studio-schema`'s `dataWireTypes.ts` — it has two
 * implementers (this package validates the payloads, `@mui/x-studio`'s `createBatchingAdapter`
 * builds them) and neither may depend on the other, so the one place both can share it is the
 * zero-dependency schema package they already both depend on.
 *
 * Re-exported from this path so the modules that already import it here are unaffected. Types
 * that are genuinely THIS package's own — `CompiledSecurityPolicy`, `ValidatedQueryPlan`, the
 * mutation types — stay in their own modules and are not re-exported here.
 */
export type {
  AggregationSpec,
  JoinDescriptor,
  SemiJoinDescriptor,
  BatchWidgetDescriptor,
  HavingPredicate,
  FilterPredicate,
  OrderBy,
  BatchQueryRequest,
  WidgetQueryResult,
  BatchQueryResponse,
} from '@mui/x-studio-schema';
