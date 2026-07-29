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
import { generateCacheKey } from '../cacheKey';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../types';
import { resolveJoinSecurityColumns, resolvePrimarySecurityColumns } from '../../shared/predicates';

const MULTI_TENANT = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

/** Derive the resolved tenant column from a tenancy config, mirroring compileSecurityPolicy. */
function resolvedTenantColumn(opts: SecurityPolicyOptions): string | undefined {
  return opts.tenancy.mode === 'multi-tenant' ? opts.tenancy.tenantColumn : undefined;
}

// Representative config matrix — four representative shapes.
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

// ── Fail-closed tenant-column validation (finding 2.1) ────────────────────────
//
// `TenancyConfig.tenantColumn: string` is a COMPILE-TIME guarantee only. The
// realistic misconfiguration is `tenantColumn: process.env.TENANT_COLUMN!` with
// the env var unset (→ `undefined`) or set to `''`. Before this fix that passed
// straight through and the downstream truthiness gate (`predicates.ts`
// `if (securityColumns.tenant)`) emitted NO tenant predicate on any read or write,
// skipped the insert force-stamp, and skipped the client-supplied-tenant rejection
// — a deployment that BELIEVES it is multi-tenant ran fully cross-tenant unscoped.
// Compilation must now fail CLOSED.
describe('compileSecurityPolicy — fail-closed tenant-column validation (finding 2.1)', () => {
  it.each([
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
  ])('throws when multi-tenant tenantColumn is %s', (_label, tenantColumn) => {
    expect(() =>
      compileSecurityPolicy({ tenancy: { mode: 'multi-tenant', tenantColumn } }),
    ).toThrow(/multi-tenant.*tenantColumn/s);
  });

  it('throws when multi-tenant tenantColumn is undefined (unset env var)', () => {
    expect(() =>
      // Cast: the `undefined` here models an unset `process.env.TENANT_COLUMN!`,
      // which the `tenantColumn: string` type cannot represent but runtime can.
      compileSecurityPolicy({
        tenancy: { mode: 'multi-tenant', tenantColumn: undefined as unknown as string },
      }),
    ).toThrow(/multi-tenant.*tenantColumn/s);
  });

  it('throws BEFORE producing a policy whose tenant predicate would be silently disabled (the insert-leak scenario)', () => {
    // Prove the exact danger the throw prevents: with an empty tenant column the
    // resolved tenant column is falsy (`''`), so the downstream truthiness gate
    // (`emitSecurityPredicates` `if (securityColumns.tenant)`) emits NO tenant
    // predicate, and an INSERT would neither force-stamp the tenant nor reject a
    // client-supplied tenant value (`mutationBuilder` gates BOTH on `cols.tenant`).
    // That silently-unscoped policy must never be handed back: compilation fails
    // closed first.
    expect(resolvePrimarySecurityColumns('orders', undefined, '').tenant).toBe('');
    expect(Boolean(resolvePrimarySecurityColumns('orders', undefined, '').tenant)).toBe(false);
    expect(() =>
      compileSecurityPolicy({ tenancy: { mode: 'multi-tenant', tenantColumn: '' } }),
    ).toThrow();
  });

  it('still compiles cleanly for a valid non-empty tenantColumn', () => {
    expect(() =>
      compileSecurityPolicy({ tenancy: { mode: 'multi-tenant', tenantColumn: 'tenant_id' } }),
    ).not.toThrow();
  });
});

// ── Fail-closed empty-string dimension override (finding 2.1) ─────────────────
//
// `perTable[t].tenant: ''` (and any empty-string dimension override) is an
// UNDOCUMENTED third sentinel: `resolveDimension('')` returns `''`, which the
// downstream truthiness gate silently skips, AND — for a per-table tenant — it
// dodges the single-tenant contradiction check (which gates on `Boolean(entry.tenant)`).
// It must be rejected as neither a rename (non-empty string) nor the `null` drop.
describe('compileSecurityPolicy — fail-closed empty-string dimension override (finding 2.1)', () => {
  it('throws for an empty-string perTable[t].tenant override (multi-tenant)', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        securityColumns: { perTable: { customers: { tenant: '' } } },
      }),
    ).toThrow(/customers.*tenant/s);
  });

  it('throws for an empty-string perTable[t].tenant override under single-tenant (closes the contradiction-check escape hatch)', () => {
    // Under single-tenant `Boolean('')` is false, so the contradiction check would
    // NOT fire — the empty string used to silently opt the table out. Now the
    // empty-string validation throws first.
    expect(() =>
      compileSecurityPolicy({
        tenancy: SINGLE_TENANT,
        securityColumns: { perTable: { customers: { tenant: '' } } },
      }),
    ).toThrow(/customers.*tenant/s);
  });

  it('throws for a whitespace-only perTable[t].region override', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        securityColumns: { perTable: { audit_log: { region: '  ' } } },
      }),
    ).toThrow(/audit_log.*region/s);
  });

  it('throws for an empty-string top-level securityColumns.region', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        securityColumns: { region: '' },
      }),
    ).toThrow(/securityColumns\.region/s);
  });

  it('throws for an empty-string top-level securityColumns.department', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        securityColumns: { department: '' },
      }),
    ).toThrow(/securityColumns\.department/s);
  });

  // Regression: `assertOptionalColumnName` returned early for `null`, treating it
  // as the documented drop sentinel — but `resolveDimension`'s TOP-LEVEL fallback
  // is `config?.region ?? 'region_id'`, and `null ?? 'region_id'` is `'region_id'`.
  // A host writing `securityColumns: { region: null }` to mean "no region column
  // in this deployment" silently got the DEFAULT `region_id` column scoped —
  // exactly the opposite of what the identical literal means inside `perTable`.
  it('throws for a top-level securityColumns.region of null (the opposite of the perTable meaning)', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        securityColumns: { region: null as unknown as string },
      }),
    ).toThrow(/securityColumns\.region is null, which is not a valid column name at the top level/);
  });

  it('throws for a top-level securityColumns.department of null', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        securityColumns: { department: null as unknown as string },
      }),
    ).toThrow(/securityColumns\.department is null/);
  });

  it('still accepts null INSIDE perTable, where it really does drop the dimension', () => {
    const policy = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { audit_log: { region: null } } },
    });
    expect(policy.forPrimaryTable('audit_log').region).toBeUndefined();
    // …and the top-level default still applies to every other table.
    expect(policy.forPrimaryTable('orders').region).toBe('region_id');
  });

  it('still allows null (drop) and a real string (rename) in the same override', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        securityColumns: { perTable: { audit_log: { region: null, department: 'dept' } } },
      }),
    ).not.toThrow();
  });
});

