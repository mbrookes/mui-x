/**
 * @mui/x-studio-data-middleware — public exports
 *
 * Framework-agnostic server middleware for MUI X Studio.
 *
 * Usage (Express example):
 *   import { handleBatchQuery, extractSecurityClaims } from '@mui/x-studio-data-middleware';
 *
 *   app.post('/api/studio-data', async (req, res) => {
 *     const claims = await extractSecurityClaims(req.headers.authorization);
 *     const result = await handleBatchQuery(req.body, claims, { db, schemaAllowlist });
 *     res.json(result);
 *   });
 */

// ─── Security types ───────────────────────────────────────────────────────────
export type {
  JwtSecurityClaims,
  BatchQueryRequest,
  BatchQueryResponse,
  BatchWidgetDescriptor,
  WidgetQueryResult,
  FilterPredicate,
  HavingPredicate,
  OrderBy,
  AggregationSpec,
  JoinDescriptor,
  SemiJoinDescriptor,
  SecurityColumns,
  SecurityColumnOverride,
  SecurityColumnsConfig,
  TenancyConfig,
  HandleBatchQueryOptions,
  // Mutation types
  MutationDescriptor,
  MutationResult,
  BatchMutationRequest,
  BatchMutationResponse,
  HandleMutationOptions,
} from './security/types';

// ─── Security utilities ────────────────────────────────────────────────────────
export { extractSecurityClaims } from './security/extractSecurityClaims';
export { generateCacheKey } from './security/cacheKey';

// ─── Cache providers ──────────────────────────────────────────────────────────
export type { CacheProvider, CacheEntry, TierCacheProvider, TierEntry } from './cache/types';
export { LRUCacheProvider } from './cache/LRUCacheProvider';
export { MapTierCacheProvider } from './cache/MapTierCacheProvider';
export { RedisCacheProvider } from './cache/RedisCacheProvider';
export type { RedisClient, RedisCacheProviderOptions } from './cache/RedisCacheProvider';
export { RedisTierCacheProvider } from './cache/RedisTierCacheProvider';
export type { RedisTierCacheProviderOptions } from './cache/RedisTierCacheProvider';

// ─── Main handlers ────────────────────────────────────────────────────────────
export { handleBatchQuery } from './handler';
export { handleMutation } from './mutations/handleMutation';

// ─── Query bounds ─────────────────────────────────────────────────────────────
/**
 * Default value of `queryTimeoutMs` on both handler option shapes (F2). Exported
 * so a host can log or reason about the bound it is running under without
 * hard-coding the number.
 */
export { DEFAULT_QUERY_TIMEOUT_MS } from './shared/queryTimeout';
/**
 * Batch-size ceilings, exported so a host that assembles batches itself can chunk
 * against the real bound instead of hard-coding 50 and discovering the mismatch as a
 * whole-batch rejection: `handleBatchQuery`/`handleMutation` reject an over-cap request
 * outright — before their per-item loops — so it surfaces as one un-attributed error
 * for every item in the batch, not as per-item results.
 *
 * These are the CANONICAL values. `@mui/x-studio`'s own `MAX_BATCH_WIDGETS_PER_REQUEST`
 * is a deliberate copy rather than an import of this symbol, because that package must
 * stay free of a dependency on this Node-only, Knex-peered server package; the two are
 * pinned equal by the seam tests named on `MAX_WIDGETS_PER_BATCH`.
 */
export { MAX_WIDGETS_PER_BATCH } from './handler';
export { MAX_MUTATIONS_PER_BATCH } from './mutations/handleMutation';
