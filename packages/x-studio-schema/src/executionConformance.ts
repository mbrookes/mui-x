/**
 * The execution-semantics conformance corpus.
 *
 * Studio answers the same question two ways. In memory, the four-layer pipeline in
 * `@mui/x-studio-core/engine` filters `Row[]` in the browser. Pushed down,
 * `createBatchingAdapter` translates the filter tree to a wire predicate set,
 * `@mui/x-studio-data-middleware` builds SQL from it, and whatever the wire could not express
 * faithfully is re-applied client-side against the response.
 *
 * **Two implementations, one correct answer, and — until this file — no artifact saying what
 * correct is.** Parity was asserted at specific points by hand-written tests, which is why the
 * divergences that shipped were the ones nobody thought to write a test for. This corpus is that
 * artifact: each case is a row set, a filter, and the answer BOTH paths owe, executed down both by
 * `x-studio-data-middleware`'s `executionConformance.test.ts`.
 *
 * The prose contract these cases enforce is `packages/x-studio/docs/EXECUTION_SEMANTICS.md`;
 * `rule` on each case names the section it comes from. Adding a rule there without adding a case
 * here leaves it unenforced, which is the state this file exists to end.
 *
 * ## Why each case also declares a DISPOSITION
 *
 * Agreeing on the answer is necessary and not sufficient. A filter can produce the right rows on
 * both paths today and still be a latent divergence, because HOW the wire handled it decides
 * whether it stays right: a leaf executed as SQL `LIKE` agrees with the case-insensitive in-memory
 * `contains` only for as long as the fixture happens to use matching case.
 *
 * So each case pins where the leaf ran, not just what it returned:
 *
 * - **`pushed-down`** — the wire expresses this leaf with EXACTLY the in-memory semantics.
 * - **`client-residual`** — the wire cannot, so `isLeafServerTranslatable` refuses it and the
 *   adapter re-applies it locally. `why` records the reason. A case that flips from residual to
 *   pushed-down is the regression this catches: it means someone widened translation past what SQL
 *   can honour, and the answer goes wrong only for data the fixture does not contain.
 * - **`pushed-down-with-known-divergence`** — the wire is NOT faithful, and the leaf is pushed
 *   anyway because routing it client-side would cost more than the divergence does. There is
 *   exactly one of these (`not_equals` on a non-date field: SQL three-valued logic drops NULL rows,
 *   the in-memory evaluator keeps them), it is announced through `warnAdapterDivergence` at
 *   runtime, and its case asserts the announcement rather than an agreement that does not exist.
 *   A second entry in this category should be argued for, not added.
 *
 * ## Deliberately not covered here
 *
 * Rank (Top-N) filters and `RelativeDateValue`s have no wire representation at all and are resolved
 * client-side before a descriptor is built, so there is no second implementation to conform to.
 * Aggregation push-down is governed by `aggregationPushdown.ts`'s shared five-rung ladder, which
 * both adapters already call — one implementation, so a corpus would be testing itself.
 *
 * Zero-dependency by design (mirrors `wireLimits.ts` and `wireProtocol.ts`) so the client, the
 * engine and both middleware packages can read it with no risk of an import cycle.
 */
import type { StudioFilterOperator } from './baseTypes';

/** Where the wire protocol is contractually required to execute a leaf. */
export type ConformanceDisposition =
  /** The wire expresses this leaf with exactly the in-memory semantics. */
  | 'pushed-down'
  /** The wire cannot express it faithfully; the adapter re-applies it locally. */
  | 'client-residual'
  /** Pushed anyway, unfaithfully, with a runtime warning. See the module doc. */
  | 'pushed-down-with-known-divergence';

/** One row of the corpus fixture. `id` is the only field every case shares. */
export interface ConformanceRow {
  id: number;
  [column: string]: unknown;
}

