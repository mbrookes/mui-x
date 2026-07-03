# Architecture review — `@mui/x-studio-schema`

Full-spectrum (Tier 1–4) review of `packages/x-studio-schema`. This is the package's first
Tier-1/Tier-2 review; the recent Tier-3/4 remediation round (per-kind config split, dispatch-table
reducer, `renameAIThread` determinism, fail-closed widget defaults, 55-test suite) is taken as
given and not re-litigated. Every claim below was verified against current source, including the
two consumers (`@mui/x-studio`, `@mui/x-studio-ai-middleware`). The full suite (3 files, 55 tests)
passes as of this review.

Findings are ranked by severity within each tier.

---

## Tier 1 — Correctness / security

### T1-1 (High) `setWidgetLayout` and `setWidgetColSpan` still have the page-targeting divergence that `addWidget` was explicitly fixed for

`src/applyMutation.ts:170-233`; mutation variants in `src/aiTypes.ts:71-75`.

Both handlers resolve the target page from **the applying side's** `state.dashboard.activePageId`.
The server producer validates against the _server-threaded_ active page
(`x-studio-ai-middleware/src/executeToolOnState.ts:197-242`), then emits a mutation carrying no
`pageId`. If the user navigates to another page while the model is thinking — exactly the scenario
the `addWidget.pageId` fix documents (`aiTypes.ts:52-59`) — the client applies the mutation to the
_wrong page_:

- `setWidgetLayout` overwrites the newly-active page's `widgetRows` with rows referencing widgets
  that live on a different page — the original page silently keeps its stale layout and the current
  page's layout is destroyed and replaced with dangling widget IDs.
- `setWidgetColSpan` writes span entries (computed against the server page's `rowWidgetIds`) into
  the wrong page's `widgetColSpans`, both misformatting that page and orphaning the entry.

This is the same divergence class the team already judged worth fixing; these two variants were
missed. `applyBulkUpdate` got it right (it carries an explicit `activePageId`).

**Recommendation:** add `pageId?: string` to both variants' `args` (optional, falling back to the
active page for legacy payloads, mirroring `addWidget`); stamp it in `executeToolOnState`'s
`set_widget_layout` / `set_widget_width` cases, which already resolve and validate the active page.
Add reducer tests asserting the explicit page wins over the active page.

### T1-2 (High) `removePage` orphans widget-scoped filters of the widgets it deletes

`src/applyMutation.ts:269-272`.

`removePage` deletes every widget on the page (`widgetIdsOnPage`) but its filter cleanup only drops
filters whose **scope carries the removed `pageId`**. A `{ kind: 'widget'; widgetId }` scope has no
`pageId`, so widget-scoped filters targeting the just-deleted widgets survive as permanent orphans
in `state.filters` — invisible in any UI (their anchor widget is gone), impossible to remove except
by raw state surgery, and serialized forever. (`cross-filter` / `interactive` / `dashboard-date-range`
scopes all carry `pageId` and are cleaned correctly.)

`StudioController.removePage` (`x-studio/src/store/StudioController.ts:1361-1364`) has the
identical gap, so the "mirrors StudioController" claim is true — both are wrong.

**Recommendation:** in the reducer, extend the filter predicate to also drop
`scope.kind === 'widget' && widgetIdsOnPage.has(scope.widgetId)` (and, for symmetry,
`interactive`/`cross-filter` scopes whose `sourceWidgetId` is in `widgetIdsOnPage`); fix once here
and have the client delegate (see T2-2). Add a regression test with a widget-scoped filter on a
removed page's widget.

### T1-3 (Medium-High) `removeWidget` leaves `cross-filter`-scoped filters emitted by the removed widget

`src/applyMutation.ts:152-158`.

