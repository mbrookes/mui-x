/**
 * Security types for @mui/x-studio-data-middleware.
 *
 * This file is a thin compatibility facade. The types have been split by
 * concern into:
 *   - `./authTypes`     — auth/tenancy config (JwtSecurityClaims, SecurityColumns,
 *                         TenancyConfig, SecurityColumnsConfig)
 *   - `./queryTypes`    — query/read-path types (AggregationSpec, JoinDescriptor,
 *                         BatchWidgetDescriptor, HavingPredicate, FilterPredicate,
 *                         OrderBy, BatchQueryRequest, WidgetQueryResult,
 *                         BatchQueryResponse)
 *   - `./mutationTypes` — mutation/write-path types and both `Handle*Options`
 *                         (MutationDescriptor, MutationResult, BatchMutationRequest,
 *                         BatchMutationResponse, HandleMutationOptions,
 *                         HandleBatchQueryOptions)
 *
 * All existing import paths (`./security/types` / `../security/types`) continue
 * to resolve unchanged via these re-exports.
 */
export * from './authTypes';
export * from './queryTypes';
export * from './mutationTypes';
