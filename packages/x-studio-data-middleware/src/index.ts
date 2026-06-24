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
  OrderBy,
  AggregationSpec,
  JoinDescriptor,
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
