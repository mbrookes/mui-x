# Execution semantics

**The contract between Studio's two execution engines.** This document says what the correct answer
is; [`executionConformance.ts`](../../x-studio-schema/src/executionConformance.ts) encodes it as
cases, and
[`executionConformance.test.ts`](../../x-studio-data-middleware/src/__tests__/executionConformance.test.ts)
runs every case down both paths.

## Contents

- [Why this exists](#why-this-exists)
- [The two paths](#the-two-paths)
- [The rules](#the-rules)
- [The degradation register](#the-degradation-register)
- [How the contract is enforced](#how-the-contract-is-enforced)
- [Deliberately out of scope](#deliberately-out-of-scope)

## Why this exists

The same dashboard has two execution paths, chosen by host configuration. They implement
overlapping semantics in two languages, and until this document there was **no single artifact
defining what the answer should be**. The query descriptor is the closest thing, but the pipeline's
four layers have no counterpart in the SQL builder: the normalization rules, the join-key coercion
policy, the numeric coercion policy, the cross-source semi-join conjunction rule.

Parity was asserted by hand-written tests at specific points. That is why the divergences that
shipped were the ones nobody thought to write a test for — `equals` on a `datetime` column matching
only midnight rows while the in-memory path matched the whole day, and being merely `console.warn`ed
about, so a dashboard viewer saw a wrong number and only a developer saw the note.

This document is the answer to "what does correct mean". It is not a statement that the two-engine
design is settled — see [ADR 0005](./decisions/0005-primary-execution-path.md), which is still open.
It is the part of that ADR's value that does not require the refactor, and if the refactor ever
happens, this is the specification it would be built against.

## The two paths

**In memory** (default) — the whole dataset in the browser, through the four-layer pipeline in
`@mui/x-studio-core/engine`:

```text
L1 normalize      temporalUtils.ts / normalizedRowsCache.ts
L2 enrich         enrichedRowsCache.ts   (computed fields, cross-source joins)
L3 filter         filterScoping.ts + filterUtils.ts + dataSourceGraph.ts
L4 re-anchor      grainResolution.ts     (chart grain only)
   aggregate      aggregate.ts / aggregators.ts
```

**Pushed down** (optional) — a `StudioQueryDescriptor` translated to wire predicates, executed as
SQL, with whatever the wire could not express faithfully re-applied locally:

```text
queryDescriptor.ts        →  build the descriptor
createBatchingAdapter.ts  →  partitionFilterNode: predicates | clientLeaves
                             aggregationPushdown.ts: the five-rung ladder
x-studio-data-middleware  →  queryBuilder.ts → SQL
createBatchingAdapter.ts  →  re-apply clientLeaves via applyFilters
```

The push-down path is **not** a different semantics with a different answer. Where it cannot be
faithful it declines, and the in-memory evaluator finishes the job — which is why the two halves of
`partitionFilterNode` are the load-bearing part of this contract, not the SQL builder.

## The rules

Each rule names the module that implements it on each side. Where a case in the conformance corpus
enforces it, the rule number matches the case's `rule` field.

### 1. Numeric coercion

**An absent value is absent, not zero.** `toNumericValue` (`filterUtils.ts`) coerces only genuine
numbers and non-blank numeric strings; nullish, boolean, object, blank and whitespace-only values
become `NaN`, and every comparison against `NaN` is false.

`Number()` alone is too permissive exactly where it matters: `Number('') === 0`,
`Number(false) === 0`, `Number(null) === 0`. A CSV whose blank numeric cells import as `''` made
every blank row compare equal to zero — a "count of orders with zero discount" KPI counted every
blank row as a zero-discount order.

**A numeric string still compares numerically.** `'20'` equals `20`, because the filter drawer
hands over the raw text-input value and a `number` column may hold string data.

The aggregation side has its own coercion, `coerceAggregateValue` (`aggregate.ts`), with the same
shape and one deliberate difference: a boolean coerces to `1`/`0` there, because aggregating a
boolean column is a meaningful question ("how many are true") while filtering `> false` is not.

### 2. Null semantics

| Operator family             | In memory                         | SQL                     | Agree? |
| :-------------------------- | :-------------------------------- | :---------------------- | :----- |
| `>` `<` `>=` `<=` `between` | null row excluded                 | null excluded (3VL)     | yes    |
| `equals`                    | null row never equals a value     | null never equals (3VL) | yes    |
| `not_equals`                | null row **kept**                 | null **dropped** (3VL)  | **no** |
| `is_empty` / `is_not_empty` | null and `''` both count as empty | n/a — no wire form      | n/a    |

A missing value has no position in an ordering, so it is excluded rather than compared as `0` or
`''`. The `not_equals` row is the one genuine divergence in the whole contract; see
[the degradation register](#the-degradation-register).

### 3. Case sensitivity

**`contains`, `does_not_contain`, `starts_with`, `ends_with` and their negations lower-case both
sides.** SQL `LIKE` is case-sensitive on most engines, so an approximate translation would be wrong
for data outside whatever a given test fixture happens to contain. `OPERATOR_MAP` therefore has no
entry for any of the six — they are unmapped rather than mapped-and-then-rejected, so there is no
half-translation for a future change to widen by accident.

### 4. Date granularity

**In memory, date comparisons are calendar-day-granular whenever the filter value is a bare
`YYYY-MM-DD`.** A `datetime` column holds a full timestamp, but a comparison against a date-only
picker value is a question about the whole day.

`toPredicatesFor` (`createBatchingAdapter.ts`) translates rather than approximates, which is why one
leaf can emit a bound _pair_:

| Filter (bare date `D`) | Wire form                                                       |
| :--------------------- | :-------------------------------------------------------------- |
| `equals D`             | `>= D AND < D+1day`                                             |
| `<= D`                 | `< D+1day`                                                      |
| `> D`                  | `>= D+1day`                                                     |
| `>= D`, `< D`          | unchanged — already aligned                                     |
| `between [F, T]`       | `>= F AND < T+1day`                                             |
| `not_equals D`         | client residual — its faithful form `< D OR >= D+1day` is an OR |

A bound carrying an explicit time-of-day keeps full precision; `isDateOnlyWireValue` mirrors the
evaluator's `compileDateBound`/`isDateOnlyFilterValue` so the two decide "is this date-only"
identically.

`equals`/`not_equals` are the exception to that exception: `compileSingleCondition` runs both sides
through `toDayComparable` **unconditionally**, so they are day-granular even for a value carrying a
time.

**One normalization policy underneath all of it.** L1 canonicalizes a `date` field via local Y/M/D
components (so ingestion does not day-shift for viewers ahead of UTC) and a `datetime` field via
`toISOString()` (so a zone-less `'2026-03-04T23:30:00'` becomes a real UTC instant — the point, not
a bug). `toComparable`'s `date` branch routes through the same `normalizeToDateOnlyString` L1 uses,
because rows that bypassed L1 (a foreign row in a cross-filter semi-join, an L4 re-filtered anchor
row) can still carry a raw local-time `Date`.

### 5. Join-key coercion

**One policy, `normalizeJoinKey` (`joinKeys.ts`), for every cross-source path** — chart grain
re-anchoring, filter semi-joins, grid fan-out dedup, display-column enrichment:

- `null`/`undefined`/object → `null`, and a `null` key never indexes and never matches. An unlinked
  FK contributes nothing rather than colliding with an empty PK.
- `Date` → its ISO string, so two equal instants join regardless of identity.
- everything else → `String(value)`, which is what makes `5` and `'5'` the same key.

This used to be two policies. `gridGrouping.ts` and `crossSourceEnrichment.ts` coerced with
`String(x ?? '')` while `dataSourceGraph.ts` and `chartAggregation.ts` used the raw runtime value as
a `Map` key — so a numeric FK against a string PK joined in the grid and silently failed in the
chart, and the same relationship produced different numbers depending on widget kind.

### 6. Cross-source filter conjunction

**Filters targeting one foreign source are grouped and evaluated conjunctively in a single
semi-join: `EXISTS(A₁ AND A₂)`.**

Evaluating each with its own semi-join gives `EXISTS(A₁) AND EXISTS(A₂)`, which is strictly weaker —
two filters that no single foreign row satisfies together still pass, because different rows can
satisfy them separately. SQL does the same thing, and the wire's `SemiJoinDescriptor` groups
predicates by foreign source for exactly this reason.

**A reference across a one-to-many relationship is never a JOIN.** From the "one" side a `LEFT JOIN`
fans the row set out, so a `SUM(lifetime_value)` KPI reads 3× where the in-memory semi-join reads
1×. As a _filter_ the wire emits a semi-join, which is the same answer; every other use (display
column, `groupBy`, aggregation source) has no faithful wire form and is dropped with a visible
warning.

### 7. Aggregation

`aggregateCellValues` (`aggregate.ts`) is the single place that decides what each aggregation NAME
means over a row set. Names matter here because SQL's differ:

| Studio                  | Meaning                                 | SQL equivalent           |
| :---------------------- | :-------------------------------------- | :----------------------- |
| `count`                 | `values.length` — every row             | `COUNT(*)`               |
| `count_non_null`        | non-null entries                        | `COUNT(column)`          |
| `count_distinct`        | distinct **raw** values, nulls excluded | `COUNT(DISTINCT column)` |
| `sum`/`avg`/`min`/`max` | over coerced, null-skipped values       | same                     |

**Empty-set policy:** `sum` → `0` (the additive identity, and what every SQL engine and spreadsheet
gives); `avg`/`min`/`max` → `null`. Returning `0` there _invents_ a data point — an all-null Oslo
temperature bucket plotted at 0 °C, sorting above a real −4 °C Rome under a Top-N.

**`count_distinct` is measured over RAW values, never the numeric coercion.** Routing it through the
numeric path collapses a distinct count over a string column to `0`, because every non-numeric
string coerces away.

Three of these have no faithful pushdown and are handled by
`aggregationPushdown.ts`'s shared ladder rather than by this document — see rungs 4 and 5 in
[the register](#the-degradation-register).

## The degradation register

Everything the wire cannot express faithfully, and what happens instead. This is the honest core of
the contract: the push-down path's guarantee is **"degrades visibly, never silently wrong"**, and
this table is what that guarantee amounts to.

### Routed to the client residual (the answer stays correct)

`isLeafServerTranslatable` refuses these, and `applyFilters` re-applies them against the response.

| Leaf                                                                                 | Why the wire cannot be faithful                                                                                            |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `contains` / `starts_with` / `ends_with`                                             | SQL `LIKE` is case-sensitive; Studio's are not                                                                             |
| `does_not_contain`, `not_starts_with`, `not_ends_with`, `not_in`                     | no wire equivalent                                                                                                         |
| `is_empty` / `is_not_empty`                                                          | no `IS NULL` wire form                                                                                                     |
| `not_equals` on a `date`/`datetime` field                                            | its faithful form `< D OR >= D+1day` is an OR                                                                              |
| `equals` on a date whose value is not a calendar day (epoch, `Date`, non-ISO string) | cannot be reduced to a day pair                                                                                            |
| any leaf whose two conditions are OR-ed                                              | the wire predicate set is AND-combined; pushing it would AND them and return zero rows                                     |
| any `logic: 'or'` group                                                              | same, at group level                                                                                                       |
| empty `in: []`                                                                       | matches nothing in memory; the middleware drops an empty `in`, matching **everything** — the exact inversion               |
| open-ended `between` (one bound)                                                     | unbounded in memory; `whereBetween(col, [v, undefined])` is a binding error on Postgres and silently wrong on SQLite/MySQL |
| an incomplete condition (the drawer's `{ equals, '' }` add-filter default)           | no in-memory effect; pushed down it would empty a string column or error a numeric one                                     |
| a boolean value other than the strings `'true'`/`'false'`                            | no equally certain coercion exists, and a guess inverts (below)                                                            |

**The boolean case is worth its own paragraph**, because the failure is a silent inversion rather
than a missing row. The drawer stores a boolean condition's value as the STRING `'true'`/`'false'`,
which the in-memory evaluator compares as `String(row[field]) === value` — correct. Bound to SQL as
a string it is not: PostgreSQL implicitly casts `'true'`, but MySQL (`tinyint(1)`) and SQLite
coerce it NUMERICALLY to `0`, so `col = 'true'` returns exactly the rows where the flag is
**false** — the complement of the question. `coerceWireBoolean` converts the two recognised
spellings to real booleans before they go down; anything else on a boolean field falls to the
residual rather than shipping a guess that inverts on one engine and not another.

### Pushed down anyway, with a runtime warning (the answer can differ)

**Exactly one entry, and it is meant to stay that way.** The conformance suite asserts the count, so
adding a second is a decision someone has to argue for rather than a commit.

| Leaf                             | Divergence                                                     | Why pushed anyway                                                                                                                                                                                                       |
| :------------------------------- | :------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_equals` on a non-date field | SQL 3VL excludes NULL rows; the in-memory evaluator keeps them | Common and high-selectivity. Routing it client-side would defeat the pushdown, and for an aggregated widget it would drop the filter entirely — the predicate's own column is absent from a one-row-per-group response. |

Announced through `warnAdapterDivergence`, once per build, in every environment.

### Aggregation stripped, raw rows fetched (`aggregationPushdown.ts`)

Each rung means "the server's answer cannot be repaired client-side", never "the server would be
slower". When one fires, the aggregations are stripped and the widget's own always-on client
aggregation produces the number.

1. An unpushable filter — a server-aggregated response is one row per group, so the residual's
   column is absent and could not run at all.
2. An incoming cross-filter or interactive selection — same shape.
3. A rank (Top-N) filter — its client-side reduction sums the rank measure per group and needs raw
   rows.
4. `count` / `count_distinct` — the wire `count` is `COUNT(column)`, which skips NULL measures,
   while Studio's `count` is `COUNT(*)`; and the protocol has no DISTINCT form at all.
5. `avg` at a server grain finer than the client's — the middleware derives its GROUP BY from the
   projection, so any projected column outside the client's `groupBy`, or any `xGroupBy` bucketing
   the wire cannot transmit, turns the re-aggregation into an unweighted average of averages.

### Warned, not resolved

- A cross-source reference across one-to-many or many-to-many used as a **display column**,
  `groupBy` or aggregation source — in memory those pick one representative related value per row, a
  choice SQL cannot make without a rule nobody declared.
- A filter on an arithmetic expression field — no server column exists.
- A cross-source filter leaf carrying no `filterSourceId` — both documents are valid and the adapter
  cannot know which the author meant, so it announces rather than guesses. Reachable, not
  hypothetical: the AI middleware's `add_page_filter` stores `''` when the model omits `sourceId`.

## How the contract is enforced

`EXECUTION_CONFORMANCE_CASES` in `@mui/x-studio-schema` is the corpus: a row set, a filter, the ids
that must survive, and — crucially — **where the leaf is contracted to run**.

The suite runs each case three ways:

1. **The in-memory path answers what the contract says.** Run first and separately, so a case whose
   expectation is simply wrong fails as "the contract is wrong" rather than as "the engines
   disagree".
2. **Both paths agree.** The real `createBatchingAdapter`, the real `handleBatchQuery`, and the real
   residual — the only stand-in is the database.
3. **Each leaf runs where the contract says.** This is the assertion that survives a forgiving test
   double. `createMockDb`'s `LIKE` is case-_insensitive_, so a `contains` leaf translated to `LIKE`
   would agree with the mock and be wrong on Postgres. Pinning the disposition catches that on the
   day someone widens translation, not on the day a user reports a number.

Adding a rule here without adding a case there leaves it unenforced, which is the state this
document exists to end.

**It has already paid for itself once.** The known-divergence case asserts that the divergence still
EXISTS — that the contract is not carrying an exemption for a problem that quietly went away — and
it failed on the first run. Not against the product: against `createMockDb`, which did not model SQL
three-valued logic. Its `!=` returned JS's answer (`null != 'open'` is `true`) and its ordering
operators let `null` coerce to `0`, so the mock reported the two engines as agreeing on the exact
case where they are documented not to. Every other test in the package passed either way, because
none of them put a NULL row through a comparison. The mock now guards every scalar comparison with
`sqlComparable`.

## Deliberately out of scope

- **Rank (Top-N) filters and `RelativeDateValue`s** have no wire representation at all. Rank is
  applied exactly once — at L3 or post-aggregation, never both, never neither
  (`shouldApplyWidgetRankAtL3`) — and a relative date is resolved to a concrete bound before a
  descriptor is built. There is no second implementation to conform to.
- **Aggregation push-down decisions** are governed by `decideAggregationPushdown`, which both
  adapters already call. It is one implementation, so a corpus would be testing itself; the ladder
  is documented above instead.
- **SQL dialect fidelity.** The conformance suite proves the two _semantics_ agree, not that Knex
  emits correct Postgres. That is `queryBuilder.ts`'s own suite.
