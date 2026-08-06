# x-studio architecture assessment

> **Scope:** the four x-studio packages — `x-studio`, `x-studio-schema`,
> `x-studio-ai-middleware`, `x-studio-data-middleware` — evaluated as a whole.
>
> **Question:** is the architecture fundamentally sound, fit for purpose, and consistent with
> best practice for its type (an embeddable analytics dashboard builder plus its server-side
> middleware)?
>
> **Not** a defect review. The ~50 review rounds that preceded this one examined behavior
> inside the design and are recorded in each package's `ARCHITECTURE.md`. This document
> examines the design itself. Every claim below is a measurement; the command that produced it
> is stated so it can be re-run and the number challenged.

## Contents

- [Verdict](#verdict)
- [What is structurally right](#what-is-structurally-right)
- [Issue 1 — the data wire contract has no single source of truth](#issue-1--the-data-wire-contract-has-no-single-source-of-truth)
- [Issue 2 — the "one reducer" invariant is half-realized](#issue-2--the-one-reducer-invariant-is-half-realized)
- [Issue 3 — StudioController is a god object](#issue-3--studiocontroller-is-a-god-object)
- [Why the review rounds could not find these](#why-the-review-rounds-could-not-find-these)
- [Recommended order of work](#recommended-order-of-work)

## Verdict

**Fundamentally sound and fit for purpose.** The load-bearing decisions — a zero-dependency
shared schema package, one mutation reducer for client and server, a layered and separately
cached row pipeline, a widget registry that treats third-party kinds exactly like built-in
ones — are the decisions a mature product in this class should make, and the dependency
structure is genuinely clean rather than merely documented as clean.

Three structural issues stand out. Two of them are the root cause of a visible share of what
the review rounds spent their effort on, which is the main reason this assessment is worth
having: those rounds were fixing recurring symptoms of causes they were not positioned to see.

| #   | Issue                                                                      | Severity | Shape of the fix                                |
| :-- | :------------------------------------------------------------------------- | :------- | :---------------------------------------------- |
| 1   | ~~Data wire contract defined independently on both sides~~ **CLOSED**      | High     | Extracted to `x-studio-schema/dataWireTypes.ts` |
| 2   | ~~25 of 42 controller write paths bypassed the shared reducer~~ **CLOSED** | High     | 44/0 reducer-routed; `commitDocPatch` deleted   |
| 3   | `StudioController` is a god object (1,896 code lines, 73 methods)          | Medium   | Three seams cut: 1,896 → 1,572                  |

## What is structurally right

### The dependency graph is clean and acyclic

Measured by parsing every non-test `import`/`export … from` in the four packages:

```text
x-studio                 -> x-studio-schema     34 imports
x-studio-ai-middleware   -> x-studio-schema     12 imports
x-studio-data-middleware -> (nothing internal)
```

No package cycles. The arrow runs toward the schema package and never back, which is what
makes a `StudioState` shape change a one-place edit.

### The schema package earns its existence

`@mui/x-studio-schema` has `"dependencies": {}` — verified, not asserted. Its single reference
to `@mui/x-chat-headless` is an `import type` and erases at compile time. That purity is what
allows the same `applyMutation` reducer to run in a browser bundle and a Node server, so the
two sides cannot disagree about what a mutation did. This is the best-motivated boundary in
the codebase.

### Layering discipline is real

Classifying every intra-`x-studio` relative import by directory layer
(`models` → `utils` → `store` → `context` → `internals`/`server` → `components`):

```text
825 cross-layer imports, of which 56 point "upward" — 6.8%
```

For a 343-file package that is genuine discipline. 21 of the 56 were a single known pattern —
the widget registry in `internals/` importing widget components — since resolved; see the note
under [issue 3](#issue-3--studiocontroller-is-a-god-object).

### Custom widgets are first-class

`BUILTIN_WIDGET_DEFS` registers every built-in kind using the **same** `StudioCustomWidgetDef`
shape consumers use for `customWidgets`, and `useWidgetDefMap()` layers custom defs over
built-in ones so every dispatch site resolves both through one path. A third-party widget gets
the same capability flags, export hook, setup-panel slot and card chrome as
`StudioChartWidget`.

Most products in this class make extensions second-class — a separate registration path, a
narrower prop surface, no access to the host's own affordances — and pay for it permanently.
This one did not, and it is the single best decision in the codebase.

### Caching is designed rather than accreted

L1/L2 cache on `WeakMap`s keyed by the source object, so cache lifetime follows data lifetime
with no manual invalidation. `StudioRequestCache` is a bounded LRU with explicit eviction
rather than a monotonically growing `Map`. Packaging is tree-shakeable
(`"sideEffects": false`, an `exports` map).

### The AI boundary is drawn in the right place

`x-studio` is UI-only: no LLM call happens in it. The middleware owns the API key, the system
prompt and server-side tool execution, and the client's trust boundary for inbound wire data
(`applyStateMutation.ts` → `parseStateMutation`) is a single named choke point rather than
scattered validation.

## Issue 1 — the data wire contract has no single source of truth

**The finding.** The batch-query protocol is defined twice, independently:

| Side   | Module                                                | Types                                                                                                                                                                                               |
| :----- | :---------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client | `x-studio-schema/src/dataTypes.ts`                    | `StudioQueryDescriptor`, `StudioFilterNode`, `StudioQueryResult`                                                                                                                                    |
| Server | `x-studio-data-middleware/src/security/queryTypes.ts` | `BatchQueryRequest`, `BatchWidgetDescriptor`, `FilterPredicate`, `JoinDescriptor`, `SemiJoinDescriptor`, `HavingPredicate`, `OrderBy`, `AggregationSpec`, `WidgetQueryResult`, `BatchQueryResponse` |

`x-studio-data-middleware` imports nothing internal at all. The two definitions are kept in
agreement by hand, backed by mirror assertions that each package asserts **in its own suite** —
which is precisely the arrangement that cannot fail until it is too late, because neither
suite can see the other side of the wire.

**The evidence that this costs real work** is the asymmetry with the AI protocol. That one
_is_ shared (`ai-middleware → schema`) and produced no equivalent class of bug. The data
protocol is not, and the final review round alone contains four defects that are the same
defect wearing different clothes:

- `03ad4f1f46` — client emitted wire aliases the middleware rejects fail-closed
- `2313a6b02f` — client emitted join `on` pairs in the wrong orientation
- `dda7ef93fe` — client sent batches over the server's per-request widget cap
- `5fde548271` — `MAX_WIDGETS_PER_BATCH` was a hand-kept copy on the client

That is not four defects. It is one missing module, reported four times, in one round.

**Why it happened.** The stated reason the client does not import the middleware is correct:
`x-studio` must not depend on a Node-only, Knex-peered package. But the conclusion drawn from
it — "so each side declares its own types" — skips the option that already works for the AI
protocol: put the contract in the zero-dependency package both sides already depend on.

**The fix.** A wire-protocol module in `x-studio-schema`, imported by the batching adapter and
by the middleware's validation boundary. The middleware gains a dependency on a zero-dependency
package; the client gains nothing it did not already carry.

**The same shape on the AI wire, found afterwards.** The AI protocol's _types_ are shared, which
is why this assessment held it up as the counter-example — but two of its _budgets_ were not.
`MAX_TOOL_OUTPUT_CHARS` (200,000) and `MAX_CONVERSATION_CHARS` (2,000,000) were defined in
`x-studio-ai-middleware` and mirrored by hand in `x-studio`'s SSE adapter, which decides how much
of a streamed tool result to store on the persisted chat message. The per-call mirror agreed. The
per-response one did not: it had been argued locally to 600,000 — "three at-server-cap results" —
against a server ceiling 3.3× higher, so a data-heavy agentic turn had its results clipped in the
browser _after_ the server had allowed them, and because the client's copy is what
`toOpenAIMessages` replays, the clipped text went back to the model as though it were whole.
Both constants now live in `x-studio-schema/aiWireLimits.ts` and the client derives from them,
with two tests asserting the mirror. Worth recording because it is issue 1 in miniature: sharing
the types of a protocol is not the same as sharing its contract, and a number held in agreement
by a comment is not held in agreement.

## Issue 2 — the "one reducer" invariant is half-realized

**The finding.** `StudioController` exposes 73 methods. Counting write paths:

```text
18  route through commitMutation/commitMutations -> the shared applyMutation reducer
26  bypass it via commitDocPatch
```

The entire justification for a shared reducer is that both sides of the wire apply identical
logic. More than half of the client's own write paths never reach it.

**What this produced.** Directly and by name:

- `938d01c5e6` — _"cascade dependsOn on the eight filter-drop paths that bypass the reducer"_.
  Eight client paths dropped filters without the referential-integrity cascade every
  reducer-routed drop performs.
- The same round had to **publish schema internals** — `pruneDependsOnAgainstSelf`,
  `isValidFilterScope`, `hasResolvableFilterAnchors` — so bypass writers could re-implement
  invariants the reducer already enforces. Publishing internals to let callers reproduce a
  guarantee is a strong signal the callers are on the wrong path.
- `c23441bb0f` — _"screen updateFilter / updateActivePage to their siblings' standard"_ —
  bringing two bypass writers up to the level their reducer-routed siblings get for free.

> **Status: CLOSED.**
>
> `mutationTypes.ts` defines `WireStateMutation` (acceptable from outside) separately from
> `InternalStateMutation` (client-only), with `StateMutation` their union.
> `parseStateMutation`'s validator table is keyed on the wire union alone, so an internal
> mutation is rejected fail-closed and adding one no longer widens the untrusted surface at all.
>
> All 25 bypass writers now route through the reducer — 16/25 became **44/0** — and
> `commitDocPatch` is deleted, so there is no longer a way to write the doc without a mutation.
> `docTransforms.ts` (a second pure-transform layer that ran alongside the reducer with the same
> signature and none of its uniformity) moved into the schema package and is now reached through
> the reducer rather than called directly.
>
> Two divisions of labor made this safe: **screening stays with the writer** when it owes its
> caller a reason the reducer cannot express, and **id minting stays with the caller** because the
> reducer must be a pure function of `(doc, args)`.
>
> One knock-on: extracting the `dependsOn` cascade into its own leaf module
> (`dependsOnCascade.ts`) was needed to keep the package acyclic once `applyMutation` began
> importing `docTransforms`. Verified: 0 module cycles in `x-studio-schema`.

**The underlying cause was stated in the architecture doc itself:**

> Adding a `StateMutation` variant is deliberately avoided — each variant is nominally
> AI-tool-facing wire surface.

So the mutation vocabulary does double duty: it is both the internal write protocol and the
LLM tool surface, and pressure to keep the second one small is suppressing the growth of the
first. Those are different concerns with different audiences and different rates of change.
They should be decoupled — a complete internal mutation set, plus a curated subset advertised
to the model — after which moving the 26 bypass writers onto the reducer becomes routine.

Until then this issue keeps regenerating defects, because every new `commitDocPatch` writer
starts outside every invariant the reducer upholds.

## Issue 3 — `StudioController` is a god object

1,896 code lines and 73 methods, owning simultaneously:

- the undo and redo stacks, and their parallel mutation-log stacks
- the capped recent-mutation log
- every `doc` write (both reducer-routed and direct)
- every `session`/`shell` write
- `runtime.dataSources` bookkeeping and adapter registration
- the persistence entry point (`loadSerializedState`)

Nothing in the design pushes back on it: it is the default home for anything stateful, so it
accumulates by default. The same shape appears on the server (`executeToolOnState.ts`, 1,772
code lines) and in the adapter (`createBatchingAdapter.ts`, 1,472).

> **Status: the first seam is cut.** The undo/redo stacks and the mutation log — seven fields
> touched by nine members — are now `store/MutationHistory.ts`, with the controller keeping only
> the doc-swap half in a shared `swapDoc`. 1,896 → 1,773 code lines. The extraction made two
> incidental guarantees explicit (`restore` and `snapshot` now copy rather than alias) and gained
> a focused 15-test suite for arithmetic the controller's end-to-end tests reach only expensively.
>
> **Doc writes** are no longer a seam to cut: issue 2 routed all of them through the shared
> reducer and deleted `commitDocPatch`, so the controller now holds screening and side effects
> rather than write logic.
>
> **Runtime/adapter bookkeeping** is extracted to `store/runtimeTransforms.ts` — pure
> `StudioRuntime → StudioRuntime` functions with the same no-op contract the doc reducer has, and
> a single `commitRuntime` choke point. Cache eviction stayed behind deliberately: it is I/O on a
> module-level singleton and was previously braided through the state computation. 14 focused
> tests, every one of them about the no-op contract, because a transform that rebuilt on a
> logical no-op would churn every subscriber and no controller-level test would catch it — the
> state is value-identical either way.
>
> The **widget-write cluster**'s pure parts are out too: `sanitizeWidgetForCreate`,
> `sanitizeWidgetConfigForKind` and `applyInferredTitles` were private members that never touched
> the store — pure functions living in a class only because that is where their callers were — and
> now sit in `internals/widgetConfigSanitization.ts` beside the chart-type sanitizers they compose.
>
> **1,896 → 1,572 code lines.** What is left in the biggest remaining members (`duplicateWidget`,
> `updateWidget`, `commitWidgetMove`) is screening and page resolution, not write logic: they
> validate, report a reason to their caller, and hand a mutation to the reducer. That is the shape
> the issue-2 work established, and it is a reasonable place for the class to stop shrinking — the
> next cut would be splitting a coherent authoring API across files for its own sake.

**Related, smaller:** the widget registry lives in `internals/` but imports every widget
component — 21 of the package's 56 upward layer edges. A registry belongs at the composition
root, assembled from the layer above, not underneath the layer it references.

> **Status: CLOSED — 21 upward edges to zero.**
>
> `builtinWidgetDefs.ts` moved to `components/widgets/`, beside the widgets it registers and
> below every consumer (all six were already in `components/`). That accounted for 19.
>
> The remaining two were not the registry and were more interesting. `geographyLoaders.ts` and
> `countryUtils.ts` sat under `components/widgets/StudioMapWidget/` but import no component and
> render nothing — 1,246 lines of locale and geography data filed under a widget because that
> widget was their first caller. They are `internals/` now, which is what they always were.
>
> The last edge was type-only: `internals/StudioUIConfigContext.ts` importing `StudioAIConfig`
> from the SSE adapter. It is a host-facing public config type, so it moved to `models/aiConfig.ts`
> where the package's other public contracts live; `studioBackendAdapter.ts` re-exports it, so no
> consumer's import changed.
>
> Worth noting what this was NOT: the registry never needed assembling at the composition root or
> injecting through context. It needed to be in the right directory. The measurement said
> "`internals/` imports `components/`", and the fix was to stop filing component-layer things
> under `internals/` — and, in two cases, to stop filing internals under `components/`.

## Why the review rounds could not find these

Worth stating plainly, because it is the reusable lesson.

The ~50 rounds found roughly 600 genuine defects and the packages are demonstrably healthier
for them. But every issue in this document was **invisible from where those rounds stood**:

- Issue 1 is the absence of a file. No per-file review finds a module that was never written.
- Issue 2 is a ratio. You only see 18-versus-26 by counting call sites across a whole class.
- Issue 3 is a size. You only see it by measuring, and every individual method in the file
  looks reasonable.

And a meaningful share of what those rounds _did_ find were symptoms of issues 1 and 2 —
found individually, fixed individually, and guaranteed to recur, because the cause was never
named. A defect review cannot conclude "stop fixing these and go build the missing module";
only a design review can.

The practical takeaway: alternate the two. A deep pass finds what a structural pass cannot
see, and vice versa, but a deep pass run repeatedly starts paying for the same ground twice.

## Recommended order of work

1. ~~**Extract the data wire contract into `x-studio-schema`** and have both sides import it.~~
   **Done** — `dataWireTypes.ts`, plus `aiWireLimits.ts` for the AI wire's two budgets, which
   turned out to have the same defect.
2. ~~**Decouple the mutation vocabulary from the AI tool surface**, then migrate the bypass
   writers onto the reducer.~~ **Done** — 44/0, `commitDocPatch` deleted.
3. **Split `StudioController`** along the seams above. Three cut (1,896 → 1,572); what remains
   is screening and page resolution rather than write logic, so this is a reasonable stopping
   point unless the class grows again.

`executeToolOnState.ts` is not on this list because it is not the same kind of item, and it now
has its own assessment:
[x-studio-ai-middleware](../../x-studio-ai-middleware/docs/ARCHITECTURE_ASSESSMENT.md). Short
version: it is the server-side instance of the shape issue 3 describes — four concerns in one
file, only one of which the file is named for — but **not** of issue 2's, since every mutating
tool plan already routes through the shared reducer.
