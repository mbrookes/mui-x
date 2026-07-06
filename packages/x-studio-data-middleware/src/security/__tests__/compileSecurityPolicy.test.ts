/**
 * Unit tests for `compileSecurityPolicy` — RESOLUTION-CHAIN PARITY.
 *
 * Centralizing the `perTable[table]?.X ?? default` resolution into one compiled
 * object must NOT change what it resolves to for any input. Each config shape is
 * compared, table-by-table, against calling the shared
 * `resolvePrimarySecurityColumns` / `resolveJoinSecurityColumns` directly (the
 * pre-refactor resolution path).
 *
 * (The digest → cache-key scoping guarantee, Gap B, is proven separately in
 * `cacheKeyPolicyDigest.test.ts`.)
 */
import { describe, it, expect } from 'vitest';
import { compileSecurityPolicy, type SecurityPolicyOptions } from '../compileSecurityPolicy';
import { resolveJoinSecurityColumns, resolvePrimarySecurityColumns } from '../../shared/predicates';

const MULTI_TENANT = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

/** Derive the resolved tenant column from a tenancy config, mirroring compileSecurityPolicy. */
function resolvedTenantColumn(opts: SecurityPolicyOptions): string | undefined {
  return opts.tenancy.mode === 'multi-tenant' ? opts.tenancy.tenantColumn : undefined;
}

// Representative config matrix — the four shapes called out in the retrofit plan.
const CONFIG_MATRIX: { name: string; opts: SecurityPolicyOptions }[] = [
  {
    name: 'multi-tenant, no securityColumns',
    opts: { tenancy: MULTI_TENANT },
  },
  {
    name: 'multi-tenant with a perTable override',
    opts: {
      tenancy: MULTI_TENANT,
      securityColumns: {
        region: 'sales_region',
        perTable: { customers: { tenant: 'org_id' } },
      },
    },
  },
  {
    name: 'multi-tenant with a perTable[table] = null opt-out',
    opts: {
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { country_codes: null } },
    },
  },
  {
    name: 'single-tenant',
    opts: { tenancy: SINGLE_TENANT },
  },
];

// Tables exercised for each config — includes the primary, an overridden joined
// table, the null opt-out table, and an unregistered table (default inheritance).
const TABLES = ['orders', 'customers', 'country_codes', 'unregistered_lookup'];

describe('compileSecurityPolicy — resolution-chain parity', () => {
  for (const { name, opts } of CONFIG_MATRIX) {
    describe(`config: ${name}`, () => {
      const policy = compileSecurityPolicy(opts);
      const tenantCol = resolvedTenantColumn(opts);

      for (const table of TABLES) {
        it(`forPrimaryTable("${table}") matches resolvePrimarySecurityColumns`, () => {
          expect(policy.forPrimaryTable(table)).toEqual(
            resolvePrimarySecurityColumns(table, opts.securityColumns, tenantCol),
          );
        });

        it(`forJoinedTable("${table}") matches resolveJoinSecurityColumns`, () => {
          expect(policy.forJoinedTable(table)).toEqual(
            resolveJoinSecurityColumns(table, opts.securityColumns, tenantCol),
          );
        });
      }
    });
  }

  it('returns undefined from forJoinedTable only for the explicit null opt-out', () => {
    const policy = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
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

describe('compileSecurityPolicy — tenancy echo', () => {
  it('echoes back the declared single-tenant posture', () => {
    expect(compileSecurityPolicy({ tenancy: SINGLE_TENANT }).tenancy).toEqual({
      mode: 'single-tenant',
    });
    expect(
      compileSecurityPolicy({ tenancy: SINGLE_TENANT, securityColumns: { region: 'region_id' } })
        .tenancy,
    ).toEqual({ mode: 'single-tenant' });
  });

  it('echoes back the declared multi-tenant posture (incl. the tenant column)', () => {
    expect(compileSecurityPolicy({ tenancy: MULTI_TENANT }).tenancy).toEqual({
      mode: 'multi-tenant',
      tenantColumn: 'tenant_id',
    });
    expect(
      compileSecurityPolicy({
        tenancy: { mode: 'multi-tenant', tenantColumn: 'org_id' },
      }).tenancy,
    ).toEqual({ mode: 'multi-tenant', tenantColumn: 'org_id' });
  });
});

describe('compileSecurityPolicy — fail-closed contradiction check', () => {
  it('throws when single-tenant is declared but a perTable entry sets a tenant column', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: SINGLE_TENANT,
        securityColumns: { perTable: { customers: { tenant: 'org_id' } } },
      }),
    ).toThrow(/single-tenant.*customers.*tenant/s);
  });

  it('does NOT throw for single-tenant with a perTable region/department override (no tenant)', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: SINGLE_TENANT,
        securityColumns: { perTable: { customers: { region: 'region_id' } } },
      }),
    ).not.toThrow();
  });

  it('does NOT throw for single-tenant with a perTable null opt-out', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: SINGLE_TENANT,
        securityColumns: { perTable: { country_codes: null } },
      }),
    ).not.toThrow();
  });
});

describe('compileSecurityPolicy — multi-tenant per-table overrides', () => {
  it('a perTable tenant override wins over the top-level tenancy.tenantColumn for that table', () => {
    const policy = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { customers: { tenant: 'org_id' } } },
    });
    // Overridden table uses its own tenant column…
    expect(policy.forPrimaryTable('customers').tenant).toBe('org_id');
    // …while every other table keeps the global default.
    expect(policy.forPrimaryTable('orders').tenant).toBe('tenant_id');
  });

  it('a perTable[table] = null opt-out un-scopes that table entirely', () => {
    const policy = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { country_codes: null } },
    });
    expect(policy.forJoinedTable('country_codes')).toBeUndefined();
  });
});
