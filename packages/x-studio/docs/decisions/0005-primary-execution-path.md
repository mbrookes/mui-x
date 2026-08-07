# 0005 — Which execution engine is primary

**Status:** Open. Raised 2026-08-07. **Every pipeline feature pays the two-implementations tax
until this is answered.**

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

**Open**, with a recommendation: **option 3 is worth doing regardless of whether option 2 ever
happens.** It is the part of option 2's value that does not require the refactor, and if option 2
is later taken, the conformance suite is the specification it would be built against.

What must not happen is the current state persisting by default: two engines, a known-good list of
divergences scattered across `warnAdapterDivergence` call sites and doc comments, and no artifact
that says what correct means.

## Consequences

**Of answering (any option):** a new pipeline feature has one obvious place to be defined, and a
reviewer can tell whether the SQL path implements it or declines it.

**Of option 1 stated explicitly:** the tax is accepted knowingly, and the conformance gap becomes
a documented risk rather than a surprise. This is a legitimate answer.

**Of not answering:** the divergence surface grows with every feature, and each one is discovered
the same way — a number that differs between two hosts running the same dashboard, reported as a
bug against whichever path the reporter happened to be on.

Corresponds to finding A5 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
