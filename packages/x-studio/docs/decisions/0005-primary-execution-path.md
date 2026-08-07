# 0005 — Which execution engine is primary

**Status:** Open on the primary-path question. **Option 3 accepted and implemented, 2026-08-07** —
the contract is written down and enforced. The remaining question is which engine is authoritative,
not what correct means.

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

**Option 3 is done. Options 1 vs 2 remain open.**

Option 3 was worth doing regardless of whether option 2 ever happens: it is the part of option 2's
value that does not require the refactor, and if option 2 is later taken, the conformance suite is
the specification it would be built against. What must not persist by default is the state this
found — two engines, a list of divergences scattered across `warnAdapterDivergence` call sites and
doc comments, and no artifact saying what correct means.

**What was built:**

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

## Consequences

**It found a real defect on its first run.** The known-divergence case asserts the divergence still
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
