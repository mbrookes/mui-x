/**
 * @mui/x-studio-server — public exports
 *
 * Framework-agnostic server middleware for MUI X Studio.
 *
 * Usage (Express example):
 *   import { handleBatchQuery, extractSecurityClaims } from '@mui/x-studio-server';
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
  HandleBatchQueryOptions,
} from './security/types';

// ─── Security utilities ────────────────────────────────────────────────────────
export { extractSecurityClaims } from './security/extractSecurityClaims';
export { generateCacheKey } from './security/cacheKey';

// ─── Cache providers ──────────────────────────────────────────────────────────
export type { CacheProvider, CacheEntry } from './cache/types';
export { LRUCacheProvider } from './cache/LRUCacheProvider';

// ─── Main handler ─────────────────────────────────────────────────────────────
export { handleBatchQuery } from './handler';