The cleanup drops the widget's own `widget`-scope filters and `interactive`-scope filters it
emitted, but **not** `{ kind: 'cross-filter'; sourceWidgetId }` filters. A chart that has an active
cross-filter selection and is then removed by the AI (`remove_widget` tool) leaves the cross-filter
in force: other widgets on the page stay filtered, and the normal clearing affordance (interacting
with the source chart) is gone. `StudioController.removeWidget`
(`StudioController.ts:653-661`) shares the bug; the controller's own cross-filter machinery
demonstrates the expected invariant — `applyCrossFilter` removes prior filters keyed by
`scope.kind === 'cross-filter' && scope.sourceWidgetId` (`StudioController.ts:1138-1144`).

**Recommendation:** add the third clause
`!(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === widgetId)` to the reducer's filter
predicate, plus a test. Apply the same fix client-side (or delegate, per T2-2).

### T1-4 (Medium) `removeWidget` reducer does not clean `widgetColSpans` — diverging from the client and orphaning span entries

`src/applyMutation.ts:130-168` vs `StudioController.ts:632-651`.

The client's `removeWidget` deletes the removed widget's span **and** clears spans of widgets left
as the sole occupant of their row. The reducer does neither. Consequences:

1. Orphaned `widgetColSpans[removedId]` entries persist in serialized state.
2. Visible UX divergence: after an AI-driven removal, a surviving widget that is now alone in its
   row keeps e.g. `span: 6` and renders half-width with dead whitespace, whereas the identical
   user-driven removal expands it to full width.

The ARCHITECTURE.md framing that the reducer is "the single mutation reducer" is undermined here:
`removeWidget` semantics exist twice and have already drifted (the client also only removes rows
from the _active_ page while the reducer sweeps all pages).

**Recommendation:** port the client's span cleanup (removed-widget span + orphaned-singleton spans)
into the reducer handler, then make `StudioController.removeWidget` delegate to `applyMutation`
plus its client-only shell-selection reset (T2-2).

### T1-5 (Medium) `createDefaultWidget` ID generation is millisecond-resolution and collision-prone; a collision silently swallows a widget

`src/factories.ts:46` — `` const id = `widget-${kind}-${Date.now()}` ``.

Two same-kind widgets created within the same millisecond receive identical IDs. This is not
hypothetical: client paths use the factory ID verbatim
(`x-studio/src/components/StudioChatPanel/createWidgetFromDescription.ts:94-102`,
`AddWidgetView.tsx`), and programmatic/looped creation is plausible. On collision, the `addWidget`
reducer does `{ ...state.widgets, [widget.id]: widget }` — the first widget is silently
overwritten while its `widgetRows` entry survives, so one card renders twice and one widget's data
is lost.

Tellingly, the AI middleware already distrusts the factory ID and overrides it with its own
stronger scheme — twice (`executeToolOnState.ts:130` and `:406`,
`` `widget-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` ``).

This also directly contradicts the package's own stated contract: ARCHITECTURE.md §"Overview"
declares function modules have "no `Date.now()`, no randomness, no I/O" — `factories.ts` violates
it, and the test suite conspicuously contains no ID-uniqueness assertion (one would flake).

**Recommendation:** either (a) accept `overrides.id` and make ID generation the caller's job, or
(b) fold the middleware's random-suffix scheme into the factory (one place, both consumers) and
delete the two inline copies in `executeToolOnState.ts`. Update ARCHITECTURE.md either way — as
written it misdescribes the code.

### T1-6 (Medium) `renameAIThread` targets the _applying side's_ active thread — the same divergence class as T1-1, unfixable server-side today

`src/applyMutation.ts:348-366`; producer at `executeToolOnState.ts:522-541`.

