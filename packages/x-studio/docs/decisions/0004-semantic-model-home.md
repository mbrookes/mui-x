# 0004 — Where the semantic model lives

**Status:** **Option 2 accepted, 2026-08-09. Implemented.** The semantic model has its own
identity and stays inline by default. Taken at the point [ADR
0003](./0003-ai-assistant-product-scope.md) made it urgent — a governed semantic layer is the
anti-hallucination substrate an AI-native product rests on — and while it was still free.

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

**Option 2. The model has its own identity; it stays inline by default.**

Not a commitment to the shared-layer branch — it is the schema shape that leaves that branch open,
taken at the only moment it was free.

`StudioDoc.relationships` and `StudioDoc.expressionFields` are replaced by
`StudioDoc.semanticModel: StudioSemanticModel`, which carries an `id`. That id is the entire
mechanism: two documents naming the same model are asserting they mean the same thing, so a host can
register one under `runtime.semanticModels` and both resolve to it, with no edit to either document.
`resolveSemanticModel(state)` is the one indirection, and the inline model is never deleted when
overridden — an exported dashboard is still self-contained and still opens in a host with no
registry.

**No schema version bump.** x-studio is unpublished, so there is nothing in the field to migrate;
the ADR's original cost estimate assumed otherwise. `deserializeState` does read the pre-ADR
top-level arrays and warn, which is not a compatibility promise — it exists so a developer with a
dashboard saved from last week's build does not silently lose every join and calculated field, and
it heals on the next save.

### What implementing it revealed

**Editing a host-provided model had to be refused, not quietly dropped.** The reducer writes to the
document's own model, so with a host model in effect an accepted edit lands where nothing reads:
the author changes a join, saves, and the dashboard is unchanged with no explanation. The controller
now declines those six mutations with a new `external-semantic-model` rejection reason and a dev
warning. Editing a shared model needs a permission and versioning story — that is option 3 — and
inventing one silently inside a setter is how a governed model stops being governed.

**The rejection-reason union was duplicated by hand.** `filterDrawerUtils` (engine) re-typed it
because store imports engine and so engine cannot import store. Adding a member broke five call
sites with a type error rather than silently falling through to a generic message — the good outcome
of a bad arrangement. The union now lives in `x-studio-schema`, where both layers can see it.

## Consequences

**Realized:** the model is nameable, so a shared layer is now a host feature rather than a schema
change. The reducer gained one indirection on the model handlers. Every read site that had a
`StudioState` moved to `resolveSemanticModel(state)`; sites that legitimately concern the DOCUMENT —
serialization, screening — still read `doc.semanticModel` directly, which is the distinction that
makes the override safe.

**Still open (option 3):** an authoring surface for a shared model, a permission story, versioning
of a model apart from its dashboards, and editing a host-provided model. None of it is foreclosed,
and none of it is built.

**Of having done this later:** the same schema change, plus a data migration across every dashboard
stored by every host — with no way to reach documents already exported to JSON.

Corresponds to finding A4 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
