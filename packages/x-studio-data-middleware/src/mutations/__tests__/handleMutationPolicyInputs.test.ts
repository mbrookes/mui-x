/**
 * Regression tests for WHAT `handleMutation` compiles its security policy from
 * (finding L2).
 *
 * `handleBatchQuery` compiles `{ tenancy, securityColumns, columnAllowlist,
 * schemaAllowlist }`; `handleMutation` compiled the same set MINUS
 * `schemaAllowlist`. Per `SecurityPolicyOptions.schemaAllowlist`'s own contract
 * that field is THE zero-config data-source separator — "two option sets in one
 * process that expose different tables get different digests, hence different
 * cache keys, without the host having to remember to set `cacheScope`" — so a
 * digest compiled without it does not identify the data source at all.
 *
 * The gap is INERT today: the write path never consumes `policy.digest`
 * (invalidation is by table tag, not by key). It is still worth pinning, for two
 * reasons the omission itself demonstrates: nothing observable changed when the
 * field was added or removed, so only a test on the compiler's INPUT can catch a
 * regression; and a digest that means one thing on the read path and another on
 * the write path is a trap for anyone comparing them, plus a silent failure
 * waiting for the first write-path use of the digest.
 *
 * The compiler's argument is not otherwise observable, so this file spies on the
 * module — which is why it lives in its own file rather than in
 * `handleMutation.test.ts`: the module mock must not affect that suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMutation } from '../handleMutation';
import {
  compileSecurityPolicy,
  type CompiledSecurityPolicy,
  type SecurityPolicyOptions,
} from '../../security/compileSecurityPolicy';
import type { BatchMutationRequest, CacheProvider } from '../../index';

// `vi.hoisted` + `vi.mock` are both lifted above the imports by Vitest's
// transform, so the spy exists by the time `../handleMutation` binds
// `compileSecurityPolicy`. The real implementation is kept — this observes the
// call, it does not change behaviour.
const policySpies = vi.hoisted(() => ({ compileSecurityPolicy: vi.fn() }));

vi.mock('../../security/compileSecurityPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../security/compileSecurityPolicy')>();
  policySpies.compileSecurityPolicy.mockImplementation(actual.compileSecurityPolicy);
  return { ...actual, compileSecurityPolicy: policySpies.compileSecurityPolicy };
});

const TENANCY = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
const CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'] };
const SECURITY_COLUMNS = { region: 'region_id' };
const COLUMN_ALLOWLIST = { orders: ['id', 'status'] };
const SCHEMA_ALLOWLIST = ['orders'];

/** A Knex-shaped stub that resolves any built mutation without touching a DB. */
function makeDb() {
  return () => {
    const qb: any = {
      where: () => qb,
      whereIn: () => qb,
      insert: () => qb,
      update: () => qb,
      delete: () => qb,
      then: (resolve: (v: unknown) => void) => resolve(1),
    };
    return qb;
  };
}

/** A no-op cache so the process-wide default singleton is never touched. */
const NOOP_CACHE: CacheProvider = {
  async get() {
    return undefined;
  },
  async set() {},
  async invalidatePrefix() {},
  async deleteByTag() {},
};

const BODY: BatchMutationRequest = {
  mutations: [
    {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'id', operator: 'eq', value: 1 }],
    },
  ],
};

function run(overrides: { schemaAllowlist?: string[] } = {}) {
  return handleMutation(BODY, CLAIMS, {
    db: makeDb(),
    schemaAllowlist: overrides.schemaAllowlist ?? SCHEMA_ALLOWLIST,
    tenancy: TENANCY,
    securityColumns: SECURITY_COLUMNS,
    columnAllowlist: COLUMN_ALLOWLIST,
    cacheProvider: NOOP_CACHE,
  });
}

/** The `SecurityPolicyOptions` object the handler handed the compiler. */
function compiledFrom(callIndex = 0): SecurityPolicyOptions {
  return policySpies.compileSecurityPolicy.mock.calls[callIndex][0];
}

/** The `CompiledSecurityPolicy` the handler got back. */
function compiledPolicy(callIndex = 0): CompiledSecurityPolicy {
  return policySpies.compileSecurityPolicy.mock.results[callIndex].value;
}

describe('handleMutation — security-policy compiler inputs (finding L2)', () => {
  beforeEach(() => {
    policySpies.compileSecurityPolicy.mockClear();
  });

  it('compiles the policy from tenancy, securityColumns, columnAllowlist AND schemaAllowlist', async () => {
    await run();

    expect(policySpies.compileSecurityPolicy).toHaveBeenCalledTimes(1);
    expect(compiledFrom()).toEqual({
      tenancy: TENANCY,
      securityColumns: SECURITY_COLUMNS,
      columnAllowlist: COLUMN_ALLOWLIST,
      schemaAllowlist: SCHEMA_ALLOWLIST,
    });
  });

  it('produces the digest the READ path would produce for the same option set', async () => {
    await run();

    // The whole point of the field: the two handlers' digests must be
    // comparable. `handleBatchQuery` compiles exactly this object.
    const readPathDigest = compileSecurityPolicy({
      tenancy: TENANCY,
      securityColumns: SECURITY_COLUMNS,
      columnAllowlist: COLUMN_ALLOWLIST,
      schemaAllowlist: SCHEMA_ALLOWLIST,
    }).digest;

    expect(compiledPolicy().digest).toBe(readPathDigest);
  });

  it('separates two data sources that expose DIFFERENT tables', async () => {
    // This is what the omission cost: with `schemaAllowlist` left out, one
    // process serving two logical databases compiled a byte-identical digest for
    // both, so any future keying off it could not tell them apart.
    await run({ schemaAllowlist: ['orders'] });
    await run({ schemaAllowlist: ['orders', 'customers'] });

    expect(compiledPolicy(0).digest).not.toBe(compiledPolicy(1).digest);
  });
});
