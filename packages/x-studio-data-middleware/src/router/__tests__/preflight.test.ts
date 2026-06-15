/**
 * Unit tests for `runPreflight` tier routing.
 *
 * The preflight COUNT(*) drives the client/server/db routing decision. The
 * integration tests in `handler.test.ts` only observe routing indirectly via
 * the tier cache; these tests pin down the threshold boundaries, custom
 * threshold overrides, and row-count coercion directly.
 */
import { describe, it, expect } from 'vitest';
import { runPreflight } from '../preflight';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../../security/types';

const CLAIMS: JwtSecurityClaims = { tenantId: 'acme', userId: 'u1', roleIds: [] };
const DESCRIPTOR: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };

/**
 * Minimal Knex stand-in whose `.first()` resolves to a fixed COUNT(*) result.
 * Every other chained method is a no-op that returns the builder.
 */
function countDb(firstResult: { row_count: number | string } | undefined) {
  const builder: Record<string, unknown> = {};
  const methods = [
    'where',
    'whereIn',
    'whereLike',
    'whereBetween',
    'join',
    'leftJoin',
    'rightJoin',
    'count',
    'select',
    'orderBy',
    'limit',
    'groupBy',
  ];
  for (const method of methods) {
    builder[method] = () => builder;
  }
  builder.first = async () => firstResult;
  return () => builder;
}

describe('runPreflight', () => {
  describe('default thresholds (client 10k, server 100k)', () => {
    it.each([
      [0, 'client'],
      [10_000, 'client'], // boundary: <= clientThreshold
      [10_001, 'server'],
      [100_000, 'server'], // boundary: <= serverThreshold
      [100_001, 'db'],
      [5_000_000, 'db'],
    ] as const)('routes %i rows to the "%s" tier', async (rowCount, tier) => {
      const result = await runPreflight(countDb({ row_count: rowCount }), CLAIMS, DESCRIPTOR);
      expect(result).toEqual({ rowCount, tier });
    });
  });

  describe('custom thresholds', () => {
    const thresholds = { clientTier: 5, serverMemoryTier: 10 };

    it.each([
      [5, 'client'],
      [6, 'server'],
      [10, 'server'],
      [11, 'db'],
    ] as const)('routes %i rows to "%s" with overrides', async (rowCount, tier) => {
      const result = await runPreflight(
        countDb({ row_count: rowCount }),
        CLAIMS,
        DESCRIPTOR,
        thresholds,
      );
      expect(result.tier).toBe(tier);
    });
  });

  it('coerces a string row_count to a number', async () => {
    const result = await runPreflight(countDb({ row_count: '42' }), CLAIMS, DESCRIPTOR);
    expect(result.rowCount).toBe(42);
    expect(result.tier).toBe('client');
  });

  it('treats a missing COUNT result as zero rows (client tier)', async () => {
    const result = await runPreflight(countDb(undefined), CLAIMS, DESCRIPTOR);
    expect(result).toEqual({ rowCount: 0, tier: 'client' });
  });
});
