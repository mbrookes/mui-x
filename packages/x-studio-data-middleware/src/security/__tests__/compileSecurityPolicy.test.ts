/**
 * Unit tests for `compileSecurityPolicy` — FALLBACK-CHAIN PARITY.
 *
 * Centralizing the `perTable[table]?.X ?? config?.X ?? hardcodedDefault`
 * resolution into one compiled object must NOT change what it resolves to for any
 * input. Each config shape is compared, table-by-table, against calling the
 * shared `resolvePrimarySecurityColumns` / `resolveJoinSecurityColumns` directly
 * (the pre-refactor resolution path).
 *
 * (The digest → cache-key scoping guarantee, Gap B, is proven separately in
 * `cacheKeyPolicyDigest.test.ts`.)
 */
import { describe, it, expect } from 'vitest';
import { compileSecurityPolicy } from '../compileSecurityPolicy';
import { resolveJoinSecurityColumns, resolvePrimarySecurityColumns } from '../../shared/predicates';
import type { HandleBatchQueryOptions } from '../types';

type PolicyOpts = Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>;

// Representative config matrix — the four shapes called out in the retrofit plan.
const CONFIG_MATRIX: { name: string; opts: PolicyOpts }[] = [
  {
    name: 'legacy tenantColumn-only',
    opts: { tenantColumn: 'tenant_id' },
  },
  {
    name: 'securityColumns with a perTable override',
    opts: {
      securityColumns: {
        region: 'sales_region',
        perTable: { customers: { tenant: 'org_id' } },
      },
    },
  },
  {
    name: 'perTable[table] = null opt-out',
    opts: {
      tenantColumn: 'tenant_id',
      securityColumns: { perTable: { country_codes: null } },
    },
  },
  {
    name: 'both omitted',
    opts: {},
  },
];

// Tables exercised for each config — includes the primary, an overridden joined
// table, the null opt-out table, and an unregistered table (default inheritance).
const TABLES = ['orders', 'customers', 'country_codes', 'unregistered_lookup'];

describe('compileSecurityPolicy — fallback-chain parity', () => {
  for (const { name, opts } of CONFIG_MATRIX) {
    describe(`config: ${name}`, () => {
      const policy = compileSecurityPolicy(opts);

      for (const table of TABLES) {
        it(`forPrimaryTable("${table}") matches resolvePrimarySecurityColumns`, () => {
          expect(policy.forPrimaryTable(table)).toEqual(
            resolvePrimarySecurityColumns(table, opts.securityColumns, opts.tenantColumn),
          );
        });

        it(`forJoinedTable("${table}") matches resolveJoinSecurityColumns`, () => {
          expect(policy.forJoinedTable(table)).toEqual(
            resolveJoinSecurityColumns(table, opts.securityColumns, opts.tenantColumn),
          );
        });
      }
    });
  }

  it('returns undefined from forJoinedTable only for the explicit null opt-out', () => {
    const policy = compileSecurityPolicy({
      tenantColumn: 'tenant_id',
      securityColumns: { perTable: { country_codes: null } },
    });
    // Opted-out shared/lookup table → no predicate.
    expect(policy.forJoinedTable('country_codes')).toBeUndefined();
    // An unregistered joined table still inherits the primary scope (fail-closed).
    expect(policy.forJoinedTable('orders')).toEqual({
      tenant: 'tenant_id',
      region: 'region_id',
      department: 'department',
    });
  });
});

describe('compileSecurityPolicy — hasTenantScope (informational)', () => {
  it('is false when no tenant column resolves anywhere', () => {
    expect(compileSecurityPolicy({}).hasTenantScope).toBe(false);
    expect(compileSecurityPolicy({ securityColumns: { region: 'region_id' } }).hasTenantScope).toBe(
      false,
    );
  });

  it('is true when a legacy tenantColumn, a top-level tenant, or a perTable tenant resolves', () => {
    expect(compileSecurityPolicy({ tenantColumn: 'tenant_id' }).hasTenantScope).toBe(true);
    expect(compileSecurityPolicy({ securityColumns: { tenant: 'tenant_id' } }).hasTenantScope).toBe(
      true,
    );
    expect(
      compileSecurityPolicy({ securityColumns: { perTable: { customers: { tenant: 'org_id' } } } })
        .hasTenantScope,
    ).toBe(true);
  });
});
