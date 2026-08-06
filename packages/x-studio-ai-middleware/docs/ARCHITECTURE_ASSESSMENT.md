# x-studio-ai-middleware architecture assessment

> **Scope:** `@mui/x-studio-ai-middleware`, entered through `executeToolOnState.ts` — at 3,282
> raw lines the second-largest file across the four x-studio packages, and the one no part of
> the preceding architecture work examined.
>
> **Question:** is the server-side tool-execution design sound, or is it the server instance of
> the god-object shape that
> [x-studio's assessment](../../x-studio/docs/ARCHITECTURE_ASSESSMENT.md) raised as issue 3?
>
> **Not** a defect review. Every claim below is a measurement and the command that produced it
> is stated, so the number can be re-run and challenged.

## Contents

- [Verdict](#verdict)
- [What is structurally right](#what-is-structurally-right)
- [Issue 1 — the request trust boundary is implemented in two files, neither named for it](#issue-1--the-request-trust-boundary-is-implemented-in-two-files-neither-named-for-it)
- [Issue 2 — six of eight importers want something other than tool execution](#issue-2--six-of-eight-importers-want-something-other-than-tool-execution)
- [Issue 3 — widget-config knowledge is split four ways and only half of it is checkable](#issue-3--widget-config-knowledge-is-split-four-ways-and-only-half-of-it-is-checkable)
- [Issue 4 — layout validation is written twice, by hand](#issue-4--layout-validation-is-written-twice-by-hand)
- [On `apply_bulk_update`](#on-apply_bulk_update)
- [Why the earlier work did not reach this](#why-the-earlier-work-did-not-reach-this)
- [Recommended order of work](#recommended-order-of-work)

## Verdict

**Sound where it matters most, and misfiled where it matters least.**

The thing most worth checking is whether this file is a second reducer — a server-side
reimplementation of the mutation semantics the schema package owns. It is not. Fourteen tool
plans emit a `StateMutation` and derive their next state from `applyMutation(state, mutation)`;
none hand-rolls one. The division of labor that x-studio's issue 2 established on the client —
screening with the writer, id minting with the caller, semantics with the reducer — already
holds here, and holds uniformly.

What is wrong is filing, not logic. The file is four unrelated modules sharing a name, and the
concern that dominates it by line count is not tool execution but request-body capping — half of
a trust boundary whose other half lives in `handleAIChat.ts`. The consequences are the ordinary
ones: a stated invariant ("one place to look for what bounds request input") that is not true, a
documented import cycle already being routed around, and knowledge about widget config split
across four locations with no compile-time tie between them.

| #   | Issue                                                                           | Severity | Shape of the fix                                    |
| :-- | :------------------------------------------------------------------------------ | :------- | :-------------------------------------------------- |
| 1   | The request trust boundary is split across two files by which field it caps     | Medium   | One `requestCaps` module at the chokepoint          |
| 2   | Four concerns in one file; 6 of 8 importers want a concern other than the name  | Medium   | Split along seams the importers already reveal      |
| 3   | ~~Config-key facts in four places; 15 tool-writable keys unchecked~~ **CLOSED** | Medium   | Mapped type over `StudioWidgetConfig` in the schema |
| 4   | Layout validation implemented twice, kept aligned by comment                    | Low      | Share the predicate, keep the policy at each site   |

Composition of `executeToolOnState.ts`, by code lines (blank and comment lines excluded):

```text
 370  21%  request-body capping — 30 constants, 12 helpers, capIncomingDashboardState
  58   3%  projection for the model — projectStateForAI, projectDataSourceMetadata
 199  11%  plan types, arg/config validation, buildWidgetFromArgs
1073  61%  TOOL_IMPLS — 21 handlers
  18   1%  executeToolOnState — the dispatch itself
  54   3%  header, imports, interstitial
```

## What is structurally right

### It is not a second reducer

The single fact that most determines whether this package is sound. Every mutating plan follows
one shape:

```ts
const mutation: StateMutation = { type: 'addPage', args: { id, title } };
return { output: …, mutation, nextState: applyMutation(state, mutation) };
```

`grep -c "nextState: applyMutation(state, mutation)"` returns 14, and there is no other
non-error form of `nextState` in the file. The server threads state forward across an agentic
turn by running the same reducer the client will run when the mutation arrives, so the two
cannot disagree about what a mutation means. This is the property the shared schema package
exists to provide, and it is fully realized here — the one place it would have been easiest to
quietly reimplement.

### The dispatch table is closed and compile-time exhaustive

`TOOL_IMPLS` is typed `{ [K in StudioAIToolName]: PureToolImpl | ExternalToolImpl }`, so adding
a tool to `STUDIO_AI_TOOL_REGISTRY` without implementing it is a type error, and implementing
one that is not registered is too. The same arrangement `MUTATION_HANDLERS` has in the schema
package. The lookup is `Object.hasOwn`-guarded, so a model-supplied `toolName` naming an
`Object.prototype` member falls through to the ordinary `Unknown tool` error rather than
resolving an inherited value. `BUILTIN_WIDGET_KINDS` carries an `AssertAllBuiltinKindsListed`
compile-time exhaustiveness check for the same reason.

### The pure/external split is real

`PureToolImpl` plans against a `StudioState` value and returns a next state; `ExternalToolImpl`
(only `query_data_source`) declares that it does not. The distinction is what lets the agentic
loop thread state across a turn without knowing which tools touch a database, and it is enforced
by the discriminant rather than by convention.

### Errors are addressed to the model, not to a log

Handler errors name the constraint and the remedy, and at least one deliberately does **not**
name a discovery tool because that tool is `privateModeExcluded` and would cost the model a turn
on an `Unknown tool` error. That is the right instinct: an error message in this file is part of
the tool contract, not diagnostics.

## Issue 1 — the request trust boundary is implemented in two files, neither named for it

**The finding.** Capping the client-supplied request body before it reaches the system prompt is
one job, applied at one chokepoint, in five consecutive statements in `handleAIChat.ts`:

```ts
const cappedDashboardState = capIncomingDashboardState(dashboardState); // executeToolOnState.ts
const cappedRichContext = capIncomingRichContext(richContext); //           handleAIChat.ts
const cappedCustomWidgets = capIncomingCustomWidgets(customWidgets); //     handleAIChat.ts
const cappedPageSnapshot = capIncomingPageSnapshot(pageSnapshot); //        handleAIChat.ts
const cappedFocusedWidgetId = capText(focusedWidgetId, MAX_REQUEST_STRING_LENGTH);
```

The implementation is 578 code lines across three files:

| File                     | Code lines | Holds                                                                                                 |
| :----------------------- | ---------: | :---------------------------------------------------------------------------------------------------- |
| `executeToolOnState.ts`  |        370 | 30 `MAX_STATE_*` constants, 12 cap helpers, `capIncomingDashboardState`                               |
| `handleAIChat.ts`        |        188 | 14 `MAX_REQUEST_*` constants, 4 helpers, `capIncoming{RichContext,CustomWidgets,Skills,PageSnapshot}` |
| `internal/promptCaps.ts` |         20 | the primitives — `asString`, `capText`, `capMaybeText`                                                |

Nothing about the split follows the job. It follows which request field a given round happened
to be closing: `dashboardState` was capped from the tool executor because that is where the
`cap*` helpers for state entities already lived, and `richContext` was capped from the request
handler because that is where it was read. The code says so itself — `handleAIChat.ts` describes
`capIncomingRichContext` as a _"sibling to `executeToolOnState.ts`'s
`capIncomingDashboardState`"_, and `internal/promptCaps.ts` documents its callers as _"out of
`capIncomingDashboardState`, at the very top of `handleAIChat` request handling"_. Two files
each know they are half of something.

**What it costs.** `handleAIChat.ts` states the intent plainly at the chokepoint:

> Capped at the SAME chokepoint as the three above so there is one place to look for "what bounds
> request input".

There is one place to look for _where_ the bounding happens and two places to look for _what it
is_ — and the larger half is in a file whose name says it executes tools. The 30 `MAX_STATE_*`
constants and the 14 `MAX_REQUEST_*` constants are the same kind of number, several are
literally equal (`MAX_FILTER_STRING_LENGTH` and `MAX_REQUEST_STRING_LENGTH` are both 200,
declared independently), and nothing ties them together.

**Why it is not the same as x-studio's issue 1.** That one was a contract with two implementers
that had already drifted. This is one implementer with the contract in two drawers. No drift has
been demonstrated; the cost so far is comprehension and the near-certainty that the next
request-input cap lands in whichever of the two files its field is read from.

**The fix.** A `internal/requestCaps.ts` holding both halves, imported by `handleAIChat.ts` at
the chokepoint. `capIncomingDashboardState` moves with its 30 constants and 12 helpers, which
alone removes 370 of `executeToolOnState.ts`'s 1,772 code lines and, per issue 2, two of its
importers.

## Issue 2 — six of eight importers want something other than tool execution

**The finding.** Thirteen exported names spanning four concerns. Eight modules in the package
import from this file, and this is what each of them wants:

| Importer                       | Imports                                                 | Concern                    |
| :----------------------------- | :------------------------------------------------------ | :------------------------- |
| `toolPolicy.ts`                | `executeToolOnState`, `ToolExecutionResult`             | tool execution             |
| `mcp.ts`                       | `ToolExecutionResult`                                   | tool execution (type only) |
| `handleAIChat.ts`              | `capIncomingDashboardState`, `MAX_FILTER_STRING_LENGTH` | request capping            |
| `buildAISystemPrompt.test.ts`  | `capIncomingDashboardState`                             | request capping            |
| `mcp/queryTools.ts`            | `capFilterValue`, `MAX_FILTER_STRING_LENGTH`            | request capping            |
| `generateFieldDescriptions.ts` | `MAX_FILTER_STRING_LENGTH`                              | request capping            |
| `mcp/resources.ts`             | `projectStateForAI`                                     | projection                 |
| `handleGenerateInsight.ts`     | `buildWidgetFromArgs`, `MAX_FILTER_STRING_LENGTH`       | widget factory             |

**One importer calls the function the file is named for**, and a second takes only its result
type. The other six want a different concern entirely: four the capping layer, one the
projection, one the widget factory. That is not a judgement about coupling in the abstract — it
is the package saying, through its own import graph, that this file is four modules.

**It is already costing something.** The import block carries this note:

> Imported from `internal/promptCaps` (a neutral leaf module), **NOT** from
> `./handleGenerateInsight`, which itself imports `buildWidgetFromArgs`/`MAX_FILTER_STRING_LENGTH`
> FROM this file — importing the constant from there would form a two-node import cycle.

A cycle routed around by hand, caused by a widget factory and a size constant living in the same
module as tool dispatch. `internal/promptCaps.ts` exists as "a neutral leaf module" precisely
because there was nowhere neutral to put a shared constant.

**The seams are the table above.** Request capping (370 lines) leaves under issue 1. Projection
(`projectStateForAI`, `projectDataSourceMetadata`, and their three result interfaces — 58 lines)
has one importer outside this file and no dependency on anything else in it. `buildWidgetFromArgs`
and the arg/config validation helpers (199 lines) are the shared vocabulary the handlers are
built from. What is left is `TOOL_IMPLS` plus an 18-line dispatch: 1,073 lines that genuinely are
server-side tool execution, in a file named for it.

**Whether to split `TOOL_IMPLS` further is a separate question**, and the honest answer is
probably not by handler. The table's compile-time exhaustiveness over `StudioAIToolName` is a
real guarantee, and 21 one-tool files would trade it for import bookkeeping. The 571-line
`apply_bulk_update` is the exception — see below.

## Issue 3 — widget-config knowledge is split four ways and only half of it is checkable

**The finding.** Four locations know facts about widget config keys:

| Location                                       | Knows                                                   | Kind         |
| :--------------------------------------------- | :------------------------------------------------------ | :----------- |
| `x-studio-schema/widgetTypes.ts`               | the declared type of every key                          | compile-time |
| `x-studio-schema/configKeyValidation.ts`       | which keys are legal for which widget kind              | runtime      |
| `x-studio-ai-middleware/executeToolOnState.ts` | the value type of 21 keys (`SCALAR_CONFIG_VALUE_TYPES`) | runtime      |
| `x-studio-ai-middleware/widgetConfigMeta.ts`   | how to describe the keys to the model                   | prose        |

The middle two are the pair that has to agree. `validateConfigKeysForKind` is shared from the
schema and answers "may this tool write this key". `SCALAR_CONFIG_VALUE_TYPES` is a 21-entry
hand-maintained table in this package and answers "must this key's value be a boolean or a
number". Half the contract shared, half local — the same shape as the AI wire budgets that
x-studio's assessment closed.

**The measurable consequence.** `StudioWidgetConfig` has 123 properties, 36 of them declared a
bare `boolean` or `number` (13 and 23) — enumerated with the TypeScript compiler API rather than
by grepping the file, which over-counts by sweeping in nested interfaces like the forecast
config. The runtime table covered 21. **Every one of the 15 it missed passes
`validateConfigKeysForKind` for at least one widget kind** — verified by executing the validator,
not by reading it:

```text
filterWidgetMax, filterWidgetMin, filterWidgetStep  -> filter
gridHeight                                          -> grid
kpiCompact, kpiSparklineArea, kpiSparklineCumulative, kpiSparklineGaugeMax -> kpi
mapLegendZeroMin                                    -> map
textAiEnabled, textBodyFontSize, textSubtitleFontSize,
textTitleFontSize, textTitleFontWeight              -> text
titleFontSize                                       -> every kind
```

So `update_widget({ kind: 'kpi', config: { kpiCompact: "…" } })` stores a string in a field the
type declares `boolean`, and the write-source backstop does not fire. There were no type
_disagreements_ and no orphan entries — the 21 that were covered were correct. The gap was
coverage, and it was invisible because nothing connected the table to the type it mirrored.

**Why this is a design finding rather than 15 defects.** The table's own comment says the set is
_"intentionally small (the scalar toggles the tools populate)"_. That was true when it was
written and is no longer true, and there is no mechanism by which anyone would find out: the
table is a runtime mirror of a static type with no compile-time link, in a different package
from the type. The file already demonstrates the fix on its neighbor —
`AssertAllBuiltinKindsListed` makes `BUILTIN_WIDGET_KINDS` fail to compile when a kind is added
without being listed. The same technique applies here.

**Scope note.** The stored-prompt-injection hazard the comment cites is defended primarily at the
prompt boundary by `sanitizeForPrompt`, and that defense is unaffected. What the 15 keys are
missing is the secondary write-source backstop, whose value is keeping a structurally-broken
widget out of the persisted document — the client still has to render it.

> **Status: CLOSED.**
>
> `SCALAR_CONFIG_VALUE_TYPES` now lives in `x-studio-schema/configKeyValidation.ts` beside the
> key allow-lists it is the other half of, typed as a mapped type over `StudioWidgetConfig`'s
> scalar keys. A missing key, a stray key, and a `'number'` written against a `boolean`-declared
> property are all compile errors — the same technique `AssertKeysCovered` already applied to the
> key lists. The compiler enumerated the 15 additions; it did not accept the table until every
> one was present.
>
> `validateConfigValueTypes(config)` returns offending-key fragments rather than a sentence, so
> the middleware keeps its own model-facing wording — screening stays with the writer, the
> predicate is shared. `executeToolOnState.ts`'s `invalidConfigValueError` is now six lines.
>
> Published from the schema's index, so the client-side write boundary
> (`StudioController.updateWidgetConfig`) that `configKeyValidation.ts`'s own doc names as
> unguarded has an implementation to call rather than a third copy to write.

## Issue 4 — layout validation is written twice, by hand

`set_widget_layout` (141 lines) and `apply_bulk_update`'s layout op (110 lines) each validate a
model-supplied `string[][]`: array-of-arrays shape, row count against `MAX_LAYOUT_ROWS`,
duplicate ids across cells, and membership against the live widget set. The second one says so:

> Validate the layout with the **SAME rigor** as the single-widget `set_widget_layout` handler
> (shape + membership) …
>
> Reject DUPLICATE ids with the **SAME rigor** as `set_widget_layout` …

Two implementations kept aligned by a comment asserting they are aligned.

**What differs is policy, not predicate.** `set_widget_layout` returns an error and applies
nothing; the bulk op pushes to `skipped` and applies the rest of the batch. That difference is
correct and should survive — it is the same rule x-studio's issue 2 settled, that **screening
stays with the writer when it owes its caller a reason**. But the reason is the caller's; the
_check_ is not. A shared `validateLayoutRows(rows, liveIds) → LayoutProblem[]` with each site
turning problems into its own outcome keeps the policy split and retires the duplicate.

## On `apply_bulk_update`

571 raw lines — 37% of `TOOL_IMPLS`, larger than the fifteen smallest handlers combined. It is
worth stating plainly that this is **not** a case of several tools stapled together, because that
is the obvious reading and it is wrong.

The handler is five ordered op sections — removals, additions, updates, layout, column spans —
over shared mutable bookkeeping: removals mutate `widgetRows` and `liveWidgetIds`, which
additions and updates read, which layout then validates against. The whole thing emits **one**
`applyBulkUpdate` mutation carrying deltas, so the client applies it atomically and the human
approves it once. Splitting the tool would break both properties, and the delta payload (rather
than a whole-`widgets` snapshot) is a deliberate lost-update fix so a concurrent client-side edit
during an agentic turn is not reverted.

What it is, is one function that should be six: five `(ops, acc) → acc` steps over an explicit
accumulator, plus assembly. The bookkeeping that makes it one transaction is exactly what an
explicit accumulator makes legible, and each section already validates its own shape, applies its
own `MAX_BULK_UPDATE_OPS` cap and crafts its own `skipped` messages — they are functions that
have not been given names.

## Why the earlier work did not reach this

The same reason x-studio's assessment gave for its own three issues, with one addition worth
recording.

The ~50 review rounds worked from each package's `ARCHITECTURE.md` plus the code, looking for
behavior that was wrong inside the design. Every issue above is a question about **where code
lives**, and no amount of reading a handler tells you that its module has seven importers who
want something else. Issue 2's evidence is an import graph; issue 3's is a set difference between
a static type and a runtime table in another package; issue 1's is a chokepoint listing five
calls that resolve to two files. None of those are visible from inside a file.

The addition: this file was **hardened** repeatedly and never **assessed**. The capping layer
that now dominates it by line count is the accumulated residue of resource-exhaustion rounds,
each of which correctly added a bound and correctly put it next to the bounds already there — and
the place the bounds already were was, by accident of the first one, the tool executor. Every
individual step was right. Nothing in the process asks whether the pile is still in the right
room.

## Recommended order of work

1. **Move `capIncomingDashboardState` and its constants into a request-caps module** beside the
   other four `capIncoming*` functions. Mechanical, removes 370 lines and two importers from
   `executeToolOnState.ts`, and makes the invariant `handleAIChat.ts` already claims actually
   true. Do this first — it is most of issue 2's fix as well as all of issue 1's.
2. **Lift the projection and the widget factory out**, leaving `TOOL_IMPLS` plus dispatch. This
   also removes the hand-routed import cycle around `handleGenerateInsight`.
3. ~~**Tie `SCALAR_CONFIG_VALUE_TYPES` to the schema**, by derivation or by compile-time
   assertion.~~ **Done** — mapped type over `StudioWidgetConfig`, all 36 scalar keys covered.
4. **Decompose `apply_bulk_update` into its five named steps**, and share the layout predicate
   with `set_widget_layout` (issue 4) while it is open.

Nothing here blocks anything. The package's load-bearing decision — that the server plans
mutations and the shared reducer applies them — is correct and uniformly kept, which is why this
is a filing exercise rather than a rewrite.
