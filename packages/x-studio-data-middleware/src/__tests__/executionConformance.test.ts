/**
 * The execution-semantics conformance suite.
 *
 * Runs every case in `@mui/x-studio-schema`'s `EXECUTION_CONFORMANCE_CASES` down BOTH execution
 * paths and asserts they answer the same question the same way:
 *
 * - **In memory** — `applyFilters` from `@mui/x-studio-core/engine`, the L3 layer, directly.
 * - **Pushed down** — the REAL `createBatchingAdapter` translating the filter, the REAL
 *   `handleBatchQuery` executing it against a mock DB, and the adapter's own client-side residual
 *   re-applied on the way back. Nothing here is a re-implementation: the only stand-in is the
 *   database.
 *
 * This is the artifact ADR 0005 asks for. Before it, parity between the two engines was asserted by
 * hand-written tests at specific points, so the divergences that shipped were the ones nobody
 * thought to write a test for. A corpus entry is cheaper to add than a test, and it is checked in
 * both directions.
 *
 * ## Why this file lives here
 *
 * It needs both sides. `x-studio-core` must not depend on this Node-only, Knex-peered package, so
 * the dependency can only run in this direction — the same reason `clientWireSeam.test.ts` is here
 * and imports the client through a relative path. The corpus itself lives in the zero-dependency
 * schema package so both sides can read it without either importing the other.
 *
 * ## What the mock DB does and does not prove
 *
 * `createMockDb` models the wire predicates' semantics, not a specific SQL dialect, and it is
 * deliberately MORE forgiving than a real engine in one place: its `LIKE` is case-insensitive
 * while most engines' is not. That is exactly why every case also pins its DISPOSITION. Asserting
 * only the answer would let a `contains` leaf translate to `LIKE`, agree with the mock, and be
 * wrong on Postgres for data this fixture happens not to contain. Asserting that `contains` stays
 * a client residual catches that on the day someone widens the translation, not on the day a user
 * reports a number.
 */
/* eslint-disable import/no-relative-packages -- the seam can only be tested from the side that may
   depend on both; see the module doc and `clientWireSeam.test.ts`, which does the same. */
import { describe, it, expect, vi } from 'vitest';
import { createBatchingAdapter } from '../../../x-studio-core/src/adapter/createBatchingAdapter';
import { executeLocalQuery } from '../../../x-studio-core/src/engine/executeLocalQuery';
import { planQueryExecution } from '../../../x-studio-core/src/engine/queryPlan';
import type {
  StudioFilterNode,
  StudioQueryDescriptor,
} from '../../../x-studio-schema/src/dataTypes';
import type { ExecutionConformanceCase } from '../../../x-studio-schema/src/executionConformance';
import { EXECUTION_CONFORMANCE_CASES } from '../../../x-studio-schema/src/executionConformance';
import {
  LOCAL_QUERY_CAPABILITIES,
  WIRE_QUERY_CAPABILITIES,
} from '../../../x-studio-schema/src/queryCapabilities';
import { STUDIO_FILTER_OPERATORS } from '../../../x-studio-schema/src/widgetTypeGuards';
/* eslint-enable import/no-relative-packages */
import { handleBatchQuery } from '../handler';
import { LRUCacheProvider } from '../cache/LRUCacheProvider';
import { MapTierCacheProvider } from '../cache/MapTierCacheProvider';
import { createMockDb } from './mockDb';

process.env.JWT_SECRET ??= 'execution-conformance-hmac-secret';

const CLAIMS = { tenantId: 't', userId: 'u', roleIds: [] as string[] };
const TABLE = 'conformance';

let uidCounter = 0;
function endpoint(): string {
  uidCounter += 1;
  return `/api/conformance-${uidCounter}`;
}

/** The leaf both paths are handed, in the wire tree's own shape. */
function leafOf(testCase: ExecutionConformanceCase): StudioFilterNode {
  return {
    type: 'leaf',
    field: testCase.field,
    op: testCase.operator,
    value: testCase.value,
    fieldType: testCase.fieldType,
    ...(testCase.operator2 !== undefined && { op2: testCase.operator2 }),
    ...(testCase.value2 !== undefined && { value2: testCase.value2 }),
    ...(testCase.conjunction !== undefined && { conjunction: testCase.conjunction }),
  };
}

/**
 * The ONE descriptor both executors answer.
 *
 * The point of ADR 0005: the question is stated once. Before, the wire path got a descriptor and
 * the in-memory path got a hand-built `StudioFilterState`, so a corpus case could pass while the
 * two statements of it quietly differed.
 */
function descriptorOf(testCase: ExecutionConformanceCase): StudioQueryDescriptor {
  return {
    sourceId: TABLE,
    tableName: TABLE,
    widgetId: `w-${testCase.id}`,
    cacheKey: `ck-${testCase.id}`,
    // Every column, so a residual can evaluate its own field against the response.
    select: Object.keys(testCase.rows[0] ?? { id: 1 }),
    filter: leafOf(testCase),
  };
}