export interface ExecutionConformanceCase {
  /** Stable identifier, used as the test name. */
  id: string;
  /** The section of `EXECUTION_SEMANTICS.md` this case enforces. */
  rule: string;
  /** What the rule says, in one line — the thing that would be wrong if this failed. */
  description: string;
  /** The rows both paths see. */
  rows: ConformanceRow[];
  /** Column under test. */
  field: string;
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  operator: StudioFilterOperator;
  value: unknown;
  /** Optional second condition, for the leaves that carry one. */
  operator2?: StudioFilterOperator;
  value2?: unknown;
  conjunction?: 'and' | 'or';
  /** Row ids that must survive — on BOTH paths, unless the disposition says otherwise. */
  expectedIds: number[];
  disposition: ConformanceDisposition;
  /** Required when the disposition is not `pushed-down`: why the wire cannot be faithful. */
  why?: string;
}

/**
 * The corpus.
 *
 * Ordered by rule so a reader can follow it beside the prose contract. Every case is a real
 * divergence that shipped, or a real one the current design prevents — none is hypothetical.
 */
export const EXECUTION_CONFORMANCE_CASES: readonly ExecutionConformanceCase[] = [
  // ── Rule 1 — numeric coercion ──────────────────────────────────────────────
  {
    id: 'numeric/blank-string-is-not-zero',
    rule: '1. Numeric coercion',
    description:
      'A blank numeric cell is ABSENT, not zero. `Number("")` is 0, so loose coercion counted ' +
      'every blank row as a genuine zero — a "orders with zero discount" KPI over a CSV import.',
    rows: [
      { id: 1, discount: 0 },
      { id: 2, discount: '' },
      { id: 3, discount: '   ' },
      { id: 4, discount: null },
      { id: 5, discount: 5 },
    ],
    field: 'discount',
    fieldType: 'number',
    operator: 'equals',
    value: 0,
    expectedIds: [1],
    disposition: 'pushed-down',
  },
  {
    id: 'numeric/numeric-string-equals-number',
    rule: '1. Numeric coercion',
    description:
      'A numeric STRING still compares numerically, because the filter drawer hands over the raw ' +
      'text-input value and a number column may hold string data.',
    rows: [
      { id: 1, qty: 20 },
      { id: 2, qty: '20' },
      { id: 3, qty: 21 },
    ],
    field: 'qty',
    fieldType: 'number',
    operator: 'equals',
    value: '20',
    expectedIds: [1, 2],
    disposition: 'pushed-down',
  },

  // ── Rule 2 — null has no position in an ordering ───────────────────────────
  {
    id: 'null/excluded-from-ordering',
    rule: '2. Null semantics',
    description:
      'A missing value has no position in an ordering, so it is excluded from >, <, >= and <= ' +
      'rather than compared as 0. SQL three-valued logic excludes it too, so the two agree.',
    rows: [
      { id: 1, amount: 10 },
      { id: 2, amount: null },
      { id: 3, amount: 100 },
    ],
    field: 'amount',
    fieldType: 'number',
    operator: 'greater_than',
    value: 5,
    expectedIds: [1, 3],
    disposition: 'pushed-down',
  },
  {
    id: 'null/not-equals-keeps-nulls-in-memory',
    rule: '2. Null semantics',
    description:
      'THE known divergence. In memory a NULL row is "not equal" to any value and is KEPT; SQL ' +
      'three-valued logic drops it. Pushed anyway because `not_equals` is common and ' +
      'high-selectivity, and routing it client-side would defeat the pushdown entirely — for an ' +
      'aggregated widget it would drop the filter. Announced at runtime instead of hidden.',
    rows: [
      { id: 1, status: 'open' },
      { id: 2, status: null },
      { id: 3, status: 'closed' },
    ],
    field: 'status',
    fieldType: 'string',
    operator: 'not_equals',
    value: 'open',
    // The IN-MEMORY answer. The wire returns [3]; the test asserts the divergence is announced
    // rather than asserting an agreement that does not exist.
    expectedIds: [2, 3],
    disposition: 'pushed-down-with-known-divergence',
    why: 'SQL three-valued logic excludes NULL rows from `<>`; the in-memory evaluator keeps them.',
  },

  // ── Rule 3 — substring operators are case-insensitive ──────────────────────
  {
    id: 'case/contains-is-case-insensitive',
    rule: '3. Case sensitivity',
    description:
      'The substring operators lower-case both sides. SQL `LIKE` is case-SENSITIVE on ' +
      'most engines, so an approximate `LIKE` translation would answer differently for data the ' +
      'fixture happens not to contain — the worst kind of divergence.',
    rows: [
      { id: 1, name: 'Northwind' },
      { id: 2, name: 'northgate' },
      { id: 3, name: 'Southbay' },
    ],
    field: 'name',
    fieldType: 'string',
    operator: 'contains',
    value: 'NORTH',
    expectedIds: [1, 2],
    disposition: 'client-residual',
    why: 'SQL LIKE is case-sensitive; the in-memory `contains` is not.',
  },

  // ── Rule 4 — date comparisons are calendar-day-granular ────────────────────
  {
    id: 'date/equals-matches-the-whole-day',
    rule: '4. Date granularity',
    description:
      'An `equals` against a date-only value matches the WHOLE day of a datetime column, not ' +
      'only its midnight rows. The wire form is a translated `>= D AND < D+1day` pair, not a ' +
      'raw `eq` — which used to match midnight only, and was merely console-warned about.',
    rows: [
      { id: 1, created_at: '2026-03-04T00:00:00Z' },
      { id: 2, created_at: '2026-03-04T17:45:00Z' },
      { id: 3, created_at: '2026-03-05T09:00:00Z' },
    ],
    field: 'created_at',
    fieldType: 'datetime',
    operator: 'equals',
    value: '2026-03-04',
    expectedIds: [1, 2],
    disposition: 'pushed-down',
  },
  {
    id: 'date/greater-than-excludes-the-whole-day',
    rule: '4. Date granularity',
    description:
      '`> D` on a datetime column excludes the whole of day D, so the wire emits ' +
      '`>= D+1day` rather than a literal midnight comparison that would keep the rest of D.',
    rows: [
      { id: 1, created_at: '2026-03-04T00:00:00Z' },
      { id: 2, created_at: '2026-03-04T23:59:00Z' },
      { id: 3, created_at: '2026-03-05T00:00:00Z' },
    ],
    field: 'created_at',
    fieldType: 'datetime',
    operator: 'greater_than',
    value: '2026-03-04',
    expectedIds: [3],
    disposition: 'pushed-down',
  },
  {
    id: 'date/not-equals-is-an-or-the-wire-cannot-express',
    rule: '4. Date granularity',
    description:
      'The faithful form of a day-granular `not_equals` is `< D OR >= D+1day`. The wire protocol ' +
      'is AND-only, so it cannot carry it and the leaf goes to the residual.',
    rows: [
      { id: 1, created_at: '2026-03-04T10:00:00Z' },
      { id: 2, created_at: '2026-03-05T10:00:00Z' },
    ],
    field: 'created_at',
    fieldType: 'datetime',
    operator: 'not_equals',
    value: '2026-03-04',
    expectedIds: [2],
    disposition: 'client-residual',
    why: 'Its faithful form is an OR; the wire protocol is AND-only.',
  },

  // ── Rule 5 — value shapes the wire inverts or breaks on ────────────────────
  {
    id: 'shape/empty-in-matches-nothing',
    rule: '5. Value shapes',
    description:
      'An empty `in: []` matches NOTHING in memory. The middleware drops an empty-`in` predicate ' +
      'on reads, which matches EVERYTHING — the exact inversion. Routed to the residual.',
    rows: [
      { id: 1, region: 'west' },
      { id: 2, region: 'east' },
    ],
    field: 'region',
    fieldType: 'string',
    operator: 'in',
    value: [],
    expectedIds: [],
    disposition: 'client-residual',
    why: 'The middleware drops an empty `in`, inverting it from "nothing" to "everything".',
  },
  {
    id: 'shape/open-ended-between',
    rule: '5. Value shapes',
    description:
      'A `between` with one bound is unbounded on that side in memory. On the wire, ' +
      '`whereBetween(col, [value, undefined])` is a binding error on Postgres and a silent wrong ' +
      'answer on SQLite/MySQL, so it never goes down.',
    rows: [
      { id: 1, amount: 5 },
      { id: 2, amount: 50 },
      { id: 3, amount: 500 },
    ],
    field: 'amount',
    fieldType: 'number',
    operator: 'between',
    value: { from: 10, to: undefined },
    expectedIds: [2, 3],
    disposition: 'client-residual',
    why: 'An open bound is a binding error on Postgres and silently wrong elsewhere.',
  },

  // ── Rule 5b — boolean binding ──────────────────────────────────────────────
  {
    id: 'boolean/recognised-spelling-is-coerced',
    rule: '5. Value shapes',
    description:
      'The drawer stores a boolean condition as the STRING "true"/"false". Bound to SQL as a ' +
      'string that is not merely lossy: PostgreSQL implicitly casts it, but MySQL (tinyint(1)) ' +
      'and SQLite coerce it NUMERICALLY to 0, so `col = "true"` returns exactly the FALSE rows — ' +
      'the complement of the question. The two recognised spellings are coerced to real booleans ' +
      'before they go down.',
    rows: [
      { id: 1, active: true },
      { id: 2, active: false },
    ],
    field: 'active',
    fieldType: 'boolean',
    operator: 'equals',
    value: 'true',
    expectedIds: [1],
    disposition: 'pushed-down',
  },
  {
    id: 'boolean/unrecognised-value-stays-client-side',
    rule: '5. Value shapes',
    description:
      'Anything OTHER than the two recognised spellings on a boolean field has no equally ' +
      'certain coercion, so it falls to the residual rather than shipping a guess that could ' +
      'silently invert on one engine and not another.',
    rows: [
      { id: 1, active: true },
      { id: 2, active: false },
    ],
    field: 'active',
    fieldType: 'boolean',
    operator: 'equals',
    value: 1,
    // In memory a boolean compares as `String(row[field]) === String(value)`, so `1` matches
    // neither `true` nor `false`. The residual reproduces that; a guessed coercion would not.
    expectedIds: [],
    disposition: 'client-residual',
    why: 'No certain boolean coercion exists for it; a guess inverts on MySQL/SQLite.',
  },

  // ── Rule 6 — the wire is AND-only ──────────────────────────────────────────
  {
    id: 'conjunction/or-second-condition',
    rule: '6. Conjunction',
    description:
      'A leaf whose two conditions are OR-ed cannot be two AND-ed predicates. Pushing it down ' +
      'would AND them and return zero rows, so the whole leaf is evaluated client-side.',
    rows: [
      { id: 1, amount: 1 },
      { id: 2, amount: 50 },
      { id: 3, amount: 500 },
    ],
    field: 'amount',
    fieldType: 'number',
    operator: 'less_than',
    value: 5,
    operator2: 'greater_than',
    value2: 100,
    conjunction: 'or',
    expectedIds: [1, 3],
    disposition: 'client-residual',
    why: 'The wire predicate set is AND-combined; an intra-leaf OR has no representation.',
  },

  // ── Rule 7 — operators with no wire form at all ────────────────────────────
  {
    id: 'unmapped/is-empty',
    rule: '7. Operators with no wire form',
    description:
      '`is_empty` covers both NULL and the empty string. The wire has no `IS NULL` predicate, so ' +
      'there is nothing to translate it to.',
    rows: [
      { id: 1, note: '' },
      { id: 2, note: null },
      { id: 3, note: 'something' },
    ],
    field: 'note',
    fieldType: 'string',
    operator: 'is_empty',
    value: '',
    expectedIds: [1, 2],
    disposition: 'client-residual',
    why: 'No `IS NULL` form exists on the wire.',
  },
  {
    id: 'unmapped/not-in',
    rule: '7. Operators with no wire form',
    description:
      '`not_in` is the exact inverse of `in`, consulted explicitly rather than assumed inclusive. ' +
      'The wire carries no negated `in`.',
    rows: [
      { id: 1, region: 'west' },
      { id: 2, region: 'east' },
      { id: 3, region: 'north' },
    ],
    field: 'region',
    fieldType: 'string',
    operator: 'not_in',
    value: ['west', 'north'],
    expectedIds: [2],
    disposition: 'client-residual',
    why: 'The wire has no negated `in` predicate.',
  },
];
