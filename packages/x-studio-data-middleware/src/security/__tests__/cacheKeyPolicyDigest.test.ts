/**
 * Unit tests for the cache-key POLICY DIGEST (Gap B).
 *
 * `generateCacheKey` HMACs the caller's claims correctly, but before this change
 * it ignored the security POLICY that turns those claims into predicates — so two
 * nodes running different `securityColumns` config (e.g. mid-rollout, tightening a
 * `perTable` scope) could serve one node's cached rows to the other node's
 * differently-scoped requests. Folding `CompiledSecurityPolicy.digest` into the
 * HMAC'd security profile closes that: a policy change now lands in a different
 * `securityHash` segment (and therefore a different cache key).
 *
 * These tests also pin that the KEY FORMAT is unchanged — only the HASH INPUTS
 * change (the format-pin lives in `cacheKey.test.ts` and stays green unmodified).
 */
import { describe, it, expect } from 'vitest';
import { compileSecurityPolicy } from '../compileSecurityPolicy';
import { generateCacheKey } from '../cacheKey';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../types';

const SECRET = 'cache-key-policy-digest-test-secret';

const CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'user-1',
  roleIds: ['viewer'],
};

const DESCRIPTOR: BatchWidgetDescriptor = { id: 'w1', table: 'orders' };

describe('generateCacheKey — policy digest scoping', () => {
  it('produces different keys for policies differing only in securityColumns', () => {
    const policyA = compileSecurityPolicy({ tenantColumn: 'tenant_id' });
    const policyB = compileSecurityPolicy({
      tenantColumn: 'tenant_id',
      securityColumns: { perTable: { orders: { region: 'sales_region' } } },
    });

    expect(policyA.digest).not.toBe(policyB.digest);

    const keyA = generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, policyA.digest);
    const keyB = generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, policyB.digest);
    expect(keyA).not.toBe(keyB);
    // Only the securityHash segment changes — the tenant + queryHash segments stay.
    expect(keyA.split(':')[2]).toBe(keyB.split(':')[2]); // tenant
    expect(keyA.split(':')[4]).toBe(keyB.split(':')[4]); // queryHash
    expect(keyA.split(':')[3]).not.toBe(keyB.split(':')[3]); // securityHash
  });

  it('produces identical digests (and keys) for identical config regardless of object key order', () => {
    const a = compileSecurityPolicy({
      tenantColumn: 'tenant_id',
      securityColumns: {
        region: 'sales_region',
        department: 'dept',
        perTable: { customers: { tenant: 'org_id', region: 'region_id' } },
      },
    });
    const b = compileSecurityPolicy({
      securityColumns: {
        perTable: { customers: { region: 'region_id', tenant: 'org_id' } },
        department: 'dept',
        region: 'sales_region',
      },
      tenantColumn: 'tenant_id',
    });
    expect(a.digest).toBe(b.digest);
    expect(generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, a.digest)).toBe(
      generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, b.digest),
    );
  });

  it('defaults to the empty-policy digest when no digest is passed (backward compatible)', () => {
    const emptyPolicy = compileSecurityPolicy({});
    expect(generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, emptyPolicy.digest)).toBe(
      generateCacheKey(CLAIMS, DESCRIPTOR, SECRET),
    );
  });

  it('keeps the documented key format studio:v1:<tenant>:<securityHash>:<queryHash>', () => {
    const policy = compileSecurityPolicy({
      tenantColumn: 'tenant_id',
      securityColumns: { perTable: { orders: { region: 'sales_region' } } },
    });
    const key = generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, policy.digest);
    expect(key).toMatch(/^studio:v1:acme:[0-9a-f]{16}:[0-9a-f]{16}$/);
  });
});
