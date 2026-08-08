# 0005 — Which execution engine is primary

**Status:** **Option 2 accepted, 2026-08-08.** The query descriptor is the execution contract.
Option 3 (the written contract and its conformance corpus) shipped first, on 2026-08-07, and is the
specification this was built against. Stage 1 — the capability model, the shared planner, and a
descriptor-shaped entry point into the in-memory engine — is implemented. Stage 2 is noted at the
end.

## Context

The same dashboard has two execution paths, chosen by host configuration:

- **In-memory** (default): the whole dataset in the browser, through the four-layer pipeline —
  L1 normalize, L2 enrich with computed fields, L3 filter with scoping and cross-source
  semi-joins, L4 re-anchor to chart grain — then widget-level aggregation.
- **Push-down** (optional): a `StudioQueryDescriptor` to `createBatchingAdapter` →
  `x-studio-data-middleware` → SQL, with joins, filters, aggregation and HAVING built server-side.

These implement overlapping semantics in two languages, and **there is no single artifact defining
what the answer should be.** The query descriptor is the closest thing, but the L1–L4 layers have
no counterpart in the SQL builder: the normalization rules, the join-key coercion policy, the
numeric coercion policy, the cross-source semi-join conjunction rule. Parity is asserted by tests
at specific points — `useWidgetRows`'s sync/adapter parity test is a good one — rather than
guaranteed by construction.

The engine is honest about this where it can be. `createBatchingAdapter` partitions its filter
tree per leaf and asks whether each can be expressed as a wire predicate with **exactly** the
in-memory evaluator's semantics; anything else is re-applied client-side with a dev warning, and
`aggregationPushdown.ts` is a single shared five-rung ladder rather than two copies. That
discipline is why the divergences are known and warned about rather than silent. It is not a
substitute for one definition of the answer.

**The structural oddity:** the in-memory path is the default and SQL is the optimization, which
inverts the usual arrangement for an analytics product and puts a hard ceiling on data volume in
the common case.

## Options

1. **In-memory stays primary; SQL stays the optimization.** Status quo. Every new pipeline feature
   is written twice — once in the L1–L4 layers, once in the SQL builder — and a parity test is
   written by hand for each. The tax is real and recurring, and it is paid in the place where
   divergence is hardest to see (a wrong number, not an error).
2. **Make the query descriptor _the_ execution contract**, with the in-memory pipeline as one
   implementation of it — the local/no-backend one. Parity becomes structural: a feature is
   defined once in the descriptor and each backend implements it or declines it explicitly. A
   significant refactor, and it may well not be worth it.
3. **Keep both, but write down the contract.** Extract the semantics the two paths must agree on
   — normalization, join-key coercion, numeric coercion, semi-join conjunction, date granularity —
   into one document and one shared conformance suite that both paths run. Does not restructure
   anything; converts "asserted at specific points" into "checked at every point that matters".

## Decision

**Option 2. The descriptor is the contract; the in-memory pipeline is one implementation of it.**

Option 3 shipped first and was not wasted: it is the specification option 2 is built against. What
follows is what "make the descriptor the contract" turned out to mean concretely, because the
phrase understates where the work actually was.

### The judgement had to become a value

The interesting part was never "pass a descriptor to both sides". It was that **"which parts of
this descriptor may this executor run?" lived inside the one executor that needed it** —
`isOpValueServerTranslatable`, `isLeafServerTranslatable`, `partitionFilterNode` and a private
aggregation ladder, all inside `createBatchingAdapter`. Three consequences, all structural:

- A second backend would have re-derived every one of those judgements.
- Adding a `StudioFilterOperator` compiled everywhere and fell through `mapOperator` to "unmapped"
  — correct by accident, and only for the wire.
- The in-memory engine could not be described at all. It is an executor too, and the most capable
  one, but there was nowhere to say so — which is precisely why the two were parallel
  implementations rather than one contract with two conformers.

So the knowledge became a value: `StudioQueryCapabilities`, declared per executor in
`@mui/x-studio-schema`, and `planQueryExecution` in the engine as the one splitter that reads it.
Nothing in the planner knows what a wire predicate looks like. **Encoding stays with the executor**
— `leafToPredicates` is still the adapter's own, because a `FilterPredicate` is the wire's spelling
and nobody else's.

### The fail-closed guarantee

`operators` is declared `satisfies Record<StudioFilterOperator, boolean>`. Adding an operator to the
union now breaks **every** executor's declaration until each one says yes or no — the same pattern
the widget registry uses, applied to the thing that was previously correct by accident. The same
holds for aggregations, and for the interface itself: a new capability is a compile error in every
declaration, so "we forgot to consider the SQL path" stops being a way for a feature to ship.

`LOCAL_QUERY_CAPABILITIES` declares everything `true` — by definition, not coincidence, since the
contract is written from that engine's behaviour. That is the invariant the whole arrangement rests
on: the planner can only route a declined leaf somewhere because one executor always accepts
everything. A conformance test asserts it, and `executeLocalQuery` dev-warns if it is ever violated.

