/**
 * Unit tests for `decideTierWithCache`.
 *
 * Covers:
 *   - Aggregation descriptor → forced db tier, no I/O side-effects
 *   - Cache bypass for aggregation: tierCache.get must NOT be called
 *   - Threshold boundary routing for non-aggregation queries
 *   - Custom thresholds
 *   - Tier-cache hit → cache source, no COUNT(*) call
 *   - Tier-cache populated after a preflight miss (when a TTL is given)
 *   - Omitting `tierCacheTtlMs` computes/reads the decision but never writes it back
 *     (decide-without-cache-write mode — this replaces the old standalone `decideTier`)
 */
import { describe, it, expect, vi } from 'vitest';
import { decideTierWithCache, DEFAULT_THRESHOLDS } from '../tierDecision';
import type { TierCacheProvider, TierEntry } from '../../cache/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRowCount(n: number) {
  return vi.fn(async () => n);
}

function makeTierCache(hit?: TierEntry): TierCacheProvider {
  return {
    get: vi.fn(async () => hit),
    set: vi.fn(async () => {}),
    invalidatePrefix: vi.fn(async () => {}),
  };
}

// ─── decideTierWithCache — aggregation short-circuit ──────────────────────────

describe('decideTierWithCache — aggregation forced to db tier', () => {
  it('returns db / aggregation-forced immediately', async () => {
    const getRowCount = makeGetRowCount(0);
    const result = await decideTierWithCache(
      true,
      'key',
      getRowCount,
      undefined,
      DEFAULT_THRESHOLDS,
    );
    expect(result).toEqual({ tier: 'db', rowCount: 0, source: 'aggregation-forced' });
  });

  it('does not call getPreflightRowCount for aggregation queries', async () => {
    const getRowCount = makeGetRowCount(500);
    await decideTierWithCache(true, 'key', getRowCount, undefined, DEFAULT_THRESHOLDS);
    expect(getRowCount).not.toHaveBeenCalled();
  });

  it('does not call tierCache.get for aggregation queries', async () => {
    const tierCache = makeTierCache({ tier: 'client', rowCount: 100 });
    const getRowCount = makeGetRowCount(0);
    await decideTierWithCache(true, 'key', getRowCount, tierCache, DEFAULT_THRESHOLDS);
    expect(tierCache.get).not.toHaveBeenCalled();
  });
});

// ─── decideTierWithCache — non-aggregation threshold routing ──────────────────

describe('decideTierWithCache — default thresholds (client 10k, server 100k)', () => {
  it.each([
    [0, 'client'],
    [10_000, 'client'], // boundary inclusive
    [10_001, 'server'],
    [100_000, 'server'], // boundary inclusive
    [100_001, 'db'],
    [5_000_000, 'db'],
  ] as const)('routes %i rows to "%s" tier', async (rowCount, expectedTier) => {
    const result = await decideTierWithCache(
      false,
      'key',
      makeGetRowCount(rowCount),
      undefined,
      DEFAULT_THRESHOLDS,
    );
    expect(result.tier).toBe(expectedTier);
    expect(result.rowCount).toBe(rowCount);
    expect(result.source).toBe('preflight');
  });
});

describe('decideTierWithCache — custom thresholds', () => {
  const thresholds = { client: 5, server: 10 };

  it.each([
    [5, 'client'],
    [6, 'server'],
    [10, 'server'],
    [11, 'db'],
  ] as const)('routes %i rows to "%s" with custom thresholds', async (rowCount, expectedTier) => {
    const result = await decideTierWithCache(
      false,
      'key',
      makeGetRowCount(rowCount),
      undefined,
      thresholds,
    );
    expect(result.tier).toBe(expectedTier);
  });
});

// ─── decideTierWithCache — tier-cache interaction ─────────────────────────────

describe('decideTierWithCache — tier-cache hit', () => {
  it('returns the cached tier without calling getPreflightRowCount', async () => {
    const tierCache = makeTierCache({ tier: 'server', rowCount: 55_000 });
    const getRowCount = makeGetRowCount(0);

    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
    );

    expect(result).toEqual({ tier: 'server', rowCount: 55_000, source: 'tier-cache' });
    expect(getRowCount).not.toHaveBeenCalled();
  });

  it('returns the correct tier when the cache says "db"', async () => {
    const tierCache = makeTierCache({ tier: 'db', rowCount: 200_000 });
    const result = await decideTierWithCache(
      false,
      'key',
      makeGetRowCount(0),
      tierCache,
      DEFAULT_THRESHOLDS,
    );
    expect(result).toEqual({ tier: 'db', rowCount: 200_000, source: 'tier-cache' });
  });
});

// ─── decideTierWithCache — omitted tierCacheTtlMs never writes back ───────────
// This is the behavior that used to live in the standalone `decideTier` helper
// (now removed as dead code): the decision is still computed/read, but nothing
// is persisted to the tier cache when no TTL is supplied.

describe('decideTierWithCache — omitted tierCacheTtlMs (decide-without-cache-write)', () => {
  it('does not write to the tier cache after a preflight miss when tierCacheTtlMs is omitted', async () => {
    const tierCache = makeTierCache(undefined); // cache miss
    const getRowCount = makeGetRowCount(8_000);

    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
    );

    expect(result.tier).toBe('client');
    expect(result.source).toBe('preflight');
    expect(tierCache.set).not.toHaveBeenCalled();
  });

  it('still reads a tier-cache hit even when tierCacheTtlMs is omitted', async () => {
    const tierCache = makeTierCache({ tier: 'server', rowCount: 55_000 });
    const getRowCount = makeGetRowCount(0);

    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
    );

    expect(result).toEqual({ tier: 'server', rowCount: 55_000, source: 'tier-cache' });
    expect(getRowCount).not.toHaveBeenCalled();
    expect(tierCache.set).not.toHaveBeenCalled();
  });
});

// ─── decideTierWithCache — writes tier cache after preflight ─────────────────

describe('decideTierWithCache — tier-cache population', () => {
  it('writes the tier result to the cache after a preflight miss', async () => {
    const tierCache = makeTierCache(undefined); // cache miss
    const getRowCount = makeGetRowCount(8_000);

    const result = await decideTierWithCache(
      false,
      'my-cache-key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
      30_000,
    );

    expect(result.tier).toBe('client');
    expect(result.source).toBe('preflight');
    expect(tierCache.set).toHaveBeenCalledExactlyOnceWith(
      'my-cache-key',
      { tier: 'client', rowCount: 8_000 },
      30_000,
    );
  });

  it('does NOT write the cache for aggregation queries', async () => {
    const tierCache = makeTierCache(undefined);
    const getRowCount = makeGetRowCount(0);

    await decideTierWithCache(true, 'key', getRowCount, tierCache, DEFAULT_THRESHOLDS, 30_000);

    expect(tierCache.set).not.toHaveBeenCalled();
    expect(tierCache.get).not.toHaveBeenCalled();
  });

  it('does NOT call getPreflightRowCount when tier cache hits', async () => {
    const tierCache = makeTierCache({ tier: 'db', rowCount: 999_999 });
    const getRowCount = makeGetRowCount(0);

    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
      30_000,
    );

    expect(getRowCount).not.toHaveBeenCalled();
    expect(tierCache.set).not.toHaveBeenCalled();
    expect(result.source).toBe('tier-cache');
  });
});