interface WirePathResult {
  /** Ids the adapter finally returned — server rows with the client residual re-applied. */
  ids: number[];
  /** Predicates the client actually asked the server to evaluate. Empty ⇒ nothing was pushed. */
  pushedPredicateCount: number;
  /** Everything `warnAdapterDivergence` and friends said, joined. */
  warnings: string;
}

/**
 * Run one case through the real client, the real server and the real residual.
 *
 * `console.warn` is captured rather than silenced, because for one disposition the warning IS the
 * contract — a divergence that stops announcing itself is the failure mode the whole
 * degrades-visibly design exists to prevent.
 */
async function runWirePath(testCase: ExecutionConformanceCase): Promise<WirePathResult> {
  const db = createMockDb({ [TABLE]: testCase.rows as Record<string, unknown>[] });
  let pushedPredicateCount = 0;

  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      protocolVersion: number;
      pageId: string;
      widgets: { id: string; table: string; filters?: unknown[] }[];
    };
    pushedPredicateCount = body.widgets[0]?.filters?.length ?? 0;
    const response = await handleBatchQuery(
      {
        protocolVersion: body.protocolVersion,
        pageId: body.pageId,
        widgets: body.widgets as never,
      },
      CLAIMS,
      {
        db: db as never,
        schemaAllowlist: [TABLE],
        tenancy: { mode: 'single-tenant' },
        // Fresh providers per case: the handler otherwise falls back to module-level defaults
        // shared across the file, and two cases with an equivalent descriptor would serve each
        // other's rows.
        cacheProvider: new LRUCacheProvider(),
        tierCacheProvider: new MapTierCacheProvider(),
      },
    );
    return { ok: true, json: async () => response } as unknown as Response;
  });

  const adapter = createBatchingAdapter(endpoint(), {
    fetchFn: fetchFn as unknown as typeof fetch,
    batchDelayMs: 0,
  });

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let result;
  let warnings = '';
  try {
    result = await adapter.getRows(descriptorOf(testCase));
  } finally {
    warnings = warn.mock.calls.flat().join('\n');
    warn.mockRestore();
  }

  return {
    ids: (result.rows as { id: number }[]).map((row) => row.id).sort((a, b) => a - b),
    pushedPredicateCount,
    warnings,
  };
}

/**
 * The local executor's answer — reached through the SAME descriptor the wire path is given.
 *
 * This used to call `applyFilters` with a hand-built `StudioFilterState`, which meant the suite
 * compared two engines fed from two different statements of the question. Since ADR 0005 the
 * descriptor IS the question, so both sides now start from one object and the corpus tests the
 * contract rather than a pair of translations of it.
 */
function memoryIds(testCase: ExecutionConformanceCase): number[] {
  const result = executeLocalQuery(descriptorOf(testCase), {
    rows: testCase.rows as Record<string, unknown>[],
    dataSources: {
      [TABLE]: {
        id: TABLE,
        label: TABLE,
        fields: Object.keys(testCase.rows[0] ?? { id: 1 }).map((id) => ({
          id,
          label: id,
          type: 'string' as const,
        })),
        rows: testCase.rows as Record<string, unknown>[],
      },
    },
  });
  return (result.rows as { id: number }[]).map((row) => row.id).sort((a, b) => a - b);
}

describe('execution semantics — corpus integrity', () => {
  it('gives every case a unique id', () => {
    const ids = EXECUTION_CONFORMANCE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes every non-faithful disposition state WHY', () => {
    // A case that degrades without a reason is a case nobody can review. The reason is what a
    // future reader weighs when they are tempted to widen translation.
    const unexplained = EXECUTION_CONFORMANCE_CASES.filter(
      (c) => c.disposition !== 'pushed-down' && !c.why,
    ).map((c) => c.id);
    expect(unexplained, 'every degrading case must say why it cannot be faithful').toEqual([]);
  });

  it('keeps the known-divergence category to the one entry that was argued for', () => {
    // Deliberately a hard cap rather than a soft convention. This category means "we ship a wrong
    // answer on purpose", and it is the one place in the contract where growth must be a
    // discussion rather than a commit. Raising the number is the point at which someone has to
    // justify the second one in the ADR.
    const known = EXECUTION_CONFORMANCE_CASES.filter(
      (c) => c.disposition === 'pushed-down-with-known-divergence',
    );
    expect(known.map((c) => c.id)).toEqual(['null/not-equals-keeps-nulls-in-memory']);
  });
});

