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
 *   - Finding 2.1: a throwing tier-cache `get`/`set` degrades gracefully (falls
 *     back to the preflight COUNT(*)) instead of throwing out of
 *     `decideTierWithCache` and failing the widget.
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

/** A tier cache whose `get`/`set` both reject, simulating a down Redis backend. */
function makeThrowingTierCache(): TierCacheProvider {
  return {
    get: vi.fn(async () => {
      throw new Error('redis tier cache down');
    }),
    set: vi.fn(async () => {
      throw new Error('redis tier cache down');
    }),
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

// ─── decideTierWithCache — tier-cache hit re-derives tier from CURRENT
//     thresholds instead of trusting the cached tier verbatim (finding 2.4) ────
//
// `thresholds` is folded into neither the tier-cache key nor a digest, so a
// cache entry written under one set of thresholds (e.g. before a mid-rollout
// config change, or by a different node in a cluster running stale config)
// can be read back under DIFFERENT thresholds. The entry always persists the
// input `rowCount`, so a hit must re-map `rowCount` through the READER's
// current `thresholds` rather than trusting the stale `tier` field.

describe('decideTierWithCache — tier-cache hit re-derives tier from cached rowCount under current thresholds (finding 2.4)', () => {
  it('ignores a stale cached "client" tier and re-derives "server" when the current thresholds are tighter', async () => {
    // Cached when e.g. an old/other-node client threshold comfortably covered
    // 15_000 rows. The CURRENT thresholds (DEFAULT: client=10_000) do not.
    const tierCache = makeTierCache({ tier: 'client', rowCount: 15_000 });
    const getRowCount = makeGetRowCount(0);

    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
    );

    // Must be re-derived from rowCount under DEFAULT_THRESHOLDS, not the stale
    // cached 'client'.
    expect(result).toEqual({ tier: 'server', rowCount: 15_000, source: 'tier-cache' });
    expect(getRowCount).not.toHaveBeenCalled();
  });

  it('ignores a stale cached "db" tier and re-derives "client" when the current thresholds have widened', async () => {
    // Cached under tight thresholds where 50 rows exceeded the server tier.
    const tierCache = makeTierCache({ tier: 'db', rowCount: 50 });
    const getRowCount = makeGetRowCount(0);

    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      { client: 100, server: 200 }, // reader's current thresholds now cover 50 rows
    );

    expect(result).toEqual({ tier: 'client', rowCount: 50, source: 'tier-cache' });
    expect(getRowCount).not.toHaveBeenCalled();
  });

  it('still returns the cached tier unmodified when the current thresholds agree with how it was cached', async () => {
    // Sanity check: re-derivation must be a no-op when thresholds haven't
    // changed — the fix must not perturb the already-passing hit-path tests.
    const tierCache = makeTierCache({ tier: 'server', rowCount: 55_000 });
    const result = await decideTierWithCache(
      false,
      'key',
      makeGetRowCount(0),
      tierCache,
      DEFAULT_THRESHOLDS,
    );
    expect(result).toEqual({ tier: 'server', rowCount: 55_000, source: 'tier-cache' });
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

// ─── decideTierWithCache — tier-cache failure isolation (finding 2.1) ─────────
//
// Before the fix, a throwing `tierCacheProvider.get`/`.set` propagated straight
// out of `decideTierWithCache`, converted by `processWidget`'s outer catch-all
// into a per-widget error result (`{ rows: [], tier: 'db', rowCount: 0, error }`)
// — a total failure for every non-aggregation widget even though the DB itself
// was healthy and the preflight could have run. This mirrors the data cache's
// existing `get`/`set` guards in `handler.ts` (finding 2.6): a throwing `get` is
// treated as a cache miss (fall through to the preflight), and a throwing `set`
// is a logged warning that does not discard the already-computed decision.

describe('decideTierWithCache — tier-cache failure isolation (finding 2.1)', () => {
  it('degrades a throwing tierCacheProvider.get to a cache miss and still returns a tier via the preflight', async () => {
    const tierCache = makeThrowingTierCache();
    const getRowCount = makeGetRowCount(8_000);

    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
    );

    // The throw from `.get` did not propagate — the preflight ran and a valid
    // tier decision (not an error) came back.
    expect(result.tier).toBe('client');
    expect(result.rowCount).toBe(8_000);
    expect(result.source).toBe('preflight');
    expect(getRowCount).toHaveBeenCalledTimes(1);
  });

  it('degrades a throwing tierCacheProvider.set to a logged warning without discarding the computed decision', async () => {
    const tierCache = makeThrowingTierCache();
    const getRowCount = makeGetRowCount(200_000);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await decideTierWithCache(
        false,
        'key',
        getRowCount,
        tierCache,
        DEFAULT_THRESHOLDS,
        30_000, // TTL supplied so `.set` is attempted
      );

      // The `.set` throw did not propagate and did not discard the decision
      // already computed from the preflight.
      expect(result).toEqual({ tier: 'db', rowCount: 200_000, source: 'preflight' });
      expect(tierCache.set).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never throws out of decideTierWithCache when both get and set fail', async () => {
    const tierCache = makeThrowingTierCache();
    const getRowCount = makeGetRowCount(50);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        decideTierWithCache(false, 'key', getRowCount, tierCache, DEFAULT_THRESHOLDS, 30_000),
      ).resolves.toEqual({ tier: 'client', rowCount: 50, source: 'preflight' });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─── Malformed tier-cache entries are treated as a MISS (finding L5) ──────────
//
// Sibling of the data-cache shape guard in `handler.ts`. A `TierCacheProvider` is
// host-pluggable and its store is not exclusively ours — a Redis key collision, a
// partially-written value, or a buggy custom provider all yield a truthy entry
// whose `rowCount` is not a number. `tierFromRowCount`'s comparisons against
// `undefined`/`NaN` are all false, so such an entry silently routed EVERY
// affected widget to the 'db' tier and reported a nonsense `rowCount` to the
// client — from data the database never produced.
describe('decideTierWithCache — malformed tier-cache entry falls back to the preflight (finding L5)', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['a foreign JSON value from a colliding key', { hello: 'world' }],
    ['an entry with no rowCount', { tier: 'client' }],
    ['an entry whose rowCount is a string', { tier: 'client', rowCount: '42' }],
    ['an entry whose rowCount is NaN', { tier: 'client', rowCount: Number.NaN }],
    ['an entry whose rowCount is null', { tier: 'client', rowCount: null }],
  ];

  it.each(MALFORMED)('re-runs the COUNT(*) for %s', async (_label, entry) => {
    const tierCache = makeTierCache(entry as TierEntry);
    const getRowCount = makeGetRowCount(50);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await decideTierWithCache(
        false,
        'key',
        getRowCount,
        tierCache,
        DEFAULT_THRESHOLDS,
      );
      // The authoritative preflight ran and produced the decision — the malformed
      // entry was never trusted.
      expect(getRowCount).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ tier: 'client', rowCount: 50, source: 'preflight' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/malformed tier-cache entry/));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still trusts a WELL-FORMED entry (including rowCount: 0)', async () => {
    const tierCache = makeTierCache({ tier: 'client', rowCount: 0 });
    const getRowCount = makeGetRowCount(999);
    const result = await decideTierWithCache(
      false,
      'key',
      getRowCount,
      tierCache,
      DEFAULT_THRESHOLDS,
    );
    // `0` is a legitimate count and must not be mistaken for a malformed entry.
    expect(getRowCount).not.toHaveBeenCalled();
    expect(result).toEqual({ tier: 'client', rowCount: 0, source: 'tier-cache' });
  });
});
