# 0004 — Where the semantic model lives

**Status:** Open. Raised 2026-08-07. **Cheap while dashboards are unpublished; a data migration
across every stored document afterwards.**

## Context

`StudioDoc` carries `relationships`, `expressionFields` (calculated columns and measures), and
per-source field metadata. These are a **semantic model**: the definitions of what the business
data means — what "revenue" is, how orders join to customers, which fields are dimensions and
which are measures.

They live inside each dashboard document.

**The consequence.** Two dashboards over the same warehouse redeclare the model independently.
There is no shared definition of a measure, no versioning of the model apart from the dashboard,
and no way for an organization to say "revenue is defined here, once". Fix a join in one dashboard
and every other dashboard keeps the old one — silently, because a wrong join produces numbers, not
errors.

**This is the well-known fork in BI architecture**, and both branches are legitimate:

- **Workbook-embedded model** (Tableau's classic shape): the model travels with the artifact. Fast
  to author, no infrastructure, diverges across artifacts.
- **Shared semantic layer** (Looker/LookML, Cube, dbt metrics): the model is a separately
  versioned artifact that dashboards reference. Governed, consistent, requires a modeling step and
  someone to own it.

x-studio has taken the first branch. There is no evidence it was chosen — the fields were added to
`StudioDoc` because that is where dashboard state lives, which is a perfectly good reason to put a
field somewhere and not a reason to pick a BI architecture.

**Why it matters more here than it would elsewhere.** `AI_ASSISTANT_RESEARCH.md`, line 61, the
team's own competitive analysis:

> **Semantic Layer as AI Governance** — Everyone is racing to own the semantic/business logic layer
> as the anti-hallucination foundation. AI agents that query raw SQL hallucinate; those grounded in
> a governed semantic layer don't.

The research identifies the shared semantic layer as the strategic ground; the architecture embeds
the model per-dashboard with no path to a shared one. Whether that gap is urgent depends on
ADR 0003.

## Options

1. **Stay embedded.** Zero work. Accepts model divergence as a property of the product, which is
   defensible for a self-serve authoring tool and indefensible for a governed enterprise one.
2. **Give the model its own identity, keep it inline by default.** Introduce
   `StudioSemanticModel` in `x-studio-schema` and have `StudioDoc` **reference** it rather than
   contain it, with an inline model as the default so today's authoring experience is unchanged.
   The dashboard gains a `semanticModelId`; the resolution step gains one indirection. This is a
   schema change plus a migration today.
3. **Full shared semantic layer now.** A separately versioned artifact, an authoring surface for
   it, and a resolution/permission story. Weeks of work and a product decision about who owns the
   model, which is exactly the decision ADR 0003 hasn't made.

## Decision

**Open**, with a recommendation: **option 2 is the move that costs least and forecloses least.**
It is not a commitment to the shared-layer branch — it is the schema shape that leaves that branch
open, taken at the only moment it is cheap.

## Consequences

**Of option 2 now:** one `CURRENT_SCHEMA_VERSION` bump, one migration keyed by the previous
version, and a fixture test — the repo already has the machinery and the convention
(`CLAUDE.md`, "Schema migrations"). The `applyMutation` reducer gains an indirection on the
relationship and expression-field handlers.

**Of option 2 later:** the same schema change, plus a data migration across every dashboard stored
by every host — including hosts running an older `@mui/x-studio` — with no way to reach documents
that have already been exported to JSON.

**Of option 1 permanently:** the product is a workbook tool. That is a real product with real
customers, and it should be stated in the requirements rather than inferred from a field's
location.

Corresponds to finding A4 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