// ── Fail-closed ALLOWLIST-SHAPE validation ──────────────────────────────────
//
// Regression: `schemaAllowlist`, `columnAllowlist` and `writableColumns` were
// enforced by TypeScript alone, while every membership check that consumes them
// is `Array.prototype.includes`. A host that wires an allowlist straight to an
// environment variable supplies a STRING, and `includes` silently degrades to
// SUBSTRING matching — which FAILS OPEN. `compileSecurityPolicy` is the one
// config choke point both handlers run first, and it already runtime-validates
// `tenancy.tenantColumn` for exactly the same reason.
describe('compileSecurityPolicy — fail-closed allowlist-shape validation', () => {
  it('throws for a string schemaAllowlist (the substring-matching fail-open shape)', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        schemaAllowlist: 'orders_public' as unknown as string[],
      }),
    ).toThrow(/schemaAllowlist must be an array of strings/);
  });

  it('throws for a non-string entry inside schemaAllowlist', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        schemaAllowlist: ['orders', 42] as unknown as string[],
      }),
    ).toThrow(/schemaAllowlist contains a number/);
  });

  it('throws for a string columnAllowlist entry', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        columnAllowlist: { orders: 'id,status' } as unknown as Record<string, string[]>,
      }),
    ).toThrow(/columnAllowlist\["orders"\] must be an array of strings/);
  });

  it('throws for a non-object columnAllowlist', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        columnAllowlist: ['orders'] as unknown as Record<string, string[]>,
      }),
    ).toThrow(/columnAllowlist must be a plain object/);
  });

  it('throws for a string writableColumns entry', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        writableColumns: { orders: 'id,status' } as unknown as Record<string, string[]>,
      }),
    ).toThrow(/writableColumns\["orders"\] must be an array of strings/);
  });

  it('accepts every well-formed allowlist shape unchanged', () => {
    expect(() =>
      compileSecurityPolicy({
        tenancy: MULTI_TENANT,
        schemaAllowlist: ['orders', 'customers'],
        columnAllowlist: { orders: ['id', 'status'], customers: ['*'] },
        writableColumns: { orders: ['status'] },
      }),
    ).not.toThrow();
  });

  it('does NOT fold writableColumns into the digest (the write path never reads it)', () => {
    const withWritable = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      writableColumns: { orders: ['status'] },
    });
    const without = compileSecurityPolicy({ tenancy: MULTI_TENANT });
    expect(withWritable.digest).toBe(without.digest);
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