### One honest asymmetry, declared rather than hidden

`LOCAL_QUERY_CAPABILITIES.aggregationPushdown` is `'none'` — the local executor returns rows and
the caller aggregates them. That is a division of labour, not a gap: `aggregateCellValues` is
already the single definition of what each aggregation name means, so an executor that also
aggregated would be a second implementation of exactly the thing this contract exists to prevent.
The field is shaped `'none' | Record<…>` rather than a plain record so this can be _said_ instead of
faked with seven `false`s that would read as a limitation.

Option 3 shipped a day earlier, deliberately: it is the part of option 2's value that does not
require the refactor, and it is the specification option 2 was then built against. The state it
replaced is what must not return — two engines, a list of divergences scattered across
`warnAdapterDivergence` call sites and doc comments, and no artifact saying what correct means.

**What option 3 built, and stage 1 kept:**

- [`EXECUTION_SEMANTICS.md`](../EXECUTION_SEMANTICS.md) — the normative contract. Seven rules
  (numeric coercion, null semantics, case sensitivity, date granularity, join-key coercion,
  cross-source conjunction, aggregation naming) and a **degradation register**: every leaf shape the
  wire cannot express faithfully, what happens instead, and why.
- `EXECUTION_CONFORMANCE_CASES` in `@mui/x-studio-schema` — the contract as data. It lives in the
  zero-dependency package so both sides can read it without either importing the other.
- `executionConformance.test.ts` in `x-studio-data-middleware` — runs every case through the real
  adapter, the real handler and the real client-side residual. The only stand-in is the database.

**The design decision inside the decision: each case pins a DISPOSITION, not just an answer.**
Agreeing on the answer is necessary and not sufficient. A leaf can return the right rows on both
paths today and still be a latent divergence, because HOW the wire handled it decides whether it
stays right — a `contains` translated to SQL `LIKE` agrees with the case-insensitive in-memory
version only while the fixture happens to use matching case. So each case declares whether the leaf
is contracted to be pushed down or held as a client residual, and the suite asserts it. A case
flipping from residual to pushed-down is the regression that catches someone widening translation
past what SQL can honour.

**The known-divergence category is capped at one entry, by a test.** `not_equals` on a non-date
field: SQL three-valued logic drops NULL rows, the in-memory evaluator keeps them, and it is pushed
anyway because routing it client-side would defeat the pushdown and, for an aggregated widget, drop
the filter entirely. Raising that cap is where a second "we ship a wrong answer on purpose" has to
be argued for rather than committed.

### Stage 2, not done here

`useWidgetRows`' sync path still calls `selectFiltersForWidget` → `resolveRows` directly instead of
building a descriptor and handing it to `executeLocalQuery`. Until it does, the descriptor is the
contract at the execution boundary but not yet the ONLY road to rows.

Deliberately separate. That hook carries three row baselines, their paired filter sets, a
`useDeferredValue` window whose pairing is load-bearing, and the `'none'`-mode baseline rule that
has to hold at three levels — behind ~2,400 tests. Rewiring it is plumbing that follows from this
decision rather than part of making it, and folding it in would have made a reviewable change
unreviewable.

What stage 1 already guarantees without it: both engines are entered through a descriptor, the
split is one shared function of a declared capability set, and a new operator cannot ship without
every executor declaring what it does with it.

## Consequences

**Stage 1 found a latent bug the moment the two paths shared an input.** Routing the in-memory side
through the descriptor made `leafToFilterState`'s missing `scope` field throw immediately, in
`resolveRows`. The adapter's residual had never noticed, because `applyFilters` does not read
`scope` at all — so the defect was latent for exactly as long as the two paths took different
inputs. That is the class of bug a shared contract removes rather than catches.

**Option 3 found a real defect on its first run.** The known-divergence case asserts the divergence still
EXISTS — that the contract is not carrying an exemption for a problem that quietly went away — and
it failed. Not against the product: against `createMockDb`, the test double every read-path test in
`x-studio-data-middleware` runs on, which did not model SQL three-valued logic. Its `!=` returned
JS's answer (`null != 'open'` is `true`) and its ordering operators let `null` coerce to `0`, so the
mock reported the two engines as agreeing on the exact case where they are documented not to. All
1,237 other tests in the package passed either way, because none put a NULL row through a
comparison. That is the shape of gap a conformance corpus exists to find, and a hand-written parity
test would not have: nobody writes a test asserting that a known bug is still a bug.

**Of answering the remaining question (option 1 vs 2):** a new pipeline feature has one obvious
place to be defined, and a reviewer can tell whether the SQL path implements it or declines it.

**Of option 1 stated explicitly:** the tax is accepted knowingly, and the conformance gap becomes
a documented risk rather than a surprise. This is a legitimate answer.

**Of not answering:** the divergence surface grows with every feature, and each one is discovered
the same way — a number that differs between two hosts running the same dashboard, reported as a
bug against whichever path the reporter happened to be on.

Corresponds to finding A5 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
