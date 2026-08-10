# x-studio system architecture review

> **Scope:** the shape of the system — package boundaries, where computation lives, what the
> product commits itself to — assessed against what this product is trying to be.
>
> **Not** a code review, and deliberately not the same document as
> [`ARCHITECTURE_ASSESSMENT.md`](./ARCHITECTURE_ASSESSMENT.md). That one asks whether the code is
> organized well **inside** the architecture: which module owns a helper, whether a contract is
> shared, whether a file has one concern. Useful, and largely closed. But every finding in it is
> one an experienced developer would raise in review, and none of them would change if the
> fundamental shape of the system were wrong.
>
> This document asks the other question: **is the shape right?** It takes the product definition
> in [`AG_STUDIO_CLONE_REQUIREMENTS.md`](./AG_STUDIO_CLONE_REQUIREMENTS.md) as the statement of
> intent and asks whether the structure serves it.

## Contents

- [Method, and why the previous assessments missed this](#method-and-why-the-previous-assessments-missed-this)
- [What the product is supposed to be](#what-the-product-is-supposed-to-be)
- [Verdict](#verdict)
- [A1 — The package boundary does not serve the multi-framework requirement (CLOSED)](#a1--the-package-boundary-does-not-serve-the-multi-framework-requirement)
- [A2 — There is no commercial tiering seam](#a2--there-is-no-commercial-tiering-seam)
- [A3 — The largest subsystem is the one the MVP excludes](#a3--the-largest-subsystem-is-the-one-the-mvp-excludes)
- [A4 — The semantic model has no home of its own](#a4--the-semantic-model-has-no-home-of-its-own)
- [A5 — Two execution engines, one missing contract](#a5--two-execution-engines-one-missing-contract)
- [A6 — Integration is two handlers, not a versioned contract (CLOSED)](#a6--integration-is-two-handlers-not-a-versioned-contract)
- [What is genuinely well-architected](#what-is-genuinely-well-architected)
- [The root cause: no decisions are recorded](#the-root-cause-no-decisions-are-recorded)
- [Recommended order](#recommended-order)

## Method, and why the previous assessments missed this

The two prior assessments measured the codebase: import graphs, line counts, duplicated
predicates, layer edges. Those are code metrics, and they can only ever surface code problems.
Ask "which module should own `capTitle`" and you will get a defensible answer that leaves the
system's shape entirely untouched.

This review starts from the product requirements and works inward, asking of each major
structural decision: **was it decided, or did it happen?** A decision has an alternative that was
considered and rejected for a stated reason. Several of the most consequential properties of this
system have no such record — which is not the same as being wrong, but is what makes them
invisible to every review that starts from the code.

Every claim below is a measurement or a quotation, with the command or the file named.

## What the product is supposed to be

From `AG_STUDIO_CLONE_REQUIREMENTS.md`, the parts that constrain structure:

|       | Requirement                                                                                                               | Status in the codebase                                                  |
| :---- | :------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------- |
| §2.1  | "Framework-ready embedding strategy for React, **Angular, Vue 3, and vanilla JavaScript** hosts"                          | Unblocked — `@mui/x-studio-core` is the framework-agnostic half (A1)    |
| §8.4  | "Angular: wrapper/integration package. Vue 3: wrapper/integration package. JavaScript: framework-agnostic embedding API." | Not addressed                                                           |
| §9    | "MVP **excludes**: AI assistant."                                                                                         | Struck by ADR 0003 — AI is the product, not an exclusion (A3)           |
| §2.2  | "Out of scope (MVP): Multi-user real-time collaborative editing."                                                         | Deferred, and the current model forecloses it cheaply enough to be fine |
| §5 P5 | Principle: "Extensible architecture (future widgets, data backends)."                                                     | Widgets: genuinely achieved. Data backends: partly — see A5             |
| §2.1  | "Data modeling support for multiple sources, relationships, measures, and calculated fields"                              | Built, but with no home of its own — see A4                             |

Two of the six are structural requirements that the architecture does not currently serve, and
one is inverted. That is the substance of this review.

## Verdict

**The component architecture is good. The system architecture has not been designed — it has
accumulated.**

Inside the boundary that exists, the decisions are strong and were clearly made by someone who
knew what they were doing: a zero-dependency shared schema, one mutation reducer running on both
sides of the wire, a layered and separately cached pipeline, an extension model that treats
third-party widgets exactly like built-in ones. Those are the marks of good design, and the
previous assessments were right to say so.

But the boundaries **between** packages were drawn by implementation convenience rather than by
the forces acting on the product. `x-studio` is one 58,480-line package containing a
framework-agnostic engine, a React component library, and an application shell, because those
three things were written in that order into the same directory. No requirement asked for that
shape, and one explicit requirement is incompatible with it.

| #   | Finding                                                                   | Severity              | Cost now vs. later                                                               |
| :-- | :------------------------------------------------------------------------ | :-------------------- | :------------------------------------------------------------------------------- |
| A1  | Package boundary does not serve the Angular/Vue/JS requirement            | ~~High~~ **CLOSED**   | Done — `@mui/x-studio-core` is extracted and React-free.                         |
| A2  | No MIT/Pro/Premium tiering seam, unlike every sibling product             | **High**              | Cheap now. A breaking API change later.                                          |
| A3  | The MVP-excluded subsystem is the largest one built                       | ~~Medium~~ **CLOSED** | Done — ADR 0003 chose AI-native; §2.2/§9 corrected in place.                     |
| A4  | The semantic model is embedded per-dashboard with no path to a shared one | ~~High~~ **CLOSED**   | Done — ADR 0004: the model is named, inline by default, host-overridable by id.  |
| A5  | Two execution engines with no shared correctness contract                 | ~~Medium~~ **CLOSED** | Done — the descriptor is the execution contract, split by declared capabilities. |
| A6  | Host integration is two handlers, not a versioned contract                | ~~Low~~ **CLOSED**    | Done — both wires carry a version and a compatibility rule.                      |

## A1 — The package boundary does not serve the multi-framework requirement

**The requirement.** §8.4 asks for an Angular integration package, a Vue 3 integration package,
and a framework-agnostic JavaScript embedding API. §2.1 lists framework-ready embedding as in
scope.

**The structure.** `@mui/x-studio` is a single package of 58,480 non-test code lines whose
`package.json` peer-depends on `react`, `@mui/material`, `@emotion/react` and `@emotion/styled`.
An Angular host consuming it does not get a wrapper; it gets React in its bundle.

**The seam already exists.** The honest measurement is the RUNTIME import closure — which files
can be loaded without React — with `import type` erased, since a type-only edge costs nothing in
a bundle. (A first pass counting files that merely do not _directly_ import React reported 40%;
that number was wrong, because most of those files transitively reach React anyway.)

`scripts/checkReactFreeClosure.py` computes it and can be re-run:

```text
                        before   after steps 1-2
runtime-clean            18,740      23,820 code lines
engine dirs, clean       16,502      18,732   (83 of 98 files)
engine dirs, blocked      3,957       1,729   (15 files, all genuinely React)
```

The remaining fifteen are eight `.tsx` components, four `use*` hooks, the React context, the test
harness, and `widgetPresentation.tsx` — every one of them correctly belongs to the React binding
rather than the core.

By directory, the agnostic half is not scattered — it is almost exactly the engine:

```text
store/       1,742   StudioController, MutationHistory, runtimeTransforms
internals/  11,512   the four-layer pipeline, caches, aggregation, StudioPipeline
server/      1,652   createBatchingAdapter — the query/adapter path
utils/       1,123
models/        175
components/ 35,365   134 .tsx files — the React layer
```

`StudioController.ts` and `StudioPipeline.ts` import React **zero times**. `StudioPipeline` is
already documented as "the non-React pipeline façade". The engine and the UI are already
separable; nobody has drawn the package line where the code already divides.

> **Status: CLOSED. `@mui/x-studio-core` exists.**
>
> Two edges were doing all the blocking, and neither was essential:
>
> 1. **Locale text routed through a React module.** `DEFAULT_STUDIO_LOCALE_TEXT` and
>    `StudioLocaleText` live in `localeText.ts`, which is pure — but 34 files imported them from
>    `StudioUIConfigContext.ts`, which merely re-exports them and is a React context. Redirecting
>    those imports to the real source freed `locales/` (4,244 lines of i18n data) and three engine
>    modules. No logic changed.
> 2. **`widgetUtils.tsx` mixed pure helpers with icon components.** `StudioController` reaches
>    `inferWidgetTitles` through `widgetConfigSanitization`, and that helper shared a 1,098-line
>    file with `WIDGET_TYPES` and thirty icon imports — so the controller, and therefore the whole
>    engine, could not load without React. Split into `widgetUtils.ts` (22 pure declarations) and
>    `widgetPresentation.tsx` (8 that render or need a DOM node). No declaration was needed by both
>    halves, so the split required no duplication.
>
> Both fixes are ones a code-structure review would ask for on their own merits — a file with two
> concerns, an import path pointing at a re-exporter. They happened to be the two things standing
> between this package and a stated product requirement.
>
> **The package then followed.** 128 modules moved. `internals/` became `engine/` and `server/`
> became `adapter/`, since neither name means anything in a package that _is_ the engine:
>
> ```text
> packages/x-studio-core/src/       31,473 code lines, 87 files
>   engine/    17,717   the four-layer pipeline, caches, aggregation, chart shapes, StudioPipeline
>   locales/    4,923   i18n data
>   store/      3,617   StudioController, MutationHistory, runtimeTransforms
>   adapter/    3,215   createSimpleAdapter, createBatchingAdapter, aggregationPushdown
>   utils/      1,827
>   models/       135   re-exports of @mui/x-studio-schema
> ```
>
> Zero React, `@mui/material` or `@emotion` imports in its source. Its vitest config runs
> `environment: 'node'` deliberately, so the boundary is enforced on every commit rather than
> asserted in a doc — and it earned that immediately, catching `downloadCsv`/`exportGridToCsv`
> reaching for `document`. Those went back to the binding; the pure `buildCsvContent` stayed.
>
> Three decisions worth recording, because none was obvious going in:
>
> - **The widget-kind descriptor went to `x-studio-schema`, not to core.** The AI middleware
>   already carried a hand-maintained copy of the same shape, documented as something the client's
>   values "structurally satisfy at the app boundary". Both packages already depend on the schema,
>   so that — not core — is the one place both can read. `StudioCustomWidgetDef` extends
>   `StudioWidgetKindDescriptor` and adds only `component`/`setupPanel`/`icon`, so the public
>   `customWidgets` shape is unchanged.
> - **Six curated subdirectory barrels, not deep paths.** The repo's eslint bans `@mui/*/*/*`, so
>   one subpath segment is the most an import may carry. 428 import sites collapsed onto them.
> - **A barrel surfaces collisions a directory hides.** `isRelativeDateValue` existed twice with
>   deliberately different strictness — loose on the evaluation path, strict on the authoring path.
>   They coexisted only because they sat in different files. The authoring one is now
>   `isStrictRelativeDateValue`, and the divergence is documented rather than accidental.
>
> `store/StudioController.crossLayer.test.ts` pins the two rules the binding still re-derives
> (`getWidgetMinSpan`, `createChatTurnMutationLedger`) against core's own answer. tsc clean across
> all five studio packages, eslint clean, 8,682 tests passing.

**What this costs.** Today: nothing visible, which is exactly why it has survived. At the first
Angular or Vue integration: a choice between shipping React inside a non-React host, or
extracting a core package _after_ `@mui/x-studio`'s 83 public exports have set — at which point
the extraction is a breaking change to a published API rather than a file move.

**The alternative.** `@mui/x-studio-core` (or `-headless`): controller, pipeline, adapter,
selectors — no React, no MUI. `@mui/x-studio` becomes the React binding over it, and Angular/Vue
packages become siblings of the React one rather than wrappers around it. This is the standard
shape for this problem and the one MUI itself uses elsewhere (`@mui/x-chat-headless`,
`base-ui`).

**Why it is High severity despite costing nothing today.** It is the only finding here whose fix
gets structurally harder every week, and it is load-bearing for a requirement the product has
already committed to in writing.

## A2 — There is no commercial tiering seam

Every other MUI X product of comparable scope ships tiered:

```text
x-data-grid   x-data-grid-pro   x-data-grid-premium
x-charts      x-charts-pro      x-charts-premium
x-tree-view   x-tree-view-pro
x-scheduler   x-scheduler-premium   (+ x-scheduler-internals, pre-release)
```

x-studio ships as `x-studio`, `x-studio-schema`, `x-studio-ai-middleware`,
`x-studio-data-middleware` — a functional decomposition with no tier boundary anywhere.

`x-scheduler` is the instructive comparison: it is not released yet either, and it **already**
has its internals and premium packages split. The tiering seam was drawn before the API set,
because that is when it is free.

**This is a business-model decision that the architecture has to encode.** Which capabilities are
the paid tier — cross-filtering? the AI assistant? the SQL push-down middleware? multi-page
dashboards? Whatever the answer, it has to fall along a package boundary, and there is currently
no boundary for it to fall along. Introducing one after `@mui/x-studio` is published means moving
public exports between packages, which is a breaking change for every consumer.

Nothing in `ARCHITECTURE.md` or `BACKLOG.md` mentions tiering, Pro, or Premium — verified by
grep. This one may simply not have been asked yet; it needs to be asked before release, not
after.

## A3 — The largest subsystem is the one the MVP excludes

> **Closed 2026-08-09 by [ADR 0003](./decisions/0003-ai-assistant-product-scope.md).** The product is
> AI-native: the AI subsystem is the differentiator, and AG Studio parity is a baseline rather than
> the goal. The requirements' §2.2 and §9 exclusions are struck in place, and both AG Studio
> documents now carry a header saying they are historical baselines rather than current scope.
>
> The finding was that the codebase and the requirements asserted different products with no
> artifact saying which was current. That is what has been fixed — the code did not move.
>
> **This raises A4 from Medium to High.** A governed semantic layer is the anti-hallucination
> substrate an AI-native product rests on, so where the semantic model lives stops being a tidying
> question. It remains cheap only while dashboards are unpublished.

Requirements §9, verbatim: **"MVP excludes: AI assistant."** §2.2 also lists "AI assistant and
natural-language authoring flows" as out of scope for MVP.

Measured:

```text
x-studio-ai-middleware        10,667 code lines   (a whole package)
+ StudioChatPanel (~18 files), the tool registry, the SSE adapter, richContext, generateInsight
```

The AI assistant is the single largest coherent subsystem in the product, and the majority of the
last fifty review rounds went into it.

**This is not automatically wrong.** The team's own `AI_ASSISTANT_RESEARCH.md` surveys the
competitive landscape and concludes AI is where this category is being decided. Choosing to
differentiate on AI rather than to clone AG Studio feature-for-feature is a legitimate — possibly
correct — strategic pivot.

**What is wrong is that the pivot is unrecorded.** The requirements document still says MVP
excludes it; the architecture document does not mention the change of direction; and every other
open question in this review depends on which product this is. If the answer is "an AI-native
dashboard builder", then A4 (the semantic model) becomes urgent rather than medium, because a
governed semantic layer is the anti-hallucination substrate the research doc itself identifies.
If the answer is "AG Studio parity with AI as a feature", then A1 and A2 dominate.

An architecture cannot be assessed against an intent nobody has written down. **This finding
costs no code to fix and blocks the correct prioritization of the others.**

## A4 — The semantic model has no home of its own

> **Closed 2026-08-09 by [ADR 0004](./decisions/0004-semantic-model-home.md).** The model now has an
> identity: `StudioDoc.semanticModel` carries an `id`, and a host can register one under
> `runtime.semanticModels` so every dashboard naming it resolves to one governed definition —
> without editing any of them. Still inline by default, so a dashboard remains self-contained.
>
> The finding was that the model was embedded with no PATH to a shared one. The path exists now; the
> shared layer itself (an authoring surface, permissions, versioning apart from the dashboard) is
> ADR 0004's option 3 and is deliberately not built.
>
> Taken without a schema version bump, because x-studio is unpublished and there is nothing in the
> field to migrate — which is exactly the window this finding said would close.

`StudioDoc` carries `relationships`, `expressionFields` (calculated columns and measures), and
per-source field metadata. These are a **semantic model**: the definitions of what the business
data means — what "revenue" is, how orders join to customers.

They live inside each dashboard document.

**The consequence.** Two dashboards over the same warehouse redeclare the model independently.
There is no shared definition of a measure, no versioning of the model apart from the dashboard,
and no way for an organization to say "revenue is defined here, once". Fix a join in one
dashboard and every other dashboard keeps the old one.

**This is the well-known fork in BI architecture**, and both branches are legitimate:

- **Workbook-embedded model** (Tableau's classic shape): the model travels with the artifact.
  Fast to author, no infrastructure, diverges across artifacts.
- **Shared semantic layer** (Looker/LookML, Cube, dbt metrics): the model is a separately
  versioned artifact that dashboards reference. Governed, consistent, requires a modeling step.

x-studio has taken the first branch. There is no evidence it was chosen — the fields were added
to `StudioDoc` because that is where dashboard state lives.

**Why it matters more here than it would elsewhere.** `AI_ASSISTANT_RESEARCH.md`, line 61, the
team's own competitive analysis:

> **Semantic Layer as AI Governance** — Everyone is racing to own the semantic/business logic
> layer as the anti-hallucination foundation. AI agents that query raw SQL hallucinate; those
> grounded in a governed semantic layer don't.

The research identifies the shared semantic layer as the strategic ground, and the architecture
embeds the model per-dashboard with no path to a shared one. That gap between stated strategy and
actual structure is precisely what an architecture review exists to surface.

**The cheap move now**, without committing to the full branch: give the semantic model its own
identity inside the schema — a `StudioSemanticModel` that a `StudioDoc` _references_ rather than
_contains_, defaulting to an inline copy. That is a schema change plus a migration today. Once
dashboards exist in the field it is a data migration across every stored document.

## A5 — Two execution engines, one missing contract

The same dashboard has two execution paths depending on host configuration:

- **In-memory** (default): the full dataset in the browser, through the four-layer pipeline —
  normalize, enrich with computed fields, filter with scoping and semi-joins, re-anchor to chart
  grain — then widget-level aggregation.
- **Push-down** (optional): a query descriptor to `createBatchingAdapter` →
  `x-studio-data-middleware` → SQL, with joins, filters, aggregation and HAVING built server-side.

These implement overlapping semantics in two languages, and **there is no single artifact that
defines what the answer should be.** The query descriptor is the closest thing, but the L1–L4
layers have no counterpart in the SQL builder: normalization rules, the join-key coercion policy,
the numeric coercion policy, cross-source semi-join conjunction. Parity is asserted by tests at
specific points — the `useWidgetRows` sync/adapter parity test is a good example — rather than
guaranteed by construction.

**The architectural question is which one is primary.** Right now the in-memory path is the
default and the SQL path is the optimization, which inverts the usual arrangement for an
analytics product and puts a hard ceiling on data volume in the common case. The alternative is
to make the query descriptor _the_ execution contract, with the in-memory pipeline as one
implementation of it (the local/no-backend one) — at which point parity is structural, and a new
pipeline feature has one obvious place to be defined.

That is a significant refactor and may well not be worth it. But it should be an answered
question, and the answer should be in the architecture doc, because every future pipeline feature
pays the two-implementations tax until it is.

> **Status: the correctness contract now exists; the primary-path question stays open.**
>
> [`EXECUTION_SEMANTICS.md`](./EXECUTION_SEMANTICS.md) specifies the seven rules both paths owe and
> carries a **degradation register** — every leaf shape the wire cannot express faithfully, what
> happens instead, and why. `EXECUTION_CONFORMANCE_CASES` in `@mui/x-studio-schema` encodes it as
> data; `executionConformance.test.ts` runs each case through the real adapter, the real handler and
> the real client-side residual, with the database as the only stand-in.
>
> Each case pins a **disposition** (pushed down vs client residual), not just an answer — because a
> leaf can return the right rows today and still be latent, and asserting only the answer would let
> a `contains` translate to a case-sensitive `LIKE` and pass. The "pushed down anyway, unfaithfully"
> category is capped at its one argued-for entry by a test.
>
> **It found a defect on its first run**, in `createMockDb` rather than the product: the mock did not
> model SQL three-valued logic, so it reported the two engines as agreeing on the exact case they
> are documented to disagree on. All 1,237 other tests in that package passed either way. Nobody
> writes a hand-rolled test asserting that a known bug is still a bug — which is the argument for a
> corpus.
>
> **The primary-path question is now answered too: option 2.** The `StudioQueryDescriptor` is the
> execution contract, and both engines are entered through one. The work was not "pass the same
> object to both sides" — it was that the judgement _which parts of this may this executor run?_
> lived inside the one executor that needed it. It is now a `StudioQueryCapabilities` value per
> executor and one shared `planQueryExecution` that reads it, so a second backend declares rather
> than re-derives, and `satisfies Record<StudioFilterOperator, boolean>` makes a new operator a
> compile error in every declaration until each says what it does with it.
>
> The in-memory engine declares everything `true` — by definition, since the contract is written
> from its behaviour — which is the invariant that lets the planner always route a declined leaf
> somewhere.
>
> Stage 2 (routing `useWidgetRows`' sync path through `executeLocalQuery`, so the descriptor is the
> only road to rows) is deliberately separate: that hook carries three row baselines and a
> load-bearing deferred-value pairing behind ~2,400 tests, and it follows from the decision rather
> than constituting it.
>
> Recorded as [ADR 0005](./decisions/0005-primary-execution-path.md).

## A6 — Integration is two handlers, not a versioned contract

The host wires up `handleAIChat(body, opts)` and `handleBatchQuery(body, opts)` itself. The wire
types are now shared through `x-studio-schema` — that was this session's work and it was the
right fix — but shared **types** are not a versioned **contract**.

There is no protocol version on either wire, so a host that upgrades `@mui/x-studio` without
upgrading its server (or vice versa) discovers the mismatch as a runtime validation failure
rather than as a refused handshake. For a library whose whole integration story is "run these two
handlers in your backend", independent client/server upgrade is the normal case, not the edge
case.

Low severity because nothing is broken and the fix is small — a version field on each wire
envelope plus a compatibility rule. It rises sharply the moment there is one external adopter,
because at that point the two sides genuinely do version independently.

> **Status: CLOSED.** `packages/x-studio-schema/src/wireProtocol.ts` owns two independent counters
> (`STUDIO_AI_WIRE_VERSION`, `STUDIO_DATA_WIRE_VERSION` — the wires change separately and are
> consumed by different servers), a `MIN_SUPPORTED`/`CURRENT` range rule, and one
> `checkStudioWireVersion` both handlers build their refusal from, so the two cannot drift in what
> they tell a host.
>
> A client NEWER than the server is refused, not accepted: it may send a field this server drops
> silently, which renders a dashboard from an incomplete query rather than failing visibly.
>
> The check runs after the "is this a request body at all" frame check and before every field
> check. Both halves of that ordering were chosen against a concrete failure — version-first
> misdiagnosed a host's broken route handler as a stale client, while field-first misdiagnosed a
> real skew as a malformed descriptor. `createSimpleAdapter` deliberately stamps nothing: its wire
> is the host's own protocol.
>
> Recorded as [ADR 0006](./decisions/0006-wire-protocol-versioning.md).

## What is genuinely well-architected

Stated plainly, because the findings above are about seams and could otherwise read as a negative
verdict on work that is mostly very good.

- **The shared schema package is the best decision in the system.** Zero runtime dependencies,
  verified rather than asserted, which is what lets the identical `applyMutation` reducer run in
  a browser and in Node. Both sides of the wire therefore cannot disagree about what a mutation
  did. Most products in this shape end up with two implementations and a permanent class of
  desync bugs.
- **The extension model is first-class, not bolted on.** Built-in widgets are registered through
  the same `StudioCustomWidgetDef` shape third parties use, so a custom widget gets the same
  capability flags, setup-panel slot, export hook and card chrome as the built-ins. This is rare
  and it is the right call.
- **The AI boundary is drawn correctly.** No LLM call in the client; the middleware owns the key,
  the prompt and tool execution; inbound wire data has one named validation choke point. The
  tool-execution model — plan a mutation, apply it through the shared reducer — is what makes AI
  edits and user edits provably the same operation.
- **The trust boundaries are real and consistently placed.** Untrusted input is capped and
  screened at named modules on both sides, and the server is correctly treated as untrusted by
  the client.

The engine/UI seam that A1 asks to be made into a package boundary **exists because this codebase
was written with discipline**. The core genuinely does not import React. That is why A1 is a
cheap fix rather than a rewrite.

## The root cause: no decisions are recorded

Every finding above has the same shape: a consequential structural property with no record of
having been chosen.

- Nothing states why `x-studio` is one package rather than core + bindings.
- Nothing states which tier any capability belongs to.
- Nothing states that AI moved from MVP-excluded to primary.
- Nothing states that the semantic model is dashboard-embedded by choice.
- Nothing states that in-memory is the primary execution path.

`ARCHITECTURE.md` is excellent at describing **how the code works** — 250 KB of accurate,
well-maintained mechanism. It is nearly silent on **why the system is shaped this way**, because
that was never its job. The result is that reviews of this codebase — including my previous two —
can only find mechanism problems, because mechanism is all that is written down.

**The concrete recommendation is an ADR log**: `docs/decisions/NNNN-title.md`, one per structural
decision, each stating the forces, the alternatives, the choice and its consequences. Six of them
retroactively, for the findings above. It is the cheapest possible intervention and it is the one
that makes the next architecture review possible.

> **Status: started.** [`docs/decisions/`](./decisions/) now holds six records — two Accepted (the
> engine/binding split, wire versioning) and four Open. An `Open` ADR is deliberate rather than a
> placeholder: it states the forces and every branch that was genuinely on the table, and says that
> nobody has chosen. That is worth far more than silence, because it is the artifact that stops the
> question being re-discovered from scratch by the next reviewer — which is what happened three
> times before this review.

## Recommended order

1. **Record the product intent (A3).** Which product is this — AG Studio parity, or an AI-native
   dashboard builder? Everything else is prioritized differently depending on the answer, and it
   costs nothing but a decision.
2. **Decide the tiering seam (A2)** and **extract the headless core (A1)**, in that order and
   before the public API sets. Both are cheap now and are breaking changes later. They interact:
   the tier boundary and the core/binding boundary should be chosen together.
3. **Give the semantic model its own identity (A4)** — as a referenced artifact with an inline
   default, which preserves today's authoring experience while leaving the shared-model branch
   open.
4. **Answer the primary-execution-path question (A5)** in writing, even if the answer is "the
   in-memory path stays primary and we accept the parity tax".
5. **Version the two wires (A6)** before the first external adopter.
6. **Start the ADR log** alongside (1), and backfill as each of the above is decided.

Nothing here is a rescue. The system is well built inside its boundaries; the finding is that the
boundaries themselves were never designed, and two of them are already in tension with written
requirements. All six are materially cheaper to address now than at any later point.
