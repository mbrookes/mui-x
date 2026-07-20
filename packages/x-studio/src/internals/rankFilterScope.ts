/**
 * Rank-filter-per-page-scope helpers.
 *
 * These used to be hand-maintained here as a byte-for-byte duplicate of the
 * SAME logic in `@mui/x-studio-schema`'s `applyMutation.ts` (the reducer needs
 * its own copy — the dependency arrow runs `x-studio` → `x-studio-schema`,
 * never the reverse, so the schema package cannot import this client copy).
 * `@mui/x-studio-schema` is already a dependency of this package (see
 * `package.json`), so the client re-exports the schema package's copy instead
 * of maintaining a second hand-synced implementation that can silently drift
 * from the reducer's actual semantics.
 */
export { resolveRankFilterPageId, hasConflictingRankFilter } from '@mui/x-studio-schema';