The mutation carries `name` and `updatedAt` but **no thread ID**; the reducer renames
`state.ai.activeThreadId`. The server-side application is documented as a no-op ("Server state
carries no `ai` thread store"), so the only meaningful application is on the client — where the
active thread is whatever the user is looking at _when the SSE event arrives_. If the user switches
threads while the model is running, the rename lands on the wrong thread. The remediation round
fixed this mutation's _non-determinism_ (`updatedAt`) but not its _target ambiguity_.

**Recommendation:** add `threadId: string` to the args, stamped from the originating request's
thread context (the chat request knows which thread it belongs to), and have the reducer rename
`threads.find(t => t.id === args.threadId)` with a no-op fallback. Keep an
`?? state.ai.activeThreadId` fallback for legacy payloads.

### T1-7 (Medium-Low) `applyBulkUpdate` wholesale-replaces the global `widgets` record — concurrent client-side edits are silently destroyed

`src/applyMutation.ts:329-346`; `src/aiTypes.ts:81-89`.

`args.widgets` replaces `state.widgets` for the **entire dashboard**, while rows/spans are only
touched on `activePageId`. The producer builds `args.widgets` from the _server-threaded_ state
(`executeToolOnState.ts:363`), so any widget the user creates or edits on any page while the
agentic turn is running is reverted or deleted when the mutation arrives — and a deletion leaves
the other page's `widgetRows` referencing a now-nonexistent widget ID (dangling reference, blank
card). The existing test ("replaces widgets globally but only touches widgetRows … on
activePageId") pins this behavior without confronting its lost-update consequence.

**Recommendation:** narrow the mutation to a per-page delta (`removedWidgetIds`,
`upsertedWidgets`) applied on top of the receiver's `state.widgets`, rather than a global snapshot.
Short of that, document the clobbering hazard on the `applyBulkUpdate` variant in `aiTypes.ts`.

### T1-8 (Low) Assorted robustness gaps in the reducer

- **Non-idempotent adds** (`applyMutation.ts:44-57, 305-315`): re-delivery of an `addFilter` SSE
  event appends a duplicate filter (`removeFilter` is idempotent; `addFilter` is not); `addPage`
  with an existing ID silently resets that page's `widgetRows: []`, orphaning its widgets in
  `state.widgets`. Cheap guards (`filters.some(f => f.id === …)`, `state.pages[id]` no-op) would
  make all adds replay-safe.
- **`clampSpan(NaN)`** (`applyMutation.ts:23-25`): `columns: NaN` (possible from a malformed wire
  payload; the producer does not validate the number) survives clamping as `NaN`, is stored in
  `widgetColSpans`, and serializes to `null` via JSON. Guard with `Number.isFinite`.
- **`updateWidget` `changes` can void required fields** (`applyMutation.ts:119-121`): a
  `changes: { title: undefined }` shallow-merge leaves `widget.title === undefined` despite the
  required `string` type. Unreachable via JSON transport (JSON has no `undefined`), but reachable
  from in-process callers; skipping `undefined`-valued keys in the merge closes it.

### T1-9 (Low) Type-level dependency on `@mui/x-chat-headless` is declared only as a devDependency of a source-shipped package

`src/aiTypes.ts:16` imports `ChatMessage` from `@mui/x-chat-headless`; `package.json:19-21` lists it
under `devDependencies`, and `main` points at raw `./src/index.ts`. Inside the pnpm workspace this
resolves; if the package is ever published (or consumed outside the workspace), consumers cannot
resolve the type — `StudioAIChatThread.messages` degrades to a compile error or `any`. Note
`@mui/x-studio` itself does not depend on `x-chat-headless` (only `@mui/x-chat`), so today its
compilation of `StudioAIChatThread` rides entirely on this transitive devDependency. The tsconfig
comment (`tsconfig.json`) shows the leak is already felt: `"types": ["node"]` exists solely because
type-checking follows this import. The "zero runtime dependencies" claim is technically true but
the packaging is not actually self-contained.

**Recommendation:** promote it to `dependencies`/`peerDependencies`, or (cleaner, keeps the package
genuinely dependency-free) make `StudioAIChatThread` generic (`messages: TMessage[]`) or define a
minimal structural `StudioChatMessage` here and have `@mui/x-studio` narrow it.

### T1-10 (Low) Types that promise more (or less) than the data guarantees

- `StudioRelationship` (`src/dataTypes.ts:219-266`): the three `junction*` fields are documented
  "**Required when `type === 'many-to-many'`**" but typed optional with no discrimination. The same
  file's sibling package already solved this pattern for `StudioFilterScope`; model
  `StudioRelationship` as a discriminated union on `type` so a junction-less many-to-many is a
  compile error instead of a runtime surprise.
- `StudioGridConfig.columns?: StudioGridColumn[]` (`src/widgetTypes.ts:154-155`): persisted state
  may contain bare strings (that is `normalizeGridColumn`'s reason to exist, `factories.ts:67-73`),
  so the type understates what deserialized data actually holds. Type it
  `(string | StudioGridColumn)[]` at the persistence boundary, or normalize during deserialization
  so the runtime shape matches the declared one.
- `StudioState.schemaVersion: 1` (`src/stateTypes.ts:143`) is a second source of truth alongside
  `CURRENT_SCHEMA_VERSION = 1` in `x-studio/src/store/statePersistence.ts:12`. In sync today; a
  version bump must now touch two packages in lockstep with no guard. Export the constant from this
  package and derive both (`schemaVersion: typeof CURRENT_SCHEMA_VERSION`).

---

## Tier 2 — Structural duplication

### T2-1 (High) `FieldCapability` and its semantics are defined twice, with both copies exported

- Schema: `src/dataTypes.ts:13` defines `export type FieldCapability`, and the comment openly
  admits the situation: "`@mui/x-studio`'s `utils/fieldCapabilities` keeps a structurally-identical
  copy".
- Client: `x-studio/src/utils/fieldCapabilities.ts:13` re-declares the identical union, plus the
  pure `TYPE_CAPABILITIES` map and `getFieldCapabilities`/`fieldHasCapability` helpers — all
  React-free and squarely inside this package's stated charter ("anything that is only a pure
  state-shape transform belongs here").

`@mui/x-studio` thus contains two distinct `FieldCapability` types (one via the
`export * from '@mui/x-studio-schema'` models barrel, one from `utils/`), which drift-proofs
nothing and forces casts (`fieldCapabilities.ts:30`). The AI middleware interprets
`StudioDataField.capabilities` when building prompts, so the _semantics_ (type → capability
mapping) are exactly the kind of both-sides-must-agree logic this package exists to own.

**Recommendation:** move `TYPE_CAPABILITIES`, `getFieldCapabilities`, `fieldHasCapability`,
`fieldsForCapability` into this package (a new `fieldCapabilities.ts` function module, explicit
named exports per convention), delete the client copy, and keep `utils/fieldCapabilities` as a thin
re-export shim like `widgetFactory.ts`.

### T2-2 (High) `StudioController` re-implements the reducer's mutation semantics in parallel — and has already drifted

The dispatch table is the "single semantic authority" only for AI-driven mutations. User-driven
equivalents are hand-written a second time in `StudioController` (`removeWidget` :621, `removePage`
:1342, `renamePage` :1386, `addPage`, layout methods …), and the two copies have measurably
diverged (T1-4: span cleanup, active-page vs all-pages row sweep; T1-2/T1-3 gaps are at least
_shared_). This is precisely the two-parallel-implementations shape the package was created to
eliminate between server and client, reproduced _within_ the client.

**Recommendation:** re-implement the pure core of each `StudioController` mutation method as
`this.applyExternalMutation({ type, args }, label)` (the plumbing already exists,
`StudioController.ts:146-149`), layering only genuinely client-side effects (shell selection reset,
title inference, undo labels) on top. Do it incrementally, starting with `removeWidget`/`removePage`
where drift is already user-visible.

### T2-3 (Medium) `StudioChartSeries.seriesType` / `type` alias pair, with consumers disagreeing about it

`src/widgetTypes.ts:75-83` defines both `seriesType` and `type` ("Alias … preferred spelling"),
with no defined precedence when both are set. Consumers have already split:
`StudioMixedChart.tsx:66` honors `seriesType ?? type ?? 'bar'`, while `ChartSetupPanel.tsx:979`
reads only `seriesType` — so an AI-authored series `{ type: 'line' }` renders as a line but its
setup panel displays "bar". A schema type offering two spellings for one concept guarantees exactly
this class of bug.

**Recommendation:** pick `type` as canonical (it is documented as preferred), deprecate
`seriesType` in the JSDoc, add a `normalizeChartSeries()` helper next to `normalizeGridColumn()`
(same persisted-shape-normalization pattern), and route both consumers through it.

### T2-4 (Low) Widget ID minting duplicated inside the middleware instead of factory-owned

`executeToolOnState.ts:130` and `:406` contain byte-identical inline ID generation overriding the
factory's ID. Whatever resolution T1-5 gets, the generator should exist once (in
`createDefaultWidget` or an exported `createWidgetId()`), not three times across two packages.

### T2-5 (Low) Stale cross-package comment about deriving `StudioAIToolName`

`src/aiTypes.ts:186-189` says deriving the union from `STUDIO_AI_TOOLS` "would require `as const`
on the tool array". The array **is** `as const` (`studioAITools.ts:536`), and that file's drift
guard (:547-562) explains the real blocker is dependency direction (client must import the union
without depending on the server package). The guard itself is sound and bidirectional — good shape
— but the schema-side comment should be corrected to cite the actual constraint.

---

## Tier 3 — God-files / structural cohesion

Broadly healthy after the remediation round; findings here are minor.

- **`widgetTypes.ts` (726 lines)** remains cohesive: one topic (widget-config surface), heavy on
  doc comments rather than logic. The residual pressure point is `StudioChartConfig`
  (`widgetTypes.ts:195-445`, ~55 keys across 12 sub-shapes). The stated rationale for not splitting
  (shared axis/series/annotation keys) holds today; if another chart sub-shape lands, split the
  prefix families (`funnel*`, `heat*`, `gantt*`, `sankey*`, `pie*`, `scatter*`) into named
  interfaces that `StudioChartConfig` extends — same pattern as the per-kind split, one level down.
- **Cosmetic:** the `Partial<…>` wrappers in `StudioWidgetConfig`'s extends list
  (`widgetTypes.ts:667-676`) are no-ops — every member of every per-kind interface is already
  optional. Harmless, but they imply a guarantee ("per-kind interfaces may have required keys")
  that nothing enforces; either drop the wrappers or add a comment saying they are prophylactic.
- **`applyMutation.ts` dispatch table** is holding up well: handler co-location, exhaustive mapped
  type, single boundary cast, graceful wire-payload fallback are all as advertised. One nit: the
  `removeWidget`/`removePage` handlers rebuild **every** page object even when untouched
  (`applyMutation.ts:140-150`), churning reference identity for state that feeds
  `useSyncExternalStore` selectors — return the original page object when the row sweep removed
  nothing, as the handlers already carefully do for `filters` (:164).
- **`createDefaultStudioState`'s signature lies about its merge semantics**
  (`factories.ts:77`): it takes `Partial<StudioState>`, which requires a _complete_
  `dashboard`/`shell` when overriding — yet the implementation deep-merges partials, and the
  package's own tests must cast (`factories.test.ts:79, 94` `as any`) to use the documented
  behavior. Introduce an explicit override type (`dashboard?: Partial<StudioDashboardState>`,
  `shell?: Partial<StudioShellState> & { openDrawers?: Partial<…> }`) so the deep-merge semantics
  are expressible without casts. Also note the asymmetry at `factories.ts:124-125`:
  `selectedFieldId`/`selectedSourceId` get `?? null` re-defaulting but `selectedWidgetId` does not.

---

## Tier 4 — Testing gaps

The 55-test suite is genuinely good on the branches it covers (no-ops, clamp/overflow, merge order,
unknown-type fallbacks). Remaining gaps, ranked:

1. **No tests for the dependent-state cleanup invariants that are actually broken** — a
   cross-filter-scoped filter surviving `removeWidget` (T1-3), a widget-scoped filter surviving
   `removePage` (T1-2), `widgetColSpans` after `removeWidget` (T1-4). These are the highest-value
   additions; write them alongside the fixes.
2. **`normalizeGridColumn` has zero tests** despite being a public export and the designated
   deserialization guard (`factories.ts:67-73`). Two cases (string passthrough → `{fieldId}`,
   object identity) would do.
3. **No ID-uniqueness test for `createDefaultWidget`** — absence is diagnostic (see T1-5): a
   `new Set(ids).size === n` assertion over a tight loop fails against the current `Date.now()`
   scheme. Add it _with_ the fix.
4. **Divergence-scenario tests are one-sided.** `addWidget` has "targets the explicit pageId, not
   the active page" tests; once T1-1/T1-6 land, mirror them for
   `setWidgetLayout`/`setWidgetColSpan`/`renameAIThread` (explicit target beats applying-side
   state).
5. **`factories.test.ts`'s header contradicts ARCHITECTURE.md.** The doc claims the per-kind
   assertions are "checked against the source's own `BUILTIN_WIDGET_DEFAULTS` table so the test
   can't silently drift"; the test file says the opposite (`factories.test.ts:4-7` — the table is
   file-private, values are hand-transcribed). Either export the table for tests or fix the doc.
