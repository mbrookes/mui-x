# 0002 — Commercial tiering seam

**Status:** Open. Raised 2026-08-07. **A decision is needed before `@mui/x-studio` publishes.**

## Context

Every other MUI X product of comparable scope ships tiered, and the tier is a package boundary:

```text
x-data-grid   x-data-grid-pro   x-data-grid-premium
x-charts      x-charts-pro      x-charts-premium
x-tree-view   x-tree-view-pro
x-scheduler   x-scheduler-premium   x-scheduler-internals   x-scheduler-internals-premium
```

x-studio ships as `x-studio`, `x-studio-core`, `x-studio-schema`, `x-studio-ai-middleware`,
`x-studio-data-middleware` — a functional decomposition with no tier boundary anywhere.

`x-scheduler` is the instructive comparison. It is not released yet either, and it **already** has
its internals and premium packages split, in both the base and internals lines. The seam was drawn
before the API set, because that is when drawing it is free.

Non-test, non-comment source lines, so the candidate seams can be weighed by what they'd actually
move:

```text
x-studio                  39,070   the React binding
x-studio-core             19,479   the engine
x-studio-ai-middleware    10,660   the AI server handler
x-studio-schema            5,797   the shared data model
x-studio-data-middleware   4,712   the SQL push-down server handler
```

Nothing in any `ARCHITECTURE.md`, in `BACKLOG.md`, or in the requirements mentions tiering, Pro or
Premium — verified by grep. This may simply not have been asked yet.

## Options

The question is not "should there be a tier" — for a commercial MUI X product that is settled. It
is **which capabilities are paid, and therefore where the boundary falls**. Candidate seams, each
of which is a different product:

1. **AI assistant is the paid tier.** `x-studio-ai-middleware` plus `StudioChatPanel` (22 files,
   3,622 lines in the binding) move behind a licence. Clean to draw — the AI subsystem is already
   a package plus one component directory, with a narrow interface (`StudioAIConfig.endpoint`).
   Bets the commercial case on AI being the thing people pay for.
2. **SQL push-down is the paid tier.** `x-studio-data-middleware` and `createBatchingAdapter` go
   Premium; the in-memory pipeline stays MIT. Matches the data-grid precedent, where the
   scale-oriented features are the paid ones, and it is the seam a data-volume-driven buyer
   actually feels. Requires the adapter boundary to be genuinely swappable, which today it is.
3. **Authoring is paid, viewing is free.** `StudioDashboard` (embed, view-mode) MIT;
   `Studio` (full authoring UI, compose drawer, data drawer) Premium. The strongest seam
   commercially — it maps to seats — and the most expensive structurally, because authoring and
   viewing currently share the controller, the widget registry and most components.
4. **Per-capability, à la data grid.** Cross-filtering, multi-page dashboards, pivot, saved filter
   presets each assigned a tier. Most flexible, worst for the architecture: several of these are
   `StudioDoc` fields and reducer branches, not modules, so the boundary would run through the
   middle of `applyMutation` rather than between packages.
5. **Defer.** Ship MIT-only, tier later. Explicitly a decision, and it should be recorded as one
   if it is taken — see Consequences.

## Decision

**Open.** This is a business-model question that the architecture has to encode, and nobody has
recorded an answer. It should be decided together with ADR 0001's boundary: a capability that is
both Premium-only and engine-side needs the tier boundary and the core/binding boundary to agree,
and drawing them independently produces a package graph nobody wants.

## Consequences

**Of deciding now:** a package move while both packages are unpublished — file moves, an
`exports` map, a licence check. Days, not weeks.

**Of deferring past publication:** moving public exports between packages, which is a breaking
change for every consumer of `@mui/x-studio`. The x-scheduler team's choice to split before
release is the whole argument; they paid the cheap version of this cost deliberately.

**Of never deciding:** the product ships MIT-only and the tier conversation happens against a
frozen public API. That is a legitimate outcome, but it should be chosen rather than defaulted
into, because "we shipped before anyone asked" and "we decided not to tier" are indistinguishable
afterwards — which is the exact failure mode this log exists to prevent.

Corresponds to finding A2 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