// ── Per-dimension override / opt-out (finding 2.1) ────────────────────────────
//
// A joined table that carries tenant_id but has NO region/department column can
// now drop those dimensions individually (`{ region: null }`) while KEEPING tenant
// scoping — instead of the old all-or-nothing `perTable[table] = null`, which also
// dropped the tenant predicate and re-opened the cross-tenant fan-out on a
// non-unique join key.
describe('compileSecurityPolicy — per-dimension override (finding 2.1)', () => {
  it('drops only region/department for a joined table while keeping tenant scoping', () => {
    const policy = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { audit_log: { region: null, department: null } } },
    });
    expect(policy.forJoinedTable('audit_log')).toEqual({
      tenant: 'tenant_id',
      region: undefined,
      department: undefined,
    });
  });

  it('drops one dimension and renames another in the same override', () => {
    const policy = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { audit_log: { region: null, department: 'dept' } } },
    });
    expect(policy.forJoinedTable('audit_log')).toEqual({
      tenant: 'tenant_id',
      region: undefined,
      department: 'dept',
    });
  });

  it('applies a per-dimension null on the PRIMARY table too (keeps tenant + department)', () => {
    const policy = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { orders: { region: null } } },
    });
    expect(policy.forPrimaryTable('orders')).toEqual({
      tenant: 'tenant_id',
      region: undefined,
      department: 'department',
    });
  });

  it('a per-dimension null is distinct from a whole-entry null (tenant survives)', () => {
    const perDimension = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { audit_log: { region: null } } },
    });
    const wholeEntry = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { audit_log: null } },
    });
    // Per-dimension keeps tenant (only region dropped); whole-entry drops everything.
    expect(perDimension.forJoinedTable('audit_log')).toEqual({
      tenant: 'tenant_id',
      region: undefined,
      department: 'department',
    });
    expect(wholeEntry.forJoinedTable('audit_log')).toBeUndefined();
  });

  it('folds a per-dimension null override into the policy digest (cache-key sensitive)', () => {
    const withDrop = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { audit_log: { region: null } } },
    });
    const withoutOverride = compileSecurityPolicy({ tenancy: MULTI_TENANT });
    const withRename = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: { perTable: { audit_log: { region: 'region_id' } } },
    });
    // Dropping a dimension must change the digest vs. no override at all…
    expect(withDrop.digest).not.toBe(withoutOverride.digest);
    // …and vs. RENAMING the same dimension (null ≠ 'region_id' in the canonical form),
    // so a cache entry computed under one policy can never be served under the other.
    expect(withDrop.digest).not.toBe(withRename.digest);
  });
});

/**
 * `columnAllowlist` folding into the policy digest (U-CacheKey).
 *
 * Before this change, `computePolicyDigest` ignored `columnAllowlist`, so the
 * server-side cache key was IDENTICAL before and after a host tightened which
 * columns a client may see — meaning results cached under a looser (or bypassed)
 * allowlist could be served stale after the host locked column visibility down.
 * Folding the (canonicalized) allowlist into the digest closes that window: a
 * tightened allowlist now lands in a different digest → different cache key.
 */
describe('compileSecurityPolicy — columnAllowlist digest folding', () => {
  const CLAIMS: JwtSecurityClaims = { tenantId: 'acme', userId: 'user-1', roleIds: ['viewer'] };
  const DESCRIPTOR: BatchWidgetDescriptor = { id: 'w1', table: 'orders' };
  const SECRET = 'column-allowlist-digest-test-secret';

  it('(a) different allowlists produce different digests AND different cache keys', () => {
    const loose = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      columnAllowlist: { orders: ['id', 'status', 'secret_notes'] },
    });
    const tightened = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      columnAllowlist: { orders: ['id', 'status'] },
    });

    expect(loose.digest).not.toBe(tightened.digest);

    const keyLoose = generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, loose.digest);
    const keyTightened = generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, tightened.digest);
    expect(keyLoose).not.toBe(keyTightened);
    // Only the securityHash segment moves — tenant + queryHash stay put.
    expect(keyLoose.split(':')[2]).toBe(keyTightened.split(':')[2]); // tenant
    expect(keyLoose.split(':')[4]).toBe(keyTightened.split(':')[4]); // queryHash
    expect(keyLoose.split(':')[3]).not.toBe(keyTightened.split(':')[3]); // securityHash
  });

  it('(b) deep-equal allowlists differing only in key/array order produce the SAME digest and key', () => {
    const a = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      columnAllowlist: {
        orders: ['id', 'status', 'amount'],
        customers: ['name', 'region'],
      },
    });
    const b = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      // Different table-key insertion order AND different column array order.
      columnAllowlist: {
        customers: ['region', 'name'],
        orders: ['amount', 'id', 'status'],
      },
    });

    expect(a.digest).toBe(b.digest);
    expect(generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, a.digest)).toBe(
      generateCacheKey(CLAIMS, DESCRIPTOR, SECRET, b.digest),
    );
  });

  it('(c) an omitted allowlist is byte-identical to the pre-change digest (backward compatible)', () => {
    // Omitting columnAllowlist must not change the digest at all: the key is only
    // present in the hashed input when supplied. A policy with an EXPLICIT
    // allowlist must differ from one that omits it.
    const omitted = compileSecurityPolicy({ tenancy: MULTI_TENANT });
    const omittedAgain = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      securityColumns: undefined,
      columnAllowlist: undefined,
    });
    expect(omitted.digest).toBe(omittedAgain.digest);

    const withAllowlist = compileSecurityPolicy({
      tenancy: MULTI_TENANT,
      columnAllowlist: { orders: ['id'] },
    });
    expect(withAllowlist.digest).not.toBe(omitted.digest);
  });

  it('distinguishes an empty allowlist object from an omitted one', () => {
    const empty = compileSecurityPolicy({ tenancy: MULTI_TENANT, columnAllowlist: {} });
    const omitted = compileSecurityPolicy({ tenancy: MULTI_TENANT });
    expect(empty.digest).not.toBe(omitted.digest);
  });
});