6. **Minor:** the purity test covers only `setDashboardTitle` (`applyMutation.test.ts:25-30`) —
   iterating one representative mutation per kind over a frozen/JSON-snapshotted state is cheap;
   `removeWidget` with an unknown ID lacks a same-reference no-op test (its siblings all have one);
   `detectAnomaliesIQR` has no `NaN`/`Infinity` input case; `applyBulkUpdate` has no test
   documenting that other-page widgets must be included in `args.widgets` or be lost (T1-7 —
   pinning it would at least make the contract explicit).

No type-level invariants in the per-kind config split warrant `expectTypeOf`-style tests today: all
keys are optional by design, and the two compile-time guards that matter (exhaustive
`MUTATION_HANDLERS`, exhaustive `BUILTIN_WIDGET_DEFAULTS`) are enforced by `tsc` itself.

---

## Documentation accuracy (ARCHITECTURE.md spot-check)

Corrections needed, in addition to items noted above (T1-5 purity claim, T4-5 factories-test claim,
T2-5 stale derivation note):

- §`anomalyDetection.ts`: says `detectAnomaliesIQR` "returns a `Set<number>` of anomalous
  **values**" — it returns a set of **indices** into `values` (`anomalyDetection.ts:21-23`, and the
  tests assert indices). The source docstring is correct; the architecture doc is not.
- §`applyMutation.ts` "removePage performs full cleanup mirroring `StudioController.removePage`" —
  true, but both share the T1-2 orphan; and the `removeWidget` bullet omits that the client version
  additionally cleans spans (T1-4). Update once the reducers are fixed/unified.

## Summary

The remediation round left Tiers 3–4 in solid shape: the dispatch table, fail-closed factory table,
and test suite are working as designed. The never-reviewed Tier 1 surface is where the real debt
is, and it clusters into two themes: (a) the page/thread-targeting divergence fix applied to
`addWidget`/`addFilter` was not carried through to `setWidgetLayout`, `setWidgetColSpan`, and
`renameAIThread`; and (b) dependent-state cleanup (`removeWidget`/`removePage` vs filters and
column spans) is incomplete and duplicated between the reducer and `StudioController`, with drift
already visible. Fixing the cleanup once in the reducer and making the controller delegate (T2-2)
resolves T1-2/3/4 and removes the largest duplication in one motion.
