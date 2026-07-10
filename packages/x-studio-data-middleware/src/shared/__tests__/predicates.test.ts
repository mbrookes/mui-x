/**
 * Unit tests for the security-column resolvers in `shared/predicates.ts`.
 *
 * Focus: the own-property gate on the two `perTable[table]` lookups (finding 2.2).
 * `table` is client JSON (`descriptor.table` / `joins[].table`), so a table named
 * like an `Object.prototype` member must resolve to "no per-table override" instead
 * of an inherited prototype object. These were the last two ungated table-keyed
 * prototype-chain reads in the package; every sibling lookup is
 * `Object.prototype.hasOwnProperty.call`-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolvePrimarySecurityColumns, resolveJoinSecurityColumns } from '../predicates';
import type { SecurityColumnsConfig } from '../../security/types';

const TENANT_COLUMN = 'tenant_id';
const DEFAULT_COLUMNS = { tenant: TENANT_COLUMN, region: 'region_id', department: 'department' };

// Object.prototype member names a client could send as a table name.
const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('resolvePrimarySecurityColumns / resolveJoinSecurityColumns — own-property gate (finding 2.2)', () => {
  it.each(PROTO_KEYS)(
    'resolvePrimarySecurityColumns falls through to the default columns for a table named "%s"',
    (table) => {
      const config: SecurityColumnsConfig = { perTable: {} };
      expect(resolvePrimarySecurityColumns(table, config, TENANT_COLUMN)).toEqual(DEFAULT_COLUMNS);
    },
  );

  it.each(PROTO_KEYS)(
    'resolveJoinSecurityColumns inherits the default columns for a table named "%s" (not the whole-table opt-out)',
    (table) => {
      const config: SecurityColumnsConfig = { perTable: {} };
      // Must NOT resolve to `undefined` (the explicit-shared-table opt-out) via an
      // inherited prototype member — a proto-named joined table stays scoped.
      expect(resolveJoinSecurityColumns(table, config, TENANT_COLUMN)).toEqual(DEFAULT_COLUMNS);
    },
  );

  it('works when perTable is omitted entirely (no config)', () => {
    for (const table of PROTO_KEYS) {
      expect(resolvePrimarySecurityColumns(table, undefined, TENANT_COLUMN)).toEqual(
        DEFAULT_COLUMNS,
      );
      expect(resolveJoinSecurityColumns(table, undefined, TENANT_COLUMN)).toEqual(DEFAULT_COLUMNS);
    }
  });

  it('a real own-property override is still honored (gate does not break the normal path)', () => {
    const config: SecurityColumnsConfig = { perTable: { customers: { tenant: 'org_id' } } };
    expect(resolvePrimarySecurityColumns('customers', config, TENANT_COLUMN).tenant).toBe('org_id');
    expect(resolveJoinSecurityColumns('customers', config, TENANT_COLUMN)!.tenant).toBe('org_id');
    // country_codes: null still opts a shared/lookup table out entirely.
    const shared: SecurityColumnsConfig = { perTable: { country_codes: null } };
    expect(resolveJoinSecurityColumns('country_codes', shared, TENANT_COLUMN)).toBeUndefined();
  });
});

// These tests would FAIL if the own-property gate were reverted: a polluted
// `Object.prototype[table]` entry is exactly what an inherited-member read would
// pick up, flipping scoping for that table on EVERY request. The gate reads own
// properties only, so it is immune. Cleanup runs synchronously in `afterEach`.
describe('resolvers ignore host-side Object.prototype pollution (finding 2.2 — reversion guard)', () => {
  const POLLUTED_TABLE = '__mui_x_polluted_test_table__';

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)[POLLUTED_TABLE];
  });

  it('resolveJoinSecurityColumns ignores a whole-entry null on the prototype (would UNSCOPE if ungated)', () => {
    // An ungated `config.perTable[POLLUTED_TABLE]` would read this inherited `null`
    // and return `undefined` — a fully unscoped cross-tenant join.
    (Object.prototype as Record<string, unknown>)[POLLUTED_TABLE] = null;
    const config: SecurityColumnsConfig = { perTable: {} };
    expect(resolveJoinSecurityColumns(POLLUTED_TABLE, config, TENANT_COLUMN)).toEqual(
      DEFAULT_COLUMNS,
    );
  });

  it('resolvePrimarySecurityColumns ignores an inherited { tenant: null } (would DROP the tenant predicate if ungated)', () => {
    // An ungated read would pick up `{ tenant: null }` and resolve the tenant column
    // to `undefined`, silently dropping the tenant predicate for this table.
    (Object.prototype as Record<string, unknown>)[POLLUTED_TABLE] = { tenant: null };
    const config: SecurityColumnsConfig = { perTable: {} };
    expect(resolvePrimarySecurityColumns(POLLUTED_TABLE, config, TENANT_COLUMN)).toEqual(
      DEFAULT_COLUMNS,
    );
    expect(resolveJoinSecurityColumns(POLLUTED_TABLE, config, TENANT_COLUMN)).toEqual(
      DEFAULT_COLUMNS,
    );
  });
});