describe('execution semantics — the capability declarations', () => {
  it('makes the local executor accept everything the contract defines', () => {
    // The invariant the whole arrangement rests on. The planner can only route a declined leaf
    // somewhere if ONE executor always accepts everything; without that, "the descriptor is the
    // contract" degrades to "the descriptor is a suggestion". A `false` in
    // LOCAL_QUERY_CAPABILITIES would not mean the engine is limited — it would mean the contract
    // describes something nothing implements.
    const declined = EXECUTION_CONFORMANCE_CASES.filter(
      (c) =>
        planQueryExecution(descriptorOf(c), LOCAL_QUERY_CAPABILITIES).residualLeaves.length > 0,
    ).map((c) => c.id);
    expect(declined, 'the reference executor must accept every case').toEqual([]);
  });

  it('declares every filter operator, so a new one cannot ship undeclared', () => {
    // `satisfies Record<StudioFilterOperator, boolean>` already enforces this at compile time. The
    // runtime twin exists because the compile-time version is invisible in a review diff: adding an
    // operator breaks the build, and the cheapest way to unbreak it is to copy a neighbour's value.
    // This says out loud that the value is a decision.
    for (const op of STUDIO_FILTER_OPERATORS) {
      expect(typeof LOCAL_QUERY_CAPABILITIES.operators[op], `local: ${op}`).toBe('boolean');
      expect(typeof WIRE_QUERY_CAPABILITIES.operators[op], `wire: ${op}`).toBe('boolean');
    }
  });

  it('keeps the wire declaration and the corpus telling the same story', () => {
    // The declaration and the corpus are the same degradation register in two forms. This is what
    // stops them becoming two: widen a capability without adding a case and the disposition suite
    // fails; add a case that contradicts the declaration and this fails first, with the clearer
    // message.
    const disagreements = EXECUTION_CONFORMANCE_CASES.filter((c) => {
      const accepted =
        planQueryExecution(descriptorOf(c), WIRE_QUERY_CAPABILITIES).acceptedLeaves.length > 0;
      return accepted !== (c.disposition !== 'client-residual');
    }).map((c) => c.id);
    expect(disagreements, 'WIRE_QUERY_CAPABILITIES and the corpus disagree').toEqual([]);
  });
});

describe('execution semantics — the in-memory path answers what the contract says', () => {
  // Run FIRST and separately from the agreement check below, so a corpus case whose expectation is
  // simply wrong fails as "the contract is wrong" rather than as "the two engines disagree".
  it.each(EXECUTION_CONFORMANCE_CASES.map((c) => [c.id, c] as const))('%s', (_id, testCase) => {
    expect(memoryIds(testCase), testCase.description).toEqual(
      [...testCase.expectedIds].sort((a, b) => a - b),
    );
  });
});

describe('execution semantics — both paths agree', () => {
  it.each(
    EXECUTION_CONFORMANCE_CASES.filter(
      (c) => c.disposition !== 'pushed-down-with-known-divergence',
    ).map((c) => [c.id, c] as const),
  )('%s', async (_id, testCase) => {
    const wire = await runWirePath(testCase);
    expect(wire.ids, testCase.description).toEqual([...testCase.expectedIds].sort((a, b) => a - b));
  });
});

describe('execution semantics — each leaf runs where the contract says it runs', () => {
  it.each(EXECUTION_CONFORMANCE_CASES.map((c) => [c.id, c] as const))(
    '%s',
    async (_id, testCase) => {
      const shouldGoDown = testCase.disposition !== 'client-residual';

      // 1. The PLAN agrees with the contract. Since ADR 0005 the split is a pure function of the
      //    descriptor and a declared capability set, so this is now checkable without running
      //    anything — and it is the assertion that fails when someone edits
      //    `WIRE_QUERY_CAPABILITIES` without editing the register the corpus encodes.
      const plan = planQueryExecution(descriptorOf(testCase), WIRE_QUERY_CAPABILITIES);
      expect(
        plan.acceptedLeaves.length > 0,
        shouldGoDown
          ? `${testCase.id} is contracted to push down, but the plan declined it`
          : `${testCase.id} must stay a client residual — ${testCase.why}`,
      ).toBe(shouldGoDown);

      // 2. The ADAPTER honours the plan. The declaration could be right while the encoding ignores
      //    it, which is exactly the gap between "we decided" and "it happens", so the real POST
      //    body is checked too. This is also the check that survives a forgiving mock: the mock's
      //    `LIKE` is case-insensitive, so a `contains` wrongly pushed down would still agree on the
      //    answer and be wrong on Postgres for data outside this fixture.
      const wire = await runWirePath(testCase);
      expect(
        wire.pushedPredicateCount > 0,
        `${testCase.id}: the plan and the adapter's actual request disagree about where it runs`,
      ).toBe(shouldGoDown);
    },
  );
});

describe('execution semantics — the one known divergence', () => {
  const testCase = EXECUTION_CONFORMANCE_CASES.find(
    (c) => c.disposition === 'pushed-down-with-known-divergence',
  )!;

  it('really does diverge — the contract is not describing a problem that went away', async () => {
    // If the two paths ever agree here, the divergence has been fixed and this whole category
    // should be deleted rather than left as a standing exemption nobody re-checks.
    const wire = await runWirePath(testCase);
    expect(wire.ids).not.toEqual([...testCase.expectedIds].sort((a, b) => a - b));
  });

  it('drops the NULL row server-side and keeps it in memory', async () => {
    const wire = await runWirePath(testCase);
    expect(memoryIds(testCase)).toContain(2);
    expect(wire.ids).not.toContain(2);
  });

  it('announces itself, because a silent wrong answer is the thing being avoided', async () => {
    const wire = await runWirePath(testCase);
    expect(wire.warnings).toContain('not_equals');
    expect(wire.warnings).toContain('NULL');
  });
});
