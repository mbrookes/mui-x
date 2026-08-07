# Architecture

Internal reference for how `@mui/x-studio-core` is put together. For the React binding that renders
it, see [`@mui/x-studio`](../x-studio/ARCHITECTURE.md).

## Contents

- [What this package is](#what-this-package-is)
- [Directory layout](#directory-layout)
- [The boundary](#the-boundary)
- [State management](#state-management)
- [Data pipeline](#data-pipeline)
- [Filters](#filters)
- [The query adapter](#the-query-adapter)
- [Testing](#testing)

## What this package is

`x-studio-core` is the engine behind MUI X Studio: everything that decides **what a dashboard is
and what rows a widget should show**, with no opinion about how any of it is drawn.

Three subsystems, in dependency order:

1. **`store/`** — `StudioController`, a `Store<StudioState>` with undo/redo and every imperative
   mutation method. It is the single source of truth for a dashboard; nothing else holds document,
   layout, filter or selection state.
2. **`engine/`** — the four-layer, aggressively-cached row pipeline turning raw
   `dataSources[id].rows` into the exact rows one widget renders, plus the aggregation, chart-shape
   and query-descriptor machinery around it.
3. **`adapter/`** — the client half of the remote-data contract: `StudioDataSourceAdapter` and the
   two shipped implementations, which push filtering and aggregation down to a server and re-apply
   client-side whatever the wire protocol cannot express faithfully.

Below it sits `@mui/x-studio-schema`, which owns every state/widget/data/expression/AI-protocol
type, the factories, the pure `applyMutation` reducer, persistence, and anomaly math. `models/` here
is a thin re-export of it. Above it sits `@mui/x-studio`, the React binding.

## Directory layout

```text
packages/x-studio-core/src/
  store/     StudioController, MutationHistory, runtimeTransforms
  engine/    The row pipeline and its caches, aggregation, chart shapes and grain resolution,
             the chart-type registry, filter scoping and evaluation, geography/country data,
             the widget factory and layout math, i18n plumbing (localeText, studioLocale)
  adapter/   StudioDataSourceAdapter, createSimpleAdapter, createBatchingAdapter,
             aggregationPushdown
  models/    Re-exports of @mui/x-studio-schema
  utils/     expressionEvaluator, gridGrouping, gridSummary, fieldCapabilities, safeLookup
  locales/   Translation bundles (enUS, fr, de, es, ptBR)
  index.ts   The curated top-level barrel
```

Six subdirectory entry points are exported (`.`, `./store`, `./engine`, `./adapter`, `./models`,
`./utils`, `./locales`) rather than per-file deep paths, because the repo's eslint bans
`@mui/*/*/*` — one subpath segment is the most an import may carry.

`engine/` was called `engine/` while it lived inside the React package, where the name meant
"not the public component API". In a package that _is_ the engine the name says nothing, so it is
gone; likewise `server/` → `adapter/`, since none of it runs on a server.

## The boundary

**This package must be importable without React.** That is not an aspiration — it is the reason the
package exists, and it is enforced two ways:

- No module here imports `react`, `@mui/material`, `@emotion/*`, or any `@mui/x-*` rendering
  package. The one dependency on `@mui/x-charts-vendor` is a devDependency for test fixtures.
- The vitest config is `environment: 'node'`, deliberately. A test here that starts needing a DOM
  is the signal that the module under test grew a browser dependency and belongs in a binding
  instead. It has already caught real cases: `downloadCsv` and `exportGridToCsv` reach for
  `document`, so they live in the binding's `x-studio`'s `internals/widgetPresentation.tsx` while the pure
  `buildCsvContent` stayed here.

**The dividing line, three ways.** Anything that is _only_ a pure state-shape transform (mutation
reducers, default-state factories, persistence, anomaly math) belongs one level down in
`@mui/x-studio-schema`. Anything that reads or transforms in-memory row data, decides what a
mutation does to a live controller, or talks to a data backend belongs here. Anything that renders,
takes a component prop, or names a React type belongs in a binding. The dependency arrow runs
binding → core → schema, never the reverse.

Two consequences worth stating, because they are the ones that get argued about:

- **A widget-kind _descriptor_ is data; a widget-kind _renderer_ is not.** `StudioWidgetKindDescriptor`
  (kind, label, capability flags, default config) lives in the schema package, where the AI
  middleware can read the same definition. `StudioCustomWidgetDef` extends it in the binding with
  the `component`/`setupPanel`/`icon` fields, which only something that can name a component type
  can express.
- **A `use*` name does not make something a hook.** `engine/usePageChartColors.ts` is a pure
  function; the widget-facing hooks that _do_ subscribe to a store (`useWidgetRows`, `useChartRows`,
  `useAdapterRows`) are in the binding.

## State management

### `StudioState` is partitioned by lifetime

Defined in the schema package's `stateTypes.ts`. Getting this partition wrong is the single easiest way to break the package, so it is spelled out:

| Partition                   | Contents                                                                                                                        | Persisted                                        | Undoable | Reducer-mutable |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------- | :------- | :-------------- |
| `doc` (`StudioDoc`)         | `dashboard`, `pages`, `widgets`, `relationships`, `filters`, `expressionFields`, optional `filterPresets`/`ai`, `schemaVersion` | yes (minus cross-filter and interactive entries) | yes      | yes             |
| `session` (`StudioSession`) | `mode` (view/edit), `shell` (open drawers, selection ids)                                                                       | no                                               | no       | no              |
| `runtime` (`StudioRuntime`) | host-injected `dataSources`                                                                                                     | no                                               | no       | no              |

Why each boundary sits where it does:

- **`mode` is in `session`, not `doc`** — switching view↔edit is not a dashboard edit and must not be Ctrl+Z-able.
- **`runtime.dataSources` is never undone** — an undo must never revert live data to stale rows.
- **Cross-filter-scoped filter entries live in `doc.filters`**, not `session`. The reducer manipulates them (cleanup on `removeWidget`/`removePage`/`applyBulkUpdate`) and `applyCrossFilter` is _deliberately_ undoable, so a chart-click cross-filter is Ctrl+Z-able like any other doc edit. They are stripped only at the persistence boundary.

### `MutationHistory` (`store/MutationHistory.ts`)

The undo/redo stacks and the recent-mutation log, extracted from the controller. Five parallel
arrays, a counter and a `WeakMap` that must move in lockstep — the `StudioDoc[]` undo stack is 1:1
length-matched with its label pairing, the redo side mirrors it, and the visible log is capped
INDEPENDENTLY so an entry can scroll out of it while its undo pairing is still live. Nine
controller members touched those seven fields and each had to know the whole arrangement.

The split is by concern, not by line count: `stepBack`/`stepForward` move the stacks and **return
the doc to swap to**, while the controller keeps `carryTransientDocState`,
`normalizeSessionAfterDocSwap` and `store.setState` in one shared `swapDoc`. So the subtle half —
which doc lands on which stack, and where a redone log entry re-inserts — is pure array
bookkeeping with no store, no React and no I/O, and has its own focused suite alongside the
controller's end-to-end coverage.

Two incidental guarantees the inline version had are now explicit: `restore` copies the arrays it
is given (the old code was accidentally safe because its `.slice()` always produced a fresh one),
and `snapshot` returns copies so a serializer cannot observe the live stacks changing.

### `runtimeTransforms` (`store/runtimeTransforms.ts`)

Pure `StudioRuntime → StudioRuntime` transforms for the host-injected data sources — the
counterpart to what `applyMutation` is for `doc`.

The two partitions differ in a way that shapes the file. `doc` is persisted and undoable, so its
reducer lives in the shared schema package and runs on both sides of the wire. `runtime` is
neither — host-injected live data that must never be persisted or reverted by an undo — so it
stays in this package and needs no mutation vocabulary. What it does need is the same
**discipline**: one place that decides what a write does, returning the SAME runtime object when
nothing changed, so `commitRuntime` can treat a logical no-op as a no-op.

Cache eviction deliberately stays in the controller. `studioRequestCache.invalidateSource(...)` is
an I/O side effect on a module-level singleton, and interleaving it with state computation is what
made these writers hard to read: `upsertDataSource` used to check existence, resolve the adapter,
evict the cache and commit with the early returns of three concerns braided together. Each
transform now answers only "what is the next runtime"; the controller decides what to evict, and
evicts only when the write actually lands.

### Authoring-time widget sanitization (`engine/widgetConfigSanitization.ts`)

`sanitizeWidgetForCreate`, `sanitizeWidgetConfigForKind` and `applyInferredTitles` were private
`StudioController` members that never touched the store — pure `widget → widget` /
`config → config` functions living in a class only because that is where their callers happened
to be. They now sit beside `stripKeys` / `resolveEffectiveChartType` /
`sanitizeWidgetConfigForChartType`, which they compose.

### `StudioController` (`store/StudioController.ts`)

Wraps a `Store<StudioState>` from `@mui/x-internals/store` — a minimal observable (`state`, `subscribe`, `setState`, `getSnapshot`) built to back `useSyncExternalStore`. State is never mutated in place; every method computes a new object and passes it to a private `commitState`, which:

- Pushes the previous **`doc`** onto the undo stack (`StudioDoc[]`, capped at `MAX_UNDO_HISTORY = 100`) — only when `nextState.doc !== current.doc` by reference. A commit touching only `session`/`runtime` takes effect immediately but creates **no** undo entry regardless of the `undoable` flag.
- Clears the redo stack on every new undoable doc commit.
- Optionally appends a `{ label, at }` entry to the capped recent-mutation log (`MAX_MUTATION_LOG = 20`), surfaced to the AI via `getRecentMutations()`.
- Calls `store.setState(next)`, notifying subscribers synchronously.

**Undoability policy.** `{ undoable: false }` suppresses the undo entry even when the doc changed. It is for writes the user did not author as a document edit: interactive-filter selection, `setGlobalCrossFilterMode`/`setCrossFilterAllPages`, `setActivePage` navigation, AI chat-thread writes, and _system-initiated self-repair_ (for example, `KpiSetupPanel` fixing an invalid stored aggregation, `StudioDateRangeBar` expanding a persisted date-range preset to cover late-injected sources). A plain undoable commit fired from merely rendering a panel would push an unauthored undo entry and, when re-triggered after an undo, clear the redo stack — trapping the stack for as long as the panel stays open.

**`{ undoable: false }` is not a coalescing tool.** Every field it is used for is one `carryTransientDocState` carries across an undo's doc swap (interactive filters, the two cross-filter toggles, `activePageId`, `ai`). A non-undoable write to any _other_ `doc` field is silently reverted by the next unrelated Ctrl+Z — the swapped-in doc simply doesn't contain it — with no redo entry to recover from, and it leaves a mutation-log line `undo()` cannot retract (there is no paired `undoMutationLog` entry). The grid's edit-mode header sort used to be exactly that (F2). A multi-commit gesture is coalesced with **`foldUndoHistorySince`** instead; see [the grid widget](../x-studio/ARCHITECTURE.md#other-built-in-widgets).

**Mutation-log labeling policy.** The log push is gated only on the doc actually changing, **not** on `undoable` — a non-undoable but genuine document change (`applyExternalMutation`'s `setActivePage`/`renameAIThread`) is still a real AI-authored change the model's change log must surface.

The log exists to tell the model **what the user just changed**, it is capped at 20 entries, and the same mutation arriving over the wire is always logged (`applyExternalMutation` passes `mutationLabel(mutation)`). Silence is therefore not neutral: it makes `getRecentMutations()` report the assistant's edits while hiding the user's. The rule, applied writer by writer:

- **A change to the dashboard's DEFINITION is logged** — expression fields, relationships, filter presets, the three date-range setters, the cross-filter mode toggles, `reorderPages`, `updateActivePage`, `toggleFilter`, `setPageStackBreakpoint`, `duplicateWidget`. These are authored edits, and the log is the only place they surface as an event.
- **A change to the VIEWING POSITION, or a transient interaction, is not** — `setActivePage`, `applyInteractiveFilter`, `clearInteractiveFilter`, `clearAllCrossFilters`. The state each produces is already described in the prompt's `<dashboard_state>` block on every request, so a log line duplicates what the model has while evicting something it does not.
- **System-initiated self-repair is not** — signalled by `{ undoable: false }` on `updateWidgetConfig`/`updateFilter`. Same capacity argument: a synthetic repair line could evict a genuine user entry.

Nineteen writers moved from silent to logged on this rule. Four stay silent and say why at the call site; the rule itself is documented on `StudioController` above `applyInteractiveFilter`.

**A label is still opt-out rather than automatic.** `commitMutation` uses the reducer's own `label(args)` unless the writer passes `label: null`, so the default is now "logged", and a writer that wants silence has to ask for it and justify it. That is the inversion of the earlier arrangement, where `commitDocPatch` logged nothing unless asked and roughly nineteen writers never asked — so `getRecentMutations()` showed the assistant's widget edits while saying nothing about "created a calculated field", "changed the date range", or "applied a saved view".

`updateWidget` (which carries the broader edit: title, subtitle, kind, sourceId, plus folded stale-filter removals) and `duplicateWidget` (labeled `addWidget:<kind>:<id>`, matching `insertWidgetAt`, because a duplicate _is_ a widget creation) both previously inherited `label: null` from their pre-reducer hand-written implementations. That mattered for the same reason: the identical mutations arriving over the wire _are_ logged, so the log reported the assistant's own widget edits while hiding the user's.

**Undo/redo log reconciliation.** Every undoable commit also pushes its (possibly `null`) log entry onto a parallel `undoMutationLog` stack, 1:1 length-matched with the `StudioDoc[]` undo stack. `undo()` pops the paired entry, removes it from `mutationLog` by reference (it may already have scrolled out — `mutationLog` is capped independently), and pushes it onto `redoMutationLog`; `redo()` reverses the transfer.

`redo()` does **not** blindly re-append at the tail. A non-undoable but _labeled_ commit can land between an entry's undo and its redo without clearing the redo stack, so a genuinely newer entry may already sit there. Each entry therefore carries an exact insertion order from a private monotonic sequence counter held in a `WeakMap` — not the public `at` ISO timestamp, whose millisecond resolution ties across same-millisecond commits (routine in tests, reachable with two AI-tool mutations in one turn). `redo()` re-inserts just before the first entry with a strictly greater sequence number.

### Composition helpers

Each is the one-liner base for a family of writers, so no method hand-spreads the nested partition structure:

- `commitDocPatch(patch, options?)` — shallow-merges a `Partial<StudioDoc>`, with a reference-equality no-op guard (a patch whose every key is reference-equal commits nothing). **The guard is `===`, so it cannot see a fresh-but-equivalent object.** A writer that _rebuilds_ its slice from scratch (rather than reusing existing element references) therefore needs its own value-equality bail, or a semantically identical re-invocation pushes an undo entry, writes a mutation-log line, and clears the redo stack. The controller-managed filter rebuilders — the three date-range setters and `applyCrossFilter` — all share `docTransforms.isSameManagedFilterContent` for exactly this.
- `commitShellPatch(patch)` — merges onto `session.shell`, always non-undoable.
- `commitDataSourcePatch(sourceId, patch)` — merges onto one `runtime.dataSources` entry, always non-undoable, no-op on a missing source.
- `updateState({ doc?, session?, runtime? })` — partition-aware partial update; callers name the partition explicitly.

**Value-equality bail before committing.** Several writers build a fresh object unconditionally (`{ ...x, ...changes }`), which defeats `commitDocPatch`'s reference guard even when every patched key already holds its incoming value — the commit still pushes a no-op undo entry and wipes the redo stack. `reorderPages`, `setPageStackBreakpoint`, `updateActivePage`, `updateRelationship`, `updateExpressionField`, `updateFilter`, `renameFilterPreset`, `updateDataSourceField`, `setGlobalCrossFilterMode`, and `setCrossFilterAllPages` all compare every key the patch would touch and return without committing when they all match.

`setAdjacentWidgetColSpans` deliberately does **not** carry its own copy of this guard. It commits through the reducer (below), whose `applyBulkUpdate` handler compares the normalized spans to the page's by value (`spansEqual`) and returns the same doc when nothing changed — which `commitMutations` already turns into a clean no-op. A zero-movement resize-handle pointerup is caught there instead of here, so the rule stays in one place.

### The `commitMutation` choke-point

Every user-driven method with a shared `StateMutation` equivalent, and every AI mutation, funnels through one private helper: `commitMutations(mutations, { label?, undoable?, transform?, resolveUndoable? })`. It folds an ordered sequence of `StateMutation`s through the shared `applyMutation` reducer with `reduce` and commits the final state as **one** undoable step, one subscriber notification, one log line (labeled by joining the mutations' own `mutationLabel`s with `' + '`). `commitMutation` is the single-mutation wrapper.

Because the reducer is pure, the whole fold happens before the store is touched. This lets a composite gesture converge on the reducer without a bespoke `StateMutation` variant — a cross-page move is two `setWidgetLayout`s; a compose-drawer insert is `addWidget` + `setWidgetLayout`; a duplicate is `addWidget` + `setWidgetLayout` + one `addFilter` per cloned filter. **Adding a wire-reachable variant is still deliberately avoided** — each one widens what a server can make this client apply. That is now the only thing it widens. The mutation vocabulary is split in the schema package: `WireStateMutation` is what `parseStateMutation`'s validator table is keyed on, and `InternalStateMutation` is what the client may issue but the wire may not carry. `StateMutation` is their union and is what the reducer handles.

That split is what unblocked routing client-only writes through the reducer. While the two questions — _should the reducer own this write?_ and _should a remote party be able to perform it?_ — had one answer, the second (correctly cautious) suppressed the first, and 25 controller writers committed through `commitDocPatch` outside every invariant the reducer upholds. The `dependsOn` cascade, the filter-scope screen and the rank-conflict guard each had to be re-implemented by hand at those sites; the cascade helper had to be _published_ from the schema package for the purpose. **Every doc write now routes through the reducer** — all 25 former bypass writers, in five batches: the filter writes, relationships and expression fields, filter presets and managed date-range filters, dashboard/page-record writes, and the two managed-filter applications. `commitDocPatch` has been **deleted**: with no call sites left, removing the escape hatch is what keeps the invariant true, since there is no longer a way to write the doc without a mutation. `commitShellPatch` (session) and `commitDataSourcePatch` (runtime) remain — those partitions are deliberately outside the reducer.

Two divisions of labor recur and are worth stating, because they are what made the migration safe rather than merely possible. **Screening stays with the writer** whenever it owes its caller a reason: `MUTATION_INVALID`, `MUTATION_NOT_FOUND`, `MUTATION_RANK_CONFLICT` and `MUTATION_DUPLICATE_ID` are distinctions the reducer's "returns the same doc when it declines" contract cannot make. And **id minting stays with the caller** — `applyCrossFilter` builds its filter with a fresh `createFilterId()` before handing it over, exactly as `addWidget`/`addPage` already did, because the reducer must remain a pure function of `(doc, args)`.

The writers that carried no mutation-log label through the migration have since been resolved one at a time against the labeling policy above — nineteen now log, four stay deliberately silent. That was held back from the migration commits on purpose: it is a behavior change the model sees, so it belonged in its own decision rather than riding along with a routing change.

Three subtleties:

- A commit is skipped entirely when the reducer returns the same state reference (unknown id, already applied).
- The no-op check runs on **`transform`'s output**, not the raw fold result, and `transform` always runs. Some callers (`updateWidget` re-triggering title inference off an idempotent payload) rely on `transform` alone to produce the real change. To avoid reintroducing spurious commits, the shell-selection transforms guard on the target widget's actual post-fold presence, and `applyInferredTitles` returns its input unchanged when the inferred _text_ didn't change.
- Every `transform` guards with `Object.hasOwn(next.doc.widgets, widgetId)` before dereferencing — the transform runs even on a no-op fold, so a stale id from a custom setup panel or a race with an AI `removeWidget` would otherwise throw.

**AI mutations**: `applyExternalMutation(mutation, label?)` is the wire-adjacent public wrapper. It classifies a transient-only doc diff (a `setActivePage`/`renamePage`-shaped mutation that must stay non-undoable) via a `resolveUndoable` callback evaluated against the fold's own result, rather than running the reducer a second time.

**`updateWidget`'s `undefined`-voiding is wire-safe.** Callers void a top-level field by passing explicit `undefined`, but the reducer skips `undefined`-valued `changes` keys (an `undefined` can never survive JSON). So `updateWidget` splits `changes` into real-valued keys (→ `args.changes`) and explicitly-undefined keys (→ `args.unsetFields`, which the reducer deletes). Required fields (`kind`/`title`/`config`) are never voidable.

**`updateWidgetConfig`'s write-side key guard.** `StudioWidgetConfigForKind<K>` only constrains code that reads `widget.config` _after_ narrowing on `kind`/`chartType`; this method is generic because it patches before any narrowing. It runs the patch through the schema package's key validators two layers deep — `validateConfigKeysForKind`, then (for a chart) `validateChartConfigKeysForType` against the effective chart type. Unlike the AI tool boundary (which rejects the call), this is **warn-and-strip**: a stray key reaching here is a UI bug, not untrusted input. Both layers validate only the incoming **patch**, never the stored config — key retention across `chartType` switches is a deliberate feature (see [chart config retention](../x-studio/ARCHITECTURE.md#chart-config-retention-across-type-switch)).

**The one place stored config IS re-validated: a kind-only flip to `'chart'`.** `updateWidget(id, { kind: 'chart' })` with no `config` in `changes` skips the guard above entirely (it is gated on `Object.hasOwn(changes, 'config')`), and the reducer's kind-coherence pass does not cover the gap either — it strips keys not _allowed_ for the new kind, and `chartType` is a perfectly allowed `'chart'` key, so a bogus **value** was retained. Since `sanitizeWidgetForCreate` returns early on `kind !== 'chart'`, a widget created as a non-chart kind carrying `config.chartType: '<nonsense>'` became a chart widget with a chart type outside `StudioChartType`. `updateWidget` now re-runs `sanitizeWidgetForCreate` on that flip.

Deliberately `sanitizeWidgetForCreate`, **not** the two key validators: those would strip the retained-key feature above, whereas this repair touches the config only when an own, non-`undefined` `chartType` fails `isStudioChartType`, and it is the same helper `addWidget`/`insertWidgetAt`/`duplicateWidget` run — one implementation of the repair rather than a second that could drift. It returns the same object reference when there is nothing to repair, and the controller only adds `config` to the mutation when that reference changed, so an ordinary kind flip cannot push a spurious undo entry.

Closing that route means **no supported call sequence now reaches a chart-kind widget with an invalid `chartType`** (`updateWidgetConfig` normalizes it; `updateWidget`'s `changes.config` path drops it). `duplicateWidget`'s identical repair is therefore defense in depth rather than live code — kept because the create-shaped entry points it shares the helper with _are_ reachable with hostile input, and its test says so explicitly rather than implying a public route exists.

### Cross-page moves and rank-filter uniqueness

`moveWidget` (canvas drag-and-drop) and `moveWidgetToPage` (context menu) share a private `commitWidgetMove` core. It composes the source/target `setWidgetLayout` pair and folds two kinds of cleanup into the **same** commit, so a drop and its consequences are one undo step:

1. **Rank-filter conflict.** A widget-scoped rank (Top-N) filter follows its widget; its page context is resolved from that page's `widgetRows` via `resolveRankFilterPageId`. Moving a rank-filtered widget onto a page that already has a conflicting rank filter would land two in one page context — the state `addFilter`/`updateFilter`/`duplicateWidget` reject and the filters drawer assumes cannot exist. The move drops the moved widget's filter, guard-and-continue, via the shared `hasConflictingRankFilter` check (modeling the widget's post-move context as page-scoped on `targetPageId`, since it isn't on that page yet).

   The `removeFilter` mutation is **unshifted** ahead of the layout mutations, not pushed after them. `setWidgetLayout` re-runs the reducer's own array-order rank-uniqueness sweep, which breaks a tie by array position (matching the load boundary) and could therefore drop the _target_ page's resident filter instead. The controller's policy is the more specific one — **the widget you just moved yields to the page it moved into** — so it must resolve the conflict first, leaving the reducer's sweep nothing to do. This is an ordering fix; neither rule is weakened.

2. **Emitted-scope cleanup.** Every filter the moved widget _emits_ whose scope is pinned to the source page — `interactive` (filter-widget/slider) selections and `cross-filter` (chart-click) entries, both keyed by `scope.sourceWidgetId` with a `scope.pageId` — is removed. The move rewrites layouts only; those `scope.pageId`s would keep pointing at the source page, leaving the old page hard-filtered with no controlling widget while the control on the new page advertises a live-looking selection that filters nothing. A selection made in page A's context has no defined meaning on page B. Widget-scoped rank filters travel with the widget under a different `scope.kind`, so the two loops never overlap.

Both cleanups are scoped to `sourcePageId !== targetPageId`; a same-page move cannot create either problem.

**Staleness guards.** `moveWidget`'s `sourcePageId` is captured at drag-start, so it re-resolves the widget's actual current page via `resolveWidgetPageId` right before committing (dev-warning on disagreement) — a concurrent relocation mid-drag would otherwise clear a page the widget no longer lives on while still appending it to the target, duplicating it across two pages' rows. `moveWidgetToPage` resolves its source page the same way rather than assuming the active page. Both no-op when `targetPageId` no longer exists in `doc.pages`.

`duplicateWidget` runs the same `hasConflictingRankFilter` check on cloned filters: the clone always lands on the active page, so a cloned rank filter would resolve to the same page context as the source widget's own. The reducer's `addFilter` handler applies a mutation verbatim with no rank check, so without the guard the invariant violation would persist into the saved doc.

### Drag-and-drop, layout, and orphan detection

The canvas owns only geometry/splice math. Drops commit via `controller.insertWidgetAt(widget, pageId, rows)` or `controller.moveWidget(widgetId, sourcePageId, pageId, targetRows)`, so drag-and-drop, keyboard reorder (`setWidgetLayout`), and the AI path share one column-span-cleanup implementation (the reducer's `enforceLayoutColSpans`).

**Resize is a fourth writer, and it goes through that implementation too.** `setAdjacentWidgetColSpans` commits a spans-only `applyBulkUpdate` mutation (`widgetColSpans` present, `widgetRows` deliberately absent — "merge these widths onto the page's existing map and rebalance the affected rows around them", targeting the active page), so `rebalanceRowSpans` + `enforceLayoutColSpans` run on a drag-resize exactly as they do on a drop, a keyboard reorder and an AI `set_widget_width`. An over-budget row can no longer reach the doc, which is what used to make `normalizePersistedPages`' individual-span-only clamp at load a problem.

`applyBulkUpdate` is the right entry point rather than two folded `setWidgetColSpan` mutations: a resize moves one budget between two widgets, so both must be **anchors** of a single rebalance. Applied one after the other, the second would treat the first widget as an absorber and could clear the span the same gesture just set.

Per-side minimums are still resolved in the controller before the reducer sees them — `getWidgetMinSpan` knows a sparkline-less KPI may go narrower, a vocabulary the pure reducer does not have — and are floored at the reducer's own `MIN_SPAN`, the narrowest width the document can represent. The canvas still runs `resolveResizePair` (`x-studio`'s `components/StudioCanvas/rowColSpans.ts`), but now only to cap what a resize may _propose_ using the reducer's own `0`-for-missing accounting, so the rendered and persisted views can never disagree about whether a row fits. The reducer has the last word either way.

Unlike public `setWidgetLayout` (which throws on unknown/omitted widget ids), `insertWidgetAt`/`commitWidgetMove`/`duplicateWidget` accept caller-computed geometry with no validation, so a canvas bug could silently orphan a widget (present in `doc.widgets`, absent from every page's rows). `warnOnOrphanedWidgets` is a dev-mode diagnostic run after `insertWidgetAt` and `duplicateWidget` that scans for exactly that.

**`setWidgetLayout` takes the page it operates on as a parameter** (`setWidgetLayout(rows, pageId?)`, defaulting to the active page), because its validation and its caller's row computation must resolve the _same_ page (F3). It used to validate — and stamp the mutation — against `getActivePage()`, while its one caller, `StudioWidgetCard`'s keyboard reorder, builds rows from `pages[pageId]`, the card's own page and a public prop. The two agreed only because `StudioCanvas` renders non-active pages `inert`: a rendering guarantee, three files away from the invariant it upheld. A host rendering the exported `StudioWidgetCard` for a non-active page and using the move control got an uncaught throw from inside a DOM event handler — where `StudioWidgetErrorBoundary` cannot reach it. Both throw messages now name the page they validated against; neither carries AI-tool guidance any more, since the AI `set_widget_layout` path never reaches this method (it goes through `applyExternalMutation`, and its own validation lives in `executeToolOnState.ts`).

Layout math lives in the 24-column unit system: `GRID_COLS = 24`, `MIN_SPAN = GRID_COLS / 4`, both exported from the schema package's `applyMutation.ts` so a manual drag-resize and an AI `set_widget_width` clamp identically. `setAdjacentWidgetColSpans` validates both ids exist and share a row before acting, and floors the right widget's span at its own minimum when the pair's combined minimums exceed the total — mirroring `enforceLayoutColSpans`: favour widening over ever committing a sub-minimum span. The pair may then sum to more than the pre-drag total, which is safe rather than a tradeoff, since `rebalanceRowSpans` re-fits the whole row inside `GRID_COLS` afterwards.

`MAX_PER_ROW = floor(GRID_COLS / MIN_SPAN)` (4) is exported from `x-studio`'s `components/StudioCanvas/canvasGridConstants.ts` — the one definition. A fifth widget in a row is not merely cramped: every span falls to `round(24/5) = 5`, below `MIN_SPAN`, so every divider in the row gets `minLeft > maxLeft` and `RowResizeHandle`'s clamp turns every arrow key and pointer drag into a permanent no-op. Three paths enforce it. `WidgetGap`/`InsertionPoint` refuse a drop that would grow a full row (a reorder _within_ the row is not a growth and stays droppable), with `StudioPageRows.insertIntoRow` splicing a new row below as defense in depth for programmatic drops. Keyboard move (`engine/widgetLayoutMove.ts`) and `duplicateWidget` splice a new row rather than overflowing a full one. Those last two still re-derive the constant locally; they should import it.

**One meaning for a missing `widgetColSpans` entry.** `widgetColSpans` is sparse — a widget that was never resized has no entry — and the canvas reads that absence as _an equal share of the row_, `round(GRID_COLS / row.length)`, via `resolveRowColSpans`. Edit mode's flex-grow, view mode's flex-basis, the resize handles and the divider overlay all go through it, and it scales an over-budget row back into `GRID_COLS` so no consumer can render one. The reducer's own accounting still counts a missing entry as `0`, which is why `16 + 0 + 8 = 24` looks in budget to `enforceLayoutColSpans` while the row actually wants `16 + 8 + 8 = 32`; `resolveResizePair` bridges the two so a resize can never persist the difference.

### Controller-owned methods (no `StateMutation` equivalent, by design)

Shell/selection, data-source injection (`upsertDataSource`, `setDataSourceRows`, `setDataSourceAdapter`, `updateDataSourceField`), transient interactive filters, cross-filters, filter presets, relationships, expression fields, date-range filter building, and `reorderPages`. These either touch React/runtime-only state the dependency-free reducer must never own, or are multi-step compositions with no wire-facing variant.

Notable invariants among them:

- **`applyInteractiveFilter`/`applyCrossFilter` stamp `scope.pageId` with the _emitting widget's own page_** (via `resolveWidgetPageId`, falling back to `activePageId` only when the widget is on no page) — not the live `activePageId` at commit time. A debounced commit (`DateRangeControl` debounces 300ms) firing after a page switch would otherwise pin the filter to the wrong page.
- **`applyCrossFilter` centrally gates on the effective cross-filter mode** (`doc.dashboard.globalCrossFilterMode ?? sourceWidget.config?.crossFilterMode ?? 'cross-highlight'`), no-opping when it resolves to `'none'`. One enforcement point for every widget kind's click handler, rather than each widget duplicating (or omitting) the check.
- **`applyCrossFilter` also bails on a value-identical re-apply** (`docTransforms.isSameManagedFilterContent(existing, candidate, { ignoreId: true })`, plus a separate `disabled` check so re-emitting can still re-enable a switched-off entry). It mints a fresh `createFilterId()` on every call, which defeats `commitDocPatch`'s reference guard — without this, re-applying the same source widget + field + value + operator committed an undoable, logged step and wiped the redo stack. The built-in chart/grid/map click handlers toggle-clear on an identical field+value so they never reach it, but direct `controller.applyCrossFilter(…)` callers (custom widgets, host code) have no such toggle.
- Both no-op when the source widget no longer exists, mirroring the reducer's own existence check. Cross-filter/interactive entries are hidden from the filters drawer, so an orphaned hard-filter installed by a late debounced commit would have no UI left to clear it.
- **Expression-field cycle guard**: `addExpressionField`/`updateExpressionField` run `hasExpressionCycle`/`detectCycles` and reject (dev-warn, no-op) a cyclic formula, so a persisted doc or host call can't slip one past the dialog's own check. As second-line defense, `evaluateExpression` carries a `resolvingFieldIds` visited set that short-circuits to `null` rather than recursing forever.

### Undo/redo cross-partition fix-ups

`undo()`/`redo()` swap **only** the `doc` partition; `session`/`runtime` carry forward, so time-travel never touches mode, selection, or live data. Three deliberate fix-ups live here:

- **`carryTransientDocState`** overlays the current doc's non-undoable transient `doc` state onto the swapped-in doc: interactive-filter selections, the `globalCrossFilterMode`/`crossFilterAllPages` toggles, and `doc.ai` (chat threads, written non-undoably on every streamed token). A Ctrl+Z on an unrelated edit must not revert any of them. Cross-filter entries are **not** carried — they are undoable by design. Each carried interactive filter's `scope.pageId` is _re-derived_ against the emitting widget's page in the **incoming** doc (via `resolveWidgetPageIdInDoc`), so undoing a widget's cross-page move makes its selection follow the widget back rather than keeping a stale new-page id. **`doc.widgets` is taken wholesale from the swapped-in doc** — nothing in it is carried, and nothing in it should be written non-undoably (see the [undoability policy](#studiocontroller-storestudiocontrollerts)); `doc.ai` can be overlaid only because it has exactly one writer, all of it non-undoable, whereas widget config is written by both kinds of caller.
- **`activePageId`** is re-derived, not carried: it overlays the current value only when the incoming doc actually contains that page, else falls back to the incoming doc's first page — so undoing `addPage` (which removes the page being viewed), or redoing `removePage`, lands somewhere real.
- **`normalizeSessionAfterDocSwap`** nulls `shell.selectedWidgetId` when the swapped-in doc no longer contains it. It is also invoked directly by `removeWidget`, `removePage`, and `applyExternalMutation` — a user-driven removal or an AI mutation can dangle the selection just as easily as time-travel can, and a dangling id renders the compose drawer blank instead of the add-widget view. `selectedSourceId`/`selectedFieldId` reference `runtime.dataSources`, which undo never touches, so they cannot dangle.

### Extracted pure `doc` transforms

Two families of `StudioDoc → StudioDoc` logic live outside the controller class so the methods stay thin wrappers. Each returns the **same** `doc` reference for a logical no-op, so `commitDocPatch`'s guard behaves exactly as it would inline.

**`docTransforms.ts` (schema package)** — date-range setters (`setDashboardDateRange`, `setDashboardDateRangeAll`, `setWidgetDateRange`, sharing one `buildDateRangeFilter`) and filter-preset operations.

- `buildDateRangeFilter` encodes the custom-vs-preset value logic once: `'custom'` stores explicit `{from,to}`; every other preset stores `value: null`, resolved fresh at query time by `resolveDateRangePreset`, so a stored filter is never a stale absolute date.
- `setDashboardDateRangeAll` is **additive and field-preserving**, not rebuild-all: it indexes each page's existing `dashboard-date-range` filters by source, reuses an existing filter's `id`/`field`/`fieldType`, and mints a fresh filter only for a source not yet covered. This matters most for `'custom'`, where `StudioDateRangeBar`'s reconciliation effect threads the existing filter's bounds back through as `customFrom`/`customTo`. A rebuild-all produced an empty filter set whose length mismatch triggered a full non-undoable removal of every custom date-range filter — the Select silently flipping to "All time" with no Ctrl+Z recovery.
- Filter presets round-trip cascading references: `saveFilterPreset` re-keys each captured filter's id to `${presetId}-${f.id}` and rewrites `dependsOn` through the same scheme (dropping references outside the captured set); `applyFilterPreset` builds an oldId→freshId map up front and rewrites `dependsOn` through it. Both guard with `Array.isArray(f.dependsOn)` and explicitly null out a wrong-shaped value rather than letting the spread carry it through to a `TypeError`.
- `applyFilterPreset` retains every non-page filter, every page filter scoped to another page, **and every legacy `pageId`-less page filter** unconditionally. Those legacy entries apply to _every_ page (`selectFiltersForWidget`'s `!pageId` branch), so deleting them on any preset apply wiped an all-pages filter from the whole dashboard, not just the targeted page. It also runs each re-materialized rank filter through `hasConflictingRankFilter` (weighed against retained widget-scoped filters plus preset filters already accepted in the same apply), since `saveFilterPreset` applies no rank exclusion when capturing.

**`engine/rankFilterScope.ts`** — re-exports `resolveRankFilterPageId`/`hasConflictingRankFilter` from the schema package rather than maintaining a hand-synced copy. The reducer needs its own implementation and the dependency arrow forbids it importing a client copy, so the client re-exports the schema package's. One rank filter per page context, shared by `addFilter`, `updateFilter`, `commitWidgetMove`, `duplicateWidget`, `applyFilterPreset`, and the drawer rows.

### Data-source and adapter bookkeeping

The recurring hazard here is a **refetch loop**: a host passing an inline `dataAdapters={{ orders: adapter }}` map plus an `onStateChange` that stores the new state gets commit → parent re-render → new inline identity → effect refires → commit. Both `setDataSourceAdapter` and `upsertDataSource` therefore early-return (no invalidation, no commit) when the resulting entry is reference-identical to the stored one. The adapter-carry branch always allocates a fresh object, so it still commits and invalidates as before.

- `upsertDataSource`/`setDataSourceAdapter` otherwise invalidate the module-singleton `studioRequestCache` for the affected source. Invalidation **generation-tags in-flight requests**: it bumps the source's generation so an in-flight result started before the invalidation is not written back, and a caller arriving after sees that entry as absent (via `getInflight`) and starts a fresh fetch rather than joining a promise that will resolve to pre-invalidation rows. A caller already awaiting the promise still receives its result.
- `upsertDataSource` with a bare `dataSource` (no `adapter` field — for example, from a `StudioDashboard` config swap, which round-trips through JSON) **preserves** an adapter previously registered on that id; an incoming source carrying its own adapter still wins. Cache invalidation runs regardless of whether either entry carries an adapter, so a config swap can never serve pre-swap rows.
- `StudioRequestCache` (30s TTL, in-flight dedup) caps its entry count (LRU, expired swept first) on every `set()` rather than only evicting on re-request after TTL — each filter/date-range tweak mints a new `cacheKey`, so the module singleton would otherwise grow monotonically across a session.
- `setDataSourceAdapter` no-ops when the target source doesn't exist yet, which the same-reference guard cannot close on its own. The fix lives in the caller that owns both the config and the adapter map — see [`StudioDashboard`](../x-studio/ARCHITECTURE.md#studiodashboards-config-swap-protocol).

**`StudioDataSource.rows === undefined` is a third state, not an empty array.** The adapter path resolves rows **per widget** into `studioRequestCache` and never writes them back onto the source; only the host's imperative `setDataSourceRows` does. So an adapter-backed source's `rows` normally stays `undefined` for the whole session, and `rows ?? []` / `rows?.length ?? 0` silently converts "never measured" into the positive claim "measured, and the answer is zero/none". `engine/dataSourceRowState.ts` names the tri-state — `getDataSourceRowState(source)` returns `'unavailable' | 'empty' | 'data'`, and `isAwaitingDataSourceRows(source)` adds "and an adapter is expected to deliver them", that is, render a loading affordance rather than a count. Every UI that reports a row count, a distinct-value list, or an aggregate over a whole source routes through it: the data drawer's section caption and both preview-dialog titles, `DataSourcePreview`, the source/field preview tooltips, `StudioFilterWidget`'s option list and slider auto-range, and `ExpressionPreview`'s measure chip. This is the source-level form of the same rule the aggregation layer states for a single bucket — see [null means "unmeasured"](#one-numeric-coercion-policy).

**A rejected write says so, rather than looking like a save.** `addExpressionField`, `updateExpressionField`, `addRelationship`, `updateRelationship`, `addFilter` and `updateFilter` return a `StudioMutationResult` instead of `void`. A dialog that calls one and closes unconditionally would otherwise report a save that never happened, the failure invisible precisely because the doc is the only place the difference shows.

The result splits three ways, and the middle one is the point: `{ ok: true, committed: true }` (the write landed), `{ ok: true, committed: false }` (accepted but a value-equal no-op — a dialog should close normally on this; only a caller folding undo history has any reason to look), and `{ ok: false, reason }`. `StudioMutationRejectionReason` is `duplicate-id` | `not-found` | `cycle` | `rank-conflict` | `invalid` — deliberately excluding "nothing changed", which is the outcome the user asked for, not a failure. `rank-conflict` is the one-rank-filter-per-page-context invariant; `invalid` covers the whole set the shared reducer screens for and refuses without saying which (an unknown widget anchor, a `scope.pageId` naming a nonexistent page, a non-`StudioFilterOperator` operator, a malformed `scope`, a non-string `id`).

`StudioExpressionFieldDialog` and `RelationshipPanel` branch on it directly — the dialog gives `cycle` its own message, since that is the one reason the user can act on, and falls back to `localeText.saveRejectedMessage` otherwise. Both previously carried a "read the committed doc back and compare each patched key by reference" workaround; that is what the return type replaced.

**Deleting a calculated field asks first when it is referenced.** `getExpressionFieldReferenceCount` counts the widgets, filters (including `rankByField`/`rankMultiSeriesBy`), and sibling expressions that point at a field; `DataSourceSection` gates the delete action on it and shows a "used by N places" confirmation. Deletion is still guard-and-continue at the controller (nothing downstream crashes on a missing field id), so the confirmation is the only thing standing between a click and several widgets quietly rendering blank — in production the controller's dev warning does not exist.

## Data pipeline

The pipeline turns `dataSources[id].rows` into the rows a specific widget renders, in four numbered layers plus widget-facing hooks.

### L1 — Normalize (`engine/normalizedRowsCache.ts`)

`getCachedNormalizedDataSource(dataSource, usedFieldIds?)` calls `normalizeDataSourceRows` (`temporalUtils.ts`) to canonicalize date/datetime values and pre-build per-field distinct-value indexes, caching on a `WeakMap<Row[], Map<fieldSetKey, entry>>`. `usedFieldIds` scopes normalization to the fields a widget actually uses ("lazy-by-widget"), each field set getting its own slot, so adding an unused field to a different widget's config is zero cost.

**Nearly every foreign-source read goes through L1**, not `dataSources[id]?.rows` directly — all four of L4's foreign reads (anchor, junction, M:N-remote, and `enrichForeignExpressionFields`' owner rows), `dataSourceGraph`'s related-field enrichment (one-hop and two-hop), `crossSourceEnrichment`, and the CSV export. **Adapter responses count as foreign-source reads**: `useWidgetRows` wraps `adapterRows` in a synthetic `{ ...dataSource, rows: adapterRows }` and runs the same `getCachedNormalizedDataSource` call before L2 — memoized on the rows identity so the `WeakMap` slot is reused, and reusing the sync path's own slot outright for cold-cache placeholder rows (which _are_ `dataSource.rows`). Two failure modes justify this:

- The filter engine uses a local-calendar-day policy while the chart-grouping engine uses UTC components, so an un-normalized raw `Date`/timestamp buckets into different days for a non-UTC viewer. Both policies treat a canonical `YYYY-MM-DD` string identically.
- Worse, a raw `Date` through an expression's ordering comparator is outright wrong, not merely differently bucketed: the non-numeric fallback compares lexicographically, and `String(rawDate)` always sorts after any `YYYY-MM-DD` literal, so `>=` against a date literal evaluated `true` for every row regardless of the real date.

**Two exceptions, both known.** L3's cross-filter semi-join reads the foreign source's rows raw (`foreignSource.rows` straight into `getCachedEnrichedRows`), as does its two-hop junction walk; `filterUtils`' `toComparable` compensates at the filter boundary by routing its `date` branch through the exported `normalizeToDateOnlyString`. And the non-React `StudioPipeline` façade takes the widget's own rows as an argument documented "raw (pre-normalized)" — normalizing them is the caller's job, which `widgetExport` does and the benchmarks deliberately do not.

**The `date` and `datetime` branches normalize differently, on purpose.** For a **`date`** field, non-ISO or zone-ambiguous inputs (`'1/15/2024'`, a `Date`, a numeric timestamp) are read via local Y/M/D components (`isZonedDateInput`/`toLocalYmd`) rather than `toISOString()`, so ingestion doesn't day-shift for viewers ahead of UTC; canonical ISO strings are unaffected. For a **`datetime`** field the value must denote a definite instant, so every non-canonical input goes through `normalizeToDate(...).toISOString()` — a zone-less `'2024-01-15T23:30:00'` is parsed as local time and converted to real UTC, which is the whole point rather than a day-shift bug. `CANONICAL_DATETIME` requires the explicit `Z`, so offset forms (`+02:00`) are re-spelled too: unambiguous, but two spellings of one instant compare unequal in any string-keyed grouping.

The adapter case is the one where these inputs are the _norm_ rather than the exception: a zone-less `'2024-01-15T23:30:00'` is what MySQL/SQLite drivers routinely hand back, and it is precisely the shape `CANONICAL_DATETIME` refuses to accept as already-canonical. Skipping L1 there meant the same rows, the same dashboard, bucketed one way in memory and another through an adapter — the parity test in `useWidgetRows.test.ts` (run the same rows down both paths, assert identical canonical values) is the regression guard, and it holds in any timezone because it never asserts _which_ day is right, only that the two paths cannot disagree.

### L2 — Enrich (`engine/enrichedRowsCache.ts`)

`getCachedEnrichedRows(rows, sourceId, expressionFields, dataSources, relationships, usedFieldIds?)` evaluates non-measure `StudioExpressionField`s (calculated columns, including cross-source `JoinFieldExpression`s) via `enrichRowsWithExpressions` and merges the values onto each row.

- Two-level caching (`rows` WeakMap → `fieldSetKey` Map). An entry is invalidated only if its own rows changed, a _relevant_ expression-field object changed by reference (editing a formula replaces the object), a joined foreign source's rows changed, or a relevant relationship changed.
- `expandWithDependencies` walks each requested field's transitive expression dependencies (field A referencing field B pulls B in), so a widget only pays for the expressions it needs.
- **Measure expressions (`isMeasure: true`) are excluded from row-level enrichment entirely** — a measure's value doesn't exist per row.
- The ordering comparators (`<`, `>`, `<=`, `>=`) are null-safe and type-aware: they return `null` when either operand is null/undefined (propagating "unknown" the way the other null-aware operators do), and otherwise compare numeric-like operands numerically or fall back to a lexicographic string comparison — which also orders `YYYY-MM-DD` strings correctly with no date parsing. Coercing both sides through `toNumber` (which maps `null` and non-numeric strings to `0`, including any ISO date string) made every date comparison a constant.
- **The equality operators (`equals`, `notEqual`, `in`) use the filter engine's explicit comparison policy, never loose `==`.** `scalarEquals` mirrors `filterUtils`' `compileSingleCondition`: nullish equals only nullish; both sides numeric-like (numbers and cleanly-parsing non-blank strings — deliberately excluding booleans, exactly as `toNumericValue` does) compare as numbers so `'20'` still equals `20`; everything else compares `String(a) === String(b)`. Loose `==` cross-coerces (`'' == 0`, `false == '0'`, `true == 1`), so a CSV whose blank numeric cells import as `''` made `sum(if(discount == 0, 1, 0))` count every blank row as a genuine zero while the identical question asked as a filter excluded them — two answers to one question, breaking the "a KPI over a raw field and over a measure expression return the same number" invariant. `in` routes through the same helper, so `in(x, a, b)` is exactly `equals(x, a) || equals(x, b)`.
- `isTrue`/`isFalse` stay strict — they ask "is this the boolean true/false", not the truthiness question `and`/`or`/`if` ask through `toBoolean` — but they accept the `'true'`/`'false'` string form a CSV/API boolean column carries, matching `toBoolean` and `filterUtils`' string-comparing `fieldType: 'boolean'` branch. Otherwise one string-boolean column got three different answers from `isTrue`, `if`, and an equivalent filter.
- **`JoinFieldExpression` resolution is direction-independent.** `findJoinFields` matches a direct relationship with the evaluating source at _either_ end (and skips `many-to-many`, whose two fields are endpoint keys rather than an FK/PK pair), so a relationship declared from the "one" side resolves `join(customers.country)` on `orders` the same way `createBatchingAdapter.resolveField` always has. The fast (prebuilt index) and slow (per-row fallback) paths call the one helper, so they cannot drift. `enrichedRowsCache`'s `relevantRelationships` filter carries the **same** predicate — widening one without the other opens a cache-invalidation hole where an edit to a reverse-declared relationship changes the joined values while leaving `relRefs` untouched.

### L3 — Filter (`engine/filterScoping.ts`, `dataSourceGraph.ts`, `resolvedRowsCache.ts`)

**1. Scoping** — `selectFiltersForWidget(filters, { widgetId, widgetSourceId, activePageId, include, crossFilterAllPages, includeWidgetRank })` is the single source of truth for _which_ filters apply to a widget. It switches on `scope.kind` and then runs `resolveDateRangePresets` to turn a stored preset into concrete bounds computed at query time. Disabled filters are dropped up front.

`include` gates **only the two interaction-driven scope kinds**. `page`, `widget` and `dashboard-date-range` are authored filters and are considered for every value:

| `include`          | Scope kinds returned                                                  |
| :----------------- | :-------------------------------------------------------------------- |
| `'all'` (default)  | page + widget + **dashboard-date-range** + cross-filter + interactive |
| `'no-cross'`       | page + widget + **dashboard-date-range**                              |
| `'no-chart-cross'` | the above + interactive (no `cross-filter`)                           |

The `dashboard-date-range` term is load-bearing, not incidental: `useBlendedSeriesRows` passes `'no-cross'` precisely to get the page + dashboard-date-range set for a foreign series' source. Reading `'no-cross'` as "page + widget only" describes behavior no caller wants.

**`activePageId === undefined` is a wildcard for every scope kind that carries a `pageId`** — page, cross-filter, interactive, dashboard-date-range alike. This matters for the non-React `StudioPipeline` (CSV export, benchmarks, tests), documented to run without page-navigation context: a caller in that position wants every authored filter to apply, not a mix where page filters are silently dropped while cross/interactive filters from every page are kept.

**2. Widget-scoped rank (Top-N)** — `includeWidgetRank` (default `false`) opts a caller into also returning a widget-scoped `filterMode: 'rank'` filter. The invariant is **a widget-scoped rank is applied exactly once, at either L3 or post-aggregation — never both, never neither**. `shouldApplyWidgetRankAtL3(widget)` (`engine/StudioPipeline.ts`) is the single decision:

- `true` for every non-chart kind (grid / KPI / map / pivot / filter / text / custom) **and** for the chart families that aggregate rows directly with no post-aggregation rank step (heatmap / funnel / sankey / gantt / scatter / gauge). These have no other enforcement point, so without L3 their authored Top-N would be silently ignored.
- `false` for the xy families (`bar*`, `line`, `area*`, `pie`, `donut`, `mixed`), which re-rank their aggregated series themselves via `applyRankToAggregated`/`applyRankToMultiSeries`/`applyRankToSeriesFieldData`. Applying at L3 too would double-reduce.
- A chart with no `chartType` resolves to `'bar'` via `resolveChartType`, matching what `StudioChartWidget` renders.

The family set backing it (`POST_AGGREGATION_RANK_CHART_TYPES`) is deliberately **not exported**, so no caller can re-derive the "is this a chart?" half of the rule and drift from it. Every path that resolves a widget's rows routes through the helper: `useWidgetRows`, `widgetExport.runWidgetExport`, and `generateInsight`'s AI summaries. `StudioKpiWidget` no longer calls `selectFiltersForWidget` (or this helper) at all — its five former call sites now share the one `kpiScopedFilters` value built from `useWidgetRows`' exposed sets, which is where the rank rule is applied. `StudioPipeline.resolveWidgetRows` applies it automatically when handed a `StudioWidget` object; the bare-id overload falls back to `false` and exists only for callers with no widget object (`richContext`'s dashboard-wide field stats, which uses a synthetic id no widget filter can match).

`queryDescriptor.ts` strips every `filterMode === 'rank'` leaf before building a server filter tree regardless of this flag — rank has no wire representation and is always applied client-side after the fetch.

**3. Row filtering** — `resolveRows` (`dataSourceGraph.ts`) separates _native_ filters (same source as the widget) from _cross-filters_ (`filterSourceId` differs, or the field is an expression owned by another source), resolves a `JoinPath` via `findJoinPath`, semi-joins the widget rows against matching foreign rows, and runs `applyFilters`/`compileRowTest` for the natives.

**Cross-source filters are grouped per foreign source and evaluated conjunctively, in one pass.** Every filter targeting source A is collected into one group, `applyFilters` runs the whole group over A's rows once, and a single semi-join keeps the widget rows that reach a surviving A row — `EXISTS(A₁ AND A₂)`, matching what L4's anchor-scoped re-application and SQL both do. Evaluating each filter with its own semi-join instead gives `EXISTS(A₁) AND EXISTS(A₂)`, which is weaker: two filters that no single foreign row satisfies together still pass, because different rows can satisfy them separately. Grouping also means one L2 enrichment per foreign source per call, so the old local dedup cache is gone.

`findJoinPath` resolves three shapes: a one-hop direct relationship; a two-hop join through a many-to-many junction filtering on the relationship's _remote_ endpoint; and a dedicated one-hop case for a `filterSourceId` naming an M:N relationship's **junction source** directly. That last case is a genuine semi-join against the junction's own rows — a junction is never a relationship's `sourceId`/`targetId`, only its `junctionSourceId`, so without it such a filter fell through to `null` and was silently dropped, letting two widgets on one page disagree about an identical nominal filter.

**A cross-source filter that cannot be evaluated fails OPEN, and says so.** Both unevaluable arms (no declared join path; the foreign source has no in-memory rows) skip the semi-join rather than emptying the widget. Fail-open is the deliberate choice — fail-closed would empty a widget _permanently_ whenever a cross-filter targets an adapter-backed source, since `useAdapterRows` keeps fetched rows in the requesting widget's local state and never writes them to `dataSources[id].rows`, so there is no later load to recover from. But fail-open on a filter is otherwise the worst default: the chip/highlight state comes from the selectors, which never consult row availability, so the widget _looks_ filtered while its numbers are not. `warnUnappliedCrossFilter` therefore emits a deduped dev warning for exactly the adapter-backed case, matching the adapter's own "degrades to client-side, never silently dropped" contract. A plain in-memory source with no rows yet stays silent: that is every dashboard's first render, and `collectJoinedSourceIds` has already recorded the dependency so `resolvedRowsCache` re-resolves once rows arrive. Resolving those foreign rows out of `studioRequestCache` the way `widgetExport` does is the outstanding fix.

**4. Caching** — `resolveRowsCached` (`resolvedRowsCache.ts`) wraps `resolveRows` in a `WeakMap<Row[], Map<cacheKey, entry>>`. The key folds in a content-based `filterFingerprint` of every scoped filter (operator, value, mode, rank settings, field type, target source — so an operator edit alone invalidates) plus the sorted `usedFieldIds`. A hit additionally requires: every foreign source actually joined against (tracked via a `collectJoinedSourceIds` out-param) still has the same rows **and fields** reference, `relationships` is the same array, and every relevant non-measure expression field is still the same object.

`collectJoinedSourceIds` is threaded into `resolveRows`'s own L2 call, not just the cross-filter loop — a widget-source expression column that JOINs a foreign source (`customer_name = join(customers.name)`) makes that source a tracked dependency even with **no cross-filter present at all**, including for filters evaluated _on_ that expression column.

### Relative dates resolve from one instant

Everything downstream of a `RelativeDateValue` — the comparison bound `compileRowTest` compiles, the wire value the adapters serialize, and the L3 `filterFingerprint` — derives from `resolveRelativeDateNowMs()`: `Date.now()` floored to `RELATIVE_DATE_REFRESH_CADENCE_MS` (60s). Predicate and cache key are then identical **by construction** rather than by convention.

The fixed cadence is deliberate over the two obvious alternatives:

- Quantizing to the filter's own unit would make "last 1 hour" mean "since the top of the hour an hour ago" — a window growing to 1h59m before the hour rolls over.
- Not quantizing at all moves the bound every millisecond: a 100% L3 miss rate, a fresh `Row[]` identity that also misses every `computedCache` entry, and a bounded LRU churning through full retained result arrays.

Epoch-flooring is timezone-independent for a whole-minute cadence (every real UTC offset is a whole number of minutes, so an epoch-minute boundary is a wall-clock minute boundary everywhere). Sub-day units (`second`/`minute`/`hour`) resolve to a full ISO-8601 UTC instant; `day`/`week`/`month`/`year` resolve to a bare `YYYY-MM-DD` (the L1 whole-day convention, since "N days ago" is inherently calendar-day-granular). Truncating _every_ unit to a bare date made "after 1 hour ago" silently mean "after start of today". `isDateOnlyFilterValue` correspondingly does not treat a sub-day relative value as date-only, keeping full-timestamp precision instead of widening to a whole day.

### L4 — Re-anchor (chart widgets only) (`engine/grainResolution.ts`, `chartSupport.ts`)

When a chart's x/y/series fields span more than one related source, aggregating the L3 result directly can double- or under-count through fan-out joins. `chartSupport.analyzeChartSupport` determines each field's owning source (`findDirectFieldOwner`) and whether the configuration can be safely aggregated (`isSafeWidgetBridgeOwner`). If it can, `resolveChartRowsForAggregation` calls `grainResolution.resolveRowsAtGrain(...)`, which re-derives the row grain relative to the chosen `anchorSourceId`.

**Measures are classified before the owner lookup.** A measure expression field has no per-row value, so `findDirectFieldOwner` can never resolve it and it must never reach re-anchoring — there is no column to join or enrich. `analyzeChartSupport` therefore screens measures up front: a usable one is dropped from `requestedFields`/`fieldOwners` entirely (L4 treats it as absent), and an unusable one fails closed as `measure_not_supported`. Three ways to be unusable: used in a non-y slot (a measure can never group, split, color or size — those read a per-row value that does not exist), used on a family that cannot evaluate it, or owned by another source (that reports `field_not_found_or_not_direct`, the same answer any unreachable field gets). Before this every measure fell through to `field_not_found_or_not_direct` — "not available on the widget source", said about a measure the panel had just offered and the KPI beside it was computing correctly — which made the measure-aware generic aggregators unreachable from charts entirely.

`CHART_TYPE_MEASURE_SUPPORT` is the exhaustive table (`satisfies Record<StudioChartType, boolean>`, so a new chart type must answer the question at compile time). `true` for bar / line / area / pie / donut / mixed, which route through the three generic aggregators and evaluate a measure per bucket; for gauge, which evaluates it over the whole row set exactly as the KPI card does; and for heatmap / funnel / sankey, whose `chartShapes/*` reducers now bucket rows (per cell, per stage, per (source, target) pair) and call `resolveMeasureAggregate` per bucket rather than reading `row[valueField]` directly. `false` only for scatter and gantt, which plot raw per-row values a bucket-only measure has no coordinate for.

**The three shape reducers each materialize a bucket's value once, before any ordering** — not as an optimization but so the null policy stays decidable. Their null handling deliberately differs, because a `null` bucket means something different to each layout: the heatmap stores it verbatim (`cells` is already `number | null`, and an unmeasured cell draws empty); sankey drops a non-positive or unevaluable pair, because the layout has no width to give it; and the funnel **omits** an unevaluable stage rather than plotting it at `0`. That last one is the interesting case — `FunnelStage.value` is a `number`, and `labelFormat: 'percent' | 'conversion'` divides by the neighbouring stage, so a placeholder `0` would publish a precise "0% conversion" for a stage nobody measured. Omitting perturbs the conversion chain instead. Both options are lossy; the one that does not assert a wrong number wins, per [null means "unmeasured"](#one-numeric-coercion-policy).

Flipping the table also re-opens these three families in `ChartSetupPanel`'s measure picker, which reads the same table — the picker and the renderer cannot disagree about what is offerable. `chartTypeSupportsMeasure(undefined)` answers `true` — the non-chart callers must not have a chart-family restriction applied — while an unknown doc/AI-authored type fails closed.

**Support-guard rules that are easy to get wrong:**

- **Direction independence for 1:1.** A one-to-one relationship has no fan-out on _either_ side (at most one matching row either way), so which side a schema author declared as `sourceId` vs `targetId` must not change whether the configuration is supported. Requiring the same direction a many-to-one needs rejected the reverse-declared equivalent.
- **A many-to-many relationship is a usable bridge only when _both_ `junctionSourceField` and `junctionTargetField` are present**, matching `findJoinPath`'s own completeness check. An incomplete junction cannot resolve rows through the junction table; treating it as usable fell through to a lookup with the identical requirement and silently resolved the dimension to `undefined` (a blank bucket) or the measure to a count fallback, instead of the clean fail-closed `mixed_cross_source_fields` every other unsupported shape gets. `RelationshipDialog` validates both fields, so this is only reachable from a host-injected or AI-authored config.
- **`relevantSourceIds` must include the junction.** `findDirectFieldOwner` resolves a related-source field from `source.fields` _or_ the expression-field list filtered to that source, so callers must pass expression fields covering the widget's own source, every one-hop related source, **and** each M:N relationship's junction. `useChartWidgetData`, `StudioChartWidget`, `useWidgetRows`, and `StudioKpiWidget` all build this set the same way (mirroring `getReachableSourceIds`) and subscribe via `makeSelectExpressionFieldsForSources`, matching what `ChartSetupPanel` already checked — otherwise the panel and the rendered widget disagree about whether a configuration is supported, and a filter on such a column can be neither classified nor evaluated.

**The three re-anchor branches:**

- **No re-anchor** (`anchorSourceId === widgetSourceId`) — enrich with related fields (`enrichRowsWithRelatedFields`, one- or two-hop) and expression fields. This is the only branch where that helper's first-match-only M:N lookup feeds an aggregation, and it is safe here precisely because each widget row is its own group (one representative related value per row is correct). Every fan-out-unsafe topology is either re-anchored below or rejected by the guard first.
- **Many-to-one anchor** (widget is the "one" side, anchor the "many" side) — expand each widget row into one row per matching anchor row, merging anchor fields plus remaining widget fields by FK. A reverse-declared 1:1 anchor takes a sibling path in the same switch: with no fan-out either way, a plain FK enrichment is already correct.
- **Many-to-many anchor** (anchor is a junction) — walk junction rows, keeping those linking to an allowed widget row, merging widget + remote + junction per output row. **The merge respects field ownership**: a junction column may override an already-present widget/remote value only when `fieldOwners` says the junction owns that field. Spreading the junction row last unconditionally let a junction column that coincidentally shares a field id (a junction `amount` allocation weight vs. the widget's `orders.amount`) clobber it.

**Foreign calculated fields resolve everywhere.** `enrichRowsWithRelatedFields` only ever resolves _physical_ columns on the related source (it filters candidates against `relatedSource.fields`), so a related-source **calculated** field requested as a dimension resolved `undefined` on every row while `analyzeChartSupport` reported the configuration supported.

All three branches therefore also run `enrichForeignExpressionFields` — the same FK join, but against the related source's own expression evaluation — over their respective foreign field sets (one-hop related, many-to-one third source, M:N third source). Junction and remote rows are routed through L2 (`enrichSourceRowsWithExpressions`) too, the remote rows **unconditionally** rather than only when a remote-scoped filter is active, since a remote-owned calculated dimension is read straight off `remoteRowLookup` with no other L2 pass over it.

**Anchor-scoped filters are re-applied inside grain resolution.** Both re-anchoring branches take the widget's fully resolved filter set (`widgetFilters` — exactly what produced the L3 rows) and apply the subset scoped to the **anchor source** to the anchor rows _before_ the expansion join. L3 enforces an anchor-source filter only as a semi-join (keep a widget row if it has ≥1 matching anchor row); without re-application the expansion read every anchor row straight from the unfiltered store, **resurrecting exactly the rows the filter excluded** (summing paid _and_ unpaid orders for a customer with at least one paid order). Details that make it work:

- A filter's target source is derived via `effectiveFilterSourceId` (mirroring L3), not read off `filterSourceId` alone — a drawer filter on an anchor-owned _expression_ field carries no explicit `filterSourceId`.
- The enrichment set passed to the anchor rows is widened to include any field referenced by an anchor-scoped filter, else that column is `undefined` when `applyFilters` evaluates it and every anchor row is dropped (an empty chart).
- The M:N branch additionally re-applies the subset scoped to the **remote endpoint** and drops junction rows whose target key is absent from the filtered remote key set — one relationship hop further out, same resurrection otherwise.

**Junction anchoring for a widget-owned measure.** `analyzeChartSupport` junction-anchors a configuration whose measure is entirely widget-owned (or fieldless — a plain count) when a grouping dimension is owned by the **remote endpoint** of an M:N relationship. Leaving `anchorSourceId = widgetSourceId` would route L4 through the first-match-only lookup, attributing each widget row to one arbitrary junction link ("sum of order total by tag" on an order with two tags). Anchoring on the junction fans each widget row out to one row per link, so the widget-owned measure is read off the merged row once per link; the measure-ownership check (normally requiring `owner === anchorSourceId`) is relaxed specifically to permit `owner === widgetSourceId` under this anchor.

Everything without a single grain **fails closed** as `mixed_cross_source_fields` rather than silently picking one: two distinct M:N remote dimensions in one chart; a junction-owned measure combined with a dimension owned by a _different_ relationship's remote/junction (a dimension on _this_ relationship's own remote endpoint stays fine, since the M:N merge already joins it); and the non-widget-owned counterpart of the relaxation above (a many-to-one anchor measure combined with an M:N remote/junction dimension).

**The L4 result cache** (`chartSupport.ts`) is keyed on `widgetRows`/`anchorRows`/a config fingerprint, `relationships`, the relevant expression fields, and the anchor-scoped (plus, for a junction anchor, remote-scoped) subset of the filter fingerprint — classified by the same `effectiveFilterSourceId` derivation, so a foreign-owned expression-field filter is folded in too. Grain resolution also reads rows from sources that are neither the widget's nor the anchor's (enrichment joins, M:N remote rows, third-source rows for a `seriesField`), so `resolveRowsAtGrain` takes a `collectReadSourceIds` out-param every branch populates; a hit requires every recorded source's `SourceDep` (rows **and** fields) to be unchanged, so refreshing (for example) `customers` while a chart on `orders` splits by `customers.segment` busts the entry instead of serving stale segments.

**The widget and anchor sources are recorded as `SourceDep`s too, not skipped as "already covered by the WeakMap keys".** A WeakMap key pins `rows` only, while the anchor rows are themselves read through `getCachedNormalizedDataSource` — keyed on rows _and_ fields. Retyping an anchor field (`updateDataSourceField` commits a new `fields` array with the same `rows` reference) therefore changed the re-anchored values with nothing in the validity check noticing, and the chart kept bucketing on `'1/15/2024'` while the grid beside it showed `'2024-01-15'`, unrecoverable short of replacing the anchor's rows.

**Scope limit.** This function handles only the "fan-out" direction (grouping dimension on the coarser side). The "fan-in" direction (aggregate a one-side measure grouped by a many-side field, for example, summing `orders.total` grouped by `order_items.category`) has no single global grain and uses per-group dedup instead (`utils/gridGrouping.symmetricAggregate` for grids, an FK-keyed `Set` in the map widget). `analyzeChartSupport` never selects an anchor that would need it, so charts never hit that path.

### One join-key coercion policy

L3 semi-joins, L4 re-anchoring, display-column enrichment, grid fan-out dedup, **and L2's join-field expressions** all key through `normalizeJoinKey` (`engine/joinKeys.ts`): `null`/`undefined` → `null` (a missing FK never spuriously matches an empty key), `Date` → ISO string, everything else → `String(value)` (a numeric FK and a string PK compare equal). `indexRowsByKey`/`collectKeySet` build the `Map`/`Set` lookups on top. There is no pipeline stage that disagrees on join-key coercion.

### One numeric-coercion policy

`engine/aggregate.ts` owns it so widget kinds cannot drift on how they treat empty or non-numeric cells:

- `coerceAggregateValue(value)` — booleans → `0`/`1` (so `avg` yields a ratio), finite numbers → themselves, non-empty numeric strings → parsed (CSV/JSON sources have no native number type, so measures routinely arrive as strings, and parsing here keeps every accumulator in agreement with the aggregators' own numeric pre-detect). Everything else is **skipped**, never coerced to `0`, so it can't inflate an `avg` denominator or drag a `min` toward zero.
- `aggregateNumbers(values, fn)` reduces an already-coerced list. `min`/`max` reduce with a **loop**, not `Math.min(...values)` — the spread form throws `RangeError` past roughly 125k elements. The same applies in `gridGrouping`, `gridSummary`, and `richContext`'s `numericStats` (which runs synchronously inside every `sendMessage`).
- `createAggregateAccumulator`/`accumulateValue`/`finalizeAccumulator` stream values without buffering.

Every consumer routes through it: KPI `computeAggregate`, map region aggregation, pivot totals, the chart cell accumulator, grid group-by and footer totals, the expression evaluator's measure aggregation, and `filterUtils`' Top-N rank reduction. The generic chart aggregators coerce each **raw** cell before it reaches the accumulator (not only at finalize time — `Number(row[y] ?? 0)` coerced a null cell to `0`) and share one first-non-null pre-detect, all three falling back to `count` when the y-field is non-numeric.

**`'count'` means `COUNT(*)` everywhere**, independent of whether a per-row measure value is usable. Map regions, pivot cells/totals, and chart buckets each track a `rowCount` separately from the null-skipping accumulator, so a bucket whose measure values are all null still reports its true row count instead of disappearing or reading `0`. The expression evaluator is no exception: its measure `count` routes through the shared `aggregateCellValues` like every other path, so `count(amount)` and a KPI over `amount` with aggregation `count` read the same number over the same rows. SQL's `COUNT(col)` exists under its own name — `count_non_null` — and is now a **first-class, user-selectable, persisted** aggregation: a member of `AggregateFn`, of both persisted unions (`StudioKpiAggregation` / `StudioGridSummaryAggregation`), and of the KPI, grid-summary and expression-measure option lists.

Promoting it had to move everything at once, because widening the two persisted unions **alone** would have been worse than leaving it internal — a doc carrying `count_non_null` would then load and be silently mis-answered. Three places had to change together, and each one's failure mode is pinned by a test:

- `gridSummary.aggregationLabel` ends in `default: return ''`, so an unhandled union member renders its number with **no label at all**.
- `gridSummary`'s non-numeric fallback rewrites any aggregation that isn't a count to `count` on a string column. All three counts read the raw cell, so all three are exempt via one shared `isCountAggregation` predicate; without it, asking "how many rows have a value" on a string column would have silently answered "how many rows".
- `StudioGridWidget` must **register** the aggregation function — `toGridAggFn` passes it through unchanged and the Data Grid has no built-in of that name, so a group aggregation would render nothing (the same gap `count_distinct` already had).

**It is also the one count that pushes down.** The wire protocol's `count` IS SQL `COUNT(column)`, so `count_non_null` maps onto it exactly, while Studio's `count` (`COUNT(*)`) has no wire form and is stripped to raw rows by `isClientOnlyAggFn`. That mismatch is precisely why the two need separate names. The rename to the wire spelling happens at the **last** moment, in `createBatchingAdapter`'s `toWireAggFunc`: renaming any earlier would make `stripAggregations`' client-only check see Studio's row-count `count` and strip the push-down, silently turning a pushable aggregation into a full raw-row fetch.

Two surfaces deliberately do **not** offer it. The AI _data-query_ tool's `func` enum is the raw middleware query surface, where `count` already means `COUNT(column)` — a second spelling there would be a duplicate name for the same SQL, not a new capability. `StudioMapWidget`'s `SAFE_MAP_AGGREGATIONS` is a deliberate numeric-only allow-list.

**`null` means "unmeasured", not "zero".** Aggregated series carry `null` for a bucket with no usable measurement, and the whole stack preserves that rather than fabricating a `0`: the heatmap draws an unmeasured cell empty, the pie drops an unmeasured category, and the AI summaries report absence. `resolveMeasureAggregate` — the shared entry point every bucket-producing path uses to evaluate a measure expression field, so a measure returns the same number wherever it is placed — returns `number | null` and **never `0`** for an empty row set, a `fieldId` that is not a measure, or a non-finite result. A fabricated `0` is indistinguishable from a genuine zero measurement: it plots a real bar, wins a Top-N against real negative values, and leads a descending sort. A measure that genuinely evaluates to `0` still returns `0`.

> `aggregate.ts` imports `evaluateMeasure` from `utils/expressionEvaluator.ts`, which imports the numeric primitives back — a **deliberate** module cycle, documented at the import. Both sides consume the other only from function bodies, never at module-evaluation time, and both export hoisted function declarations, so the live bindings are resolved by the time either runs. It is what lets KPI, pivot and the chart aggregators all reach measure evaluation through the one aggregation module instead of each re-deriving it. Don't "fix" it. The same rule applies one level up, to a whole source's row set: `StudioDataSource.rows === undefined` means the rows were never delivered, and `getDataSourceRowState` (see [Data-source and adapter bookkeeping](#data-source-and-adapter-bookkeeping)) keeps that distinct from a delivered `[]` so no counter, option list, or measure preview reports a number nobody took.

Ranking follows the same rule. `reduceRankScore` skips nulls (a null neither adds 0 to a sum, pulls an average toward 0, nor wins a `min`/`max`), and an all-null candidate scores `null`, which `selectRankedIndices` sorts to the **losing end in either direction** — a no-data candidate must never win a Top-N _or_ a Bottom-N slot, nor be coerced to a 0 that outranks every negative value. The comparator tests equality first so two no-data candidates don't compare `Infinity - Infinity === NaN`, which is not a consistent ordering and makes the surviving set engine-dependent.

### Aggregate & render

Per-chart-type aggregation lives in `engine/aggregators.ts` (`aggregateByField`, `aggregateByTwoFields`, `aggregateMultipleSeries`, `aggregateBlendedSeries`, `orderLabels`, and the three `applyRankTo*` helpers). `engine/chartShapes/` holds one file per chart-type shaping step (`scatter`, `heatmap`, `sankey`, `funnel`, `gantt`); `engine/chartAggregation.ts` is a composition barrel re-exporting `chartSupport` + `aggregators` + `chartShapes` so imports resolve through one entry point while the implementation stays split.

**Aggregation precedence.** Per-series `yAggregation` is honoured on every render path, not just the blended one: `aggregateByTwoFields` takes `config.yAggregation`, and `aggregateMultipleSeries` accepts either a single function or a per-field `Record<fieldId, fn>` map. Single-series/pie/heatmap/funnel aggregation is read from the **same `ySeries` entry that supplied the value field** (matched by `fieldId`, not `ySeries[0]`), falling back to `config.yAggregation` — mirroring the multi-Y path and the server push-down order in `chartTypeRegistry`, so a plain multi-series chart produces the same numbers as the push-down.

**The empty-value policy differs by dimension, deliberately.** An **axis/category** dimension DROPS a row whose value is `null`/`undefined`/`''` (`chartValues.isEmptyXValue`, applied by all three `aggregate*` functions, `chartShapes/heatmap`, `chartShapes/scatter` for either coordinate, and `StudioPieChart`); a **split/color** dimension KEEPS it under `emptyBucketLabel` (`aggregateByTwoFields`' `seriesField`, scatter's color field). A category axis answers "how does the measure break down _across_ this dimension", and a row with no value has no position on that breakdown — fabricating one invents a data point the source never held. A split merely partitions a category's rows, so deleting the unlabelled partition would make the stacked bars at a category sum to less than the single-series bar over the same rows. Two earlier fixes converged here rather than drifting: heatmap was changed _to_ drop so it would stop disagreeing with bar/line over the same field (T3.2b), scatter _to_ drop so null costs stopped stacking on `y = 0` (M13), while the series bucket was deliberately kept and localized (T3.2a).

The consequence worth knowing when reading a dashboard: **a chart's bars can total less than a KPI counting the same rows**, by exactly the number of rows with an empty x. That is the accepted cost of the rule, not a bug — changing it is a cross-family behavior change across six call sites in four files. A corollary: because every axis call site runs the guard _before_ `toXValue`, `toXValue`'s own empty-bucket branch (and the `localeText` the aggregators thread into it on the x path) can never fire for an x value; the argument is kept so the guard-then-convert pair is spelled identically everywhere and the policy stays a one-line decision in `isEmptyXValue`.

**Rank helpers.** All three `applyRankTo*` share `selectRankedIndices` and uphold:

- **Survivors keep their original input order**, via a keep-mask. Ranking selects _which_ categories survive; the caller's `orderLabels`/`chartSortBy` choice stays the single authority on their order, so a single-series bar doesn't flip order when a second Y series is added.
- **Under a ghost, the rank is computed once on the baseline aggregation** and the filtered aggregation is projected onto the baseline's kept labels un-ranked, so the two top-N sets can never diverge.
- `applyRankToAggregated` takes an optional `rankByFieldData` so a rank on a separate `rankByField` scores by that measure — matching the row-level reduction every non-xy kind applies — instead of ranking by the displayed (possibly avg/min/max) value.
- `applyRankToSeriesFieldData` coerces both sides through `String(...)` before its membership test: a numeric split-by value survives as a real `number` in `seriesNames` while `Object.keys(seriesData)` are always strings.

A related trap: a ghost comparison must not let each of its two aggregations pre-detect sum-vs-count independently. `aggregateByField`'s pre-detect is extracted as `detectAggregationType(rows, yField, yAggregation)` and the function takes a trailing `forcedAggregation`; `useChartWidgetData` detects **once** against the baseline and passes the result to both calls, so a filtered subset that happens to be empty for that field can't downgrade to `'count'` while the baseline stays `'sum'`.

> Known limitation: `applyRankToMultiSeries` matches a rank target by `fieldId` alone and takes the first match. On a blended mixed chart two series can share a `fieldId` from different sources, so this conflates them; a full fix needs a `(fieldId, sourceId)` rank-target model and is a documented deferral.

**Post-aggregation steps**, in order: temporal label-gap-filling (`temporalUtils.truncateToGranularity`, which delegates the bucketing math to the schema package's `truncateToPeriod` so the client and the AI middleware's `summarise_page` agree on period boundaries), forecast overlay (`forecastUtils.ts`, linear-regression projection), anomaly annotation (`anomalyDetection.ts`), number formatting (`numberFormat.ts` — `formatNumber`, `formatFieldValue`, and the shared Intl-based `formatPercent(value, fractionDigits = 1)` used for KPI trend deltas and percent displays), then `@mui/x-charts`.

Two ordering rules worth knowing:

- **A temporal line/area x-axis always renders chronologically ascending** (`getTemporalAxisData` sorts labels internally), but the aggregated values arrive in whatever order sorting or a rank filter left them. `chartWidgetHelpers.getTemporalSortOrder` computes the unsorted→chronological permutation once and `sortAggregatedTemporally`/`sortMultiSeriesTemporally`/`sortMultiYTemporally` apply that same permutation before rendering, so a value is never plotted against the wrong date.
- **The forecast overlay's connection point sits at the last historical index** (`values[n-1]` repeated at index `n-1`, not `n`) so the dashed line meets the historical series instead of being shifted a period late. Its label extension recognizes `YYYY-Qn`/`YYYY-Www` keys including year rollover, so a weekly/quarterly forecast gets real period labels rather than degrading to a `+1`/`+2` scale.

Grid widgets substitute DataGridPremium's native `rowGroupingModel`/`aggregationModel` plus `utils/gridSummary.ts` for the chart aggregation step; `utils/gridGrouping.ts`'s `buildGroupedGridRows` has no production caller. Instead `StudioGridWidget` registers custom aggregation functions (`makeFanoutSafeAggregationFunction`) that dedupe a many-to-one joined column by FK before reducing, reusing `gridGrouping`'s shared `aggregateValues`.

**Adapter `avg` is never pushed down at a finer server grain than the client re-aggregates at.** The wire protocol cannot express the client's re-bucketing granularity: a server-side `avg` at the raw x-grain, client-re-bucketed by month, averages per-day averages — wrong unless every day has an equal row count. `sum`/`min`/`max` re-reduce correctly from partial results and are still pushed. See [the push-down ladder](#the-query-adapter) for the full decision, which both adapters share.

### Query-descriptor dispatch (`engine/queryDescriptor.ts`, `chartTypeRegistry.ts`)

The adapter path needs to know, per widget kind / chart type, which field ids belong in the SELECT and which aggregation specs to push down. `queryDescriptor.ts` builds the `StudioQueryDescriptor` but delegates per-type branching to `chartTypeRegistry.getDescriptor(kind, config)`, returning a `ChartTypeDescriptor` (`collectFields` + `buildAggregationSpecs`). Charts look up `config.chartType` in a map declared `satisfies Record<StudioChartType, ChartTypeDescriptor>` (a new chart type without an entry is a compile error); non-chart kinds look up `kind` in `widgetKindRegistry`.

Each type's push-down policy lives in exactly one place:

- **KPI and gauge never push aggregations.** Both aggregate client-side via `computeAggregate`; a server-side `COUNT` over one pre-aggregated row returns `1`, not the real count. Gauge is therefore _not_ routed through the shared `xyDescriptor` and has its own `gaugeDescriptor` whose `buildAggregationSpecs` always returns `[]`.
- Scatter/gantt return raw rows; foreign-source sparkline/blended-series fields are excluded from the primary SELECT and joined in memory.
- **Every descriptor reading a value field resolves it as `config.yField ?? config.ySeries?.[0]?.fieldId`**, mirroring the corresponding `render*` function's own fallback, so a config carrying the value only in `ySeries` (for example, after a chart-type switch) is neither dropped from the SELECT nor missing from lazy expression enrichment.
- Sankey is the one family with no `yAggregation` concept — a link's weight is always the sum of its rows — so its descriptor hardcodes `fn: 'sum'`.
- `buildXYAggSpecs` de-duplicates by SQL alias: `config.yField` and a `ySeries` entry routinely name the same field (the setup panel writes both), and two specs for one alias produce an ambiguous duplicate-alias query. The more specific per-series fn wins.

**`select` is widened with incoming cross-filter / interactive-filter fields.** The adapter's client-side residual (`useWidgetRows`) is the _sole_ enforcement point for those scopes and evaluates them against the fetched rows, while the middleware projects only `select` — so a cross/interactive field not already in the widget's config would be missing from every row and `row[field] == value` would be `undefined == value` → false, emptying the widget.

For a same-source filter the filtered column is projected; for a cross-source filter the **relationship FK column on the widget's source** is projected instead (mirroring `findJoinPath`'s direct-relationship resolution). Only the _field set_ is folded in, never the per-value selection, so the `cacheKey` changes at most once when a cross/interactive filter first lands on a new field — clicking different values on the same field leaves it unchanged.

**The `cacheKey` folds in what each relative-date value currently _resolves_ to**, via the same `resolvedRelativeBound` helper `resolvedRowsCache.filterFingerprint` uses (including a bound nested inside a `between` value's `{from,to}`, which `isRelativeDateValue(value)` alone never sees). A `RelativeDateValue` is a stable object, so the raw filter tree stringifies identically across a `RELATIVE_DATE_REFRESH_CADENCE_MS` tick while the adapters resolve it to a different concrete instant at request time — one key naming two different windows. The segment is omitted entirely when no filter carries a relative date, so an ordinary dashboard's key does not churn.

**`buildWidgetQueryDescriptor(widget, pageId, tableName, state)` is the shared "descriptor from state" wrapper, and the only one production code should call.** The low-level `buildQueryDescriptor` defaults its last three parameters (`relationships`, `expressionFields`, `crossFilterAllPages`), which is convenient in tests but is exactly what let two production call sites drift: all three feed the `cacheKey`, so a caller silently defaulting one produced a _different_ key than one built from real state and missed an entry the other had populated. `WidgetQueryDescriptorState` requires them with no defaults, so omitting one is a compile error. Both `useAdapterRows` and `widgetExport.runWidgetExport` build through it.

The widget-facing hooks that drive the pipeline from React — `useWidgetRows` (the central one),
`useAdapterRows`, `useChartRows` and `useBlendedSeriesRows` — live in the binding, since they
subscribe to a store and hold fetch state. See
[its `ARCHITECTURE.md`](../x-studio/ARCHITECTURE.md#widget-facing-hooks). Everything below applies
to both them and the non-React façade.

### The recurring caching design

Every cache in `engine/` uses **per-entry dependency tracking instead of blanket invalidation** — an entry stays valid unless the _specific_ upstream references it depends on changed (its own rows, the specific expression-field objects it evaluated, the specific foreign sources it joined against, the filter fingerprint). An unrelated edit elsewhere never forces recomputation. New caching code follows this pattern.

**Bounding is a second, separate concern.** `engine/rowCacheLru.ts` is the shared insertion-order LRU behind `normalizedRowsCache`, `enrichedRowsCache`, `resolvedRowsCache`, and `computedCache`. All four have the same `WeakMap<Row[], Map<innerKey, entry>>` shape: the outer WeakMap key is a rows array, so entries are GC'd when a source's rows are replaced — but that bounds **nothing** about the inner map, whose key is derived from widget config and churns freely while the rows array stays alive (adding grid columns one at a time mints a `fieldSetKey` per column; interactive/cross-filter churn mints a fingerprint per click). Each retained entry pins a full result array, so an unbounded inner map retains one clone of a 200k-row source per historical key.

A `Map` iterates in insertion order, so `keys().next().value` is the oldest key — a free LRU as long as every read re-inserts (`getLruEntry`) and every write deletes before inserting (`setLruEntry`). The row caches share `MAX_ENTRIES_PER_ROWS = 20`; `computedCache` uses a deliberately looser `MAX_COMPUTED_ENTRIES_PER_ROWS = 64`, because one rows array is shared by every widget with the same source and filters (that sharing is what `resolvedRowsCache` exists for) and each widget contributes several keys — capping at the row caches' number would evict entries still on screen, which is thrash, not bounding. Its entries are also orders of magnitude smaller (aggregated results, not row clones). `computedCache` boxes its values so a genuinely-cached `undefined` is distinguishable from a miss.

Foreign-source dependencies are tracked as a `SourceDep` (**rows _and_ fields** references), because the join reads the foreign source through `getCachedNormalizedDataSource`, which is keyed on both.

### The non-React pipeline façade (`engine/StudioPipeline.ts`)

`createStudioPipeline(state)` builds a pure-TypeScript object (`resolveWidgetRows`, `resolveChartRows`, `getEnrichedRows`) closing over a snapshot of `{ dataSources, relationships, expressionFields, filters }` plus the dashboard cross-filter settings, delegating to the exact same cached functions the hooks use. It accepts either a bare `StudioPipelineState` or a full `StudioState` (detected via `'doc' in state`). It exists for callers outside a render cycle: CSV export, `benchmarks/`, and pipeline unit tests.

`resolveWidgetRows` takes the `StudioWidget` object as its first argument so `shouldApplyWidgetRankAtL3` applies automatically — a new caller gets correct behavior without knowing the rule exists. `options.includeWidgetRank` overrides it; the only legitimate reason to pass it is a caller reproducing a _different_ pipeline stage that must mirror another call's flag verbatim. Passing it to "make the numbers match the chart" is always wrong — the helper already does that. `resolveChartRows`' trailing `extraFields`/`widgetFilters` default to the underlying function's own defaults, so an existing caller keeps prior behavior until it opts in.

**`options` is the per-widget override channel only — it does not gate the dashboard settings.** The snapshot's `crossFilterAllPages` and `globalCrossFilterMode` are honoured unconditionally, with the effective mode resolving as `globalCrossFilterMode ?? options?.widgetCrossFilterMode ?? 'cross-highlight'` (the same precedence `useWidgetRows` / `StudioGridWidget` / `applyCrossFilter` use) and `'none'` coercing `include` to `'no-chart-cross'`. This used to be gated behind "did the caller pass `options`?", which made the corrected behavior opt-in and left the wrong branch as the default every new caller inherits. The remaining hazard is the flat `StudioPipelineState` input: it can only honor what the snapshot carries, so a hand-built state that omits the two fields still reads as "both unset" — prefer passing the full `StudioState`, and see `generateInsight`'s `toPipelineState` / `richContext`'s `buildFieldStats` for the flat-shape builders that forward them explicitly.

## Filters

`StudioFilterState.scope` (schema package, `stateTypes.ts`) is a discriminated union and the **sole** scope descriptor — there is no separate `widgetId`/`pageId`/`isDashboardDateRange` field to keep in sync:

| `scope.kind`           | Payload                    | Meaning                                                                  |
| :--------------------- | :------------------------- | :----------------------------------------------------------------------- |
| `page`                 | `pageId?`                  | applies to one page (a legacy `pageId`-less entry applies to every page) |
| `widget`               | `widgetId`                 | applies to one widget                                                    |
| `cross-filter`         | `sourceWidgetId`, `pageId` | a chart/grid/map click; hidden from the drawer; undoable                 |
| `interactive`          | `sourceWidgetId`, `pageId` | a filter-widget/slider selection; always a hard filter                   |
| `dashboard-date-range` | `sourceId`, `pageId`       | the dashboard date-range bar, per source                                 |

`engine/filterScoping.ts`'s `selectFiltersForWidget` is the single scoping authority for every path — sync, adapter, non-React pipeline, KPI trend/sparkline, blended series, AI summaries, and the drawer's own cascading-parent lookup. Anything hand-rolling a `scope.kind === 'page'` match without a `pageId`/`disabled` check is a bug: it leaks another page's filter, ignores the disabled flag, and skips `resolveDateRangePresets`.

The authoring UI for all of this — the filters drawer, its per-mode value editors and their
self-repair rules — lives in the binding; see
[its `ARCHITECTURE.md`](../x-studio/ARCHITECTURE.md#filters).

**Filter evaluation** lives in `engine/filterUtils.ts` (`applyFilters`, `compileRowTest`, `resolveDateRangePresets`, relative-date resolution). Rules that generalize:

- `resolveDateRangePreset` turns a non-custom preset into concrete bounds at query time **regardless of `scope.kind`**, so dashboard-wide and widget-scoped presets resolve the same way and a stored filter is never a stale absolute date.
- `not_in` compiles to the inverse of `in` — the operator is explicitly consulted, not assumed inclusive.
- Date `equals`/`not_equals` route both sides through the same `toComparable` normalization the comparison operators use, so a relative-date "On" filter or a `datetime` field compared against a date-only picker still matches.
- Numeric comparison and `between` branches guard `rv != null` before comparing, so a null cell is excluded rather than treated as `0` — the same guard the date branches always had.
- `toComparable`'s `date` branch reads the canonical calendar day via the exported `normalizeToDateOnlyString` (`temporalUtils.ts`), not `toISOString().slice(0,10)`. Rows that went through L1 already carry a canonical day string, but a row that bypassed it — a foreign or junction row in an L3 cross-filter semi-join, or rows handed to the non-React `StudioPipeline` unnormalized — can still carry a raw local-time `Date`, which day-shifts for UTC-positive viewers. L4's anchor/remote/junction rows no longer need this backstop; they are read through `getCachedNormalizedDataSource`.

## The query adapter

`StudioDataSourceAdapter` is the contract: `getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult>` plus an optional `submitMutation`. Two implementations:

- **`createSimpleAdapter(url, options?)`** — one HTTP request per call, targeting a simpler host that speaks `StudioQueryDescriptor` natively, so it POSTs the descriptor essentially as-is and does **not** translate to the wire `FilterPredicate` shape.
- **`createBatchingAdapter(url, options?)`** — a DataLoader-style client-side batcher. Each widget has its own `cacheKey` (it includes `widgetId`), so N widgets would otherwise fire N requests that miss any server-side batching window. It collects descriptors within a scheduling window (a microtask tick by default) and POSTs them as one batch, routing responses back by id. One loader per endpoint URL, not per data source. It also generates cross-source JOINs when given `dataSources`/`relationships`, mirroring the middleware's server-side handling.

Both resolve relative-date values before sending — including one nested inside a `between` bound, since the drawer allows a relative date on either bound and a top-level check alone never catches that shape. A relative spec is a client-only concept a remote host cannot interpret.

**`createBatchingAdapter`'s filter translation is a deliberate two-way split, not best-effort.** `partitionFilterNode` walks the tree and calls `isLeafServerTranslatable` per leaf, asking whether it can be expressed as a wire `FilterPredicate` with **exactly** the in-memory evaluator's semantics. Anything else — including any `logic: 'or'` group — routes to `clientLeaves` and is re-applied locally via `applyFilters` after the response, with a dev-mode warning, so an unmappable predicate **degrades to client-side enforcement rather than being silently dropped or silently turned into AND**. Failing the check:

- A leaf combining its two conditions with `conjunction: 'or'`.
- Operators with no wire equivalent: `not_in`, `does_not_contain`, `starts_with`/`not_starts_with`, `ends_with`/`not_ends_with`, `is_empty`/`is_not_empty` (no `IS NULL` wire form).
- The three substring operators (`contains`/`starts_with`/`ends_with`) that _do_ have an approximate `LIKE` form, kept client-side anyway because SQL `LIKE` is case-sensitive while Studio's evaluator is case-insensitive.
- Two value shapes regardless of operator: an empty `in: []` (matches nothing in-memory; the middleware drops an empty-`in` predicate on reads, matching _everything_ — the exact inversion) and an open-ended `between` with one bound (unbounded in-memory; `whereBetween(col, [value, undefined])` is a binding error on Postgres and a silent wrong result on SQLite/MySQL).
- `not_equals` on a `date`/`datetime` field, and `equals` on one whose value does not reduce to a calendar day (an epoch number, a `Date`, a non-ISO string) — see the date-granularity paragraph below.

**Date filters are rewritten, not approximated, because in-memory they are calendar-day-granular.** `toPredicatesFor` translates each (operator, value) pair rather than emitting one predicate per condition, so a single leaf can produce a bound pair. On a `date`/`datetime` field: `<= D` → `< D+1day` and `> D` → `>= D+1day` (a bare `YYYY-MM-DD` covers/excludes the WHOLE day in-memory, so a literal midnight comparison drops or keeps the rest of it), `between [F, T]` → `>= F AND < T+1day`, while `>= D` and `< D` already line up. Those four consult `isDateOnlyWireValue`, mirroring the evaluator's `compileDateBound`/`isDateOnlyFilterValue`: a bound carrying an explicit time-of-day keeps full precision.

`equals`/`not_equals` are the exception to that exception: `compileSingleCondition` runs both sides through `toDayComparable` **unconditionally**, so they are day-granular even for a value that carries a time. `equals D` therefore becomes `>= day(D) AND < nextDay(day(D))` for every value that reduces to a calendar day, and `not_equals` — whose faithful form `< D OR >= D+1day` is an OR the AND-only protocol cannot express — is routed to the client residual instead. Until this was fixed, `equals` shipped a raw `eq` against a bare date, matching only the exact-midnight rows of a DATETIME column while the evaluator matched the day, and the divergence was merely `console.warn`ed ("Use a `between` range instead") — a wrong KPI number that a dashboard viewer sees and a dev-console note that only a developer sees.

The one divergence still merely warned about, via a one-time `warnAdapterDivergence`, is `not_equals` on a NON-date field: SQL three-valued logic excludes NULL rows server-side while the evaluator keeps them, and the wire protocol has no `IS NULL` to repair it with. It stays pushed down because it is a common, high-selectivity predicate and routing it client-side would defeat the pushdown (and drop the filter entirely for an already-aggregated widget). Also warned rather than silent: a filter on an arithmetic expression field (no server column exists; `resolve()` reports `{ skip: true }`), and a **non-filter** use of a reference across a one-to-many or many-to-many relationship — a display column, `groupBy` or aggregation source (the fan-out guard above). A _filter_ on such a reference is no longer warned about, because it is now emitted faithfully as a semi-join.

`createSimpleAdapter` performs **none** of these rewrites: it POSTs the `StudioFilterNode` tree untranslated, so the host owns Studio's operator semantics — including the day granularity above. Its module doc block spells the required SQL out operator by operator.

**The push-down ladder is shared, and `count`/`count_distinct`/grain-mismatched `avg` are always finalized client-side.** `aggregationPushdown.ts`'s `decideAggregationPushdown` is the one decision both adapters call — it used to be written twice and had diverged, the simple adapter implementing two of the five rungs and the batching adapter running its copy _before_ the filter partition, where it could not see the rung that depends on it. Every rung means "the server's answer cannot be repaired client-side", never "the server would be slower"; when one fires the aggregations are stripped, raw rows are fetched, and the widget's own always-on client aggregation produces the number. In order:

1. **An unpushable filter** — re-applied client-side against the returned rows. A server-aggregated response is one row per group, so the predicate's own column is absent and the residual could not run at all; the widget would aggregate over every row.
2. **An incoming cross-filter or interactive selection** — same shape: enforced client-side, and `undefined` on every pre-aggregated row.
3. **A rank (Top-N) filter** — its client-side reduction sums the rank measure per group and must see raw rows.
4. **`count` / `count_distinct`** — the wire `count` is SQL `COUNT(column)`, which skips NULL measures, while Studio's `count` is `COUNT(*)`; and the protocol has no DISTINCT form at all. `count_distinct` used to be _downgraded_ to a plain `count` with a warning, which could never produce a usable number — the client re-aggregates a one-row-per-group response, so every group's distinct count rendered as `1`, an outcome the warning did not describe.
5. **`avg` at a server grain finer than the client's** — the middleware derives its GROUP BY from the projection, so any projected column outside the client's `groupBy`, or any `xGroupBy` bucketing (which the wire cannot transmit), splits each client group into several server groups and turns the re-aggregation into an unweighted average of averages.

**A cross-source reference across a one-to-many relationship is never joined. As a _filter_ it emits a semi-join; every other use is dropped with a visible warning.** A `LEFT JOIN` is row-preserving only when the widget sits on the _many_ side (or the relationship is 1:1). From the _one_ side it fans the row set out — one widget row per matching related row — so as a filter, `customers LEFT JOIN orders WHERE orders.status = 'shipped'` makes a customer with three shipped orders contribute three rows and a `SUM(lifetime_value)` KPI read 3×, where the in-memory path semi-joins and reads 1×; as a display column it duplicates every grid row.

The faithful SQL for the filter case is a semi-join (`WHERE customers.id IN (SELECT orders.customer_id FROM orders WHERE …)`), and the wire protocol now expresses exactly that as a `SemiJoinDescriptor` — the same shape and the same answer as the in-memory path, with the caller's row-level-security predicate applied _inside_ the subquery so the related table is scoped exactly as a joined table would be. `resolveField` returns a `semiJoin` wherever it previously reported only `fanOut`, and additionally resolves the **many-to-many** references the loop used to skip entirely (nested through the junction for a remote-endpoint field, one hop for a field on the junction itself). Predicates are grouped by the foreign source they filter, so a multi-predicate cross-source filter becomes one subquery with several conditions — the same grouping `resolveRows` performs in memory.

**`unresolved: true, fanOut: true` are deliberately KEPT alongside `semiJoin`.** A semi-join filters rows; it does not produce a _value_. So a display column, `groupBy`, or aggregation source on the "many" side still has no faithful wire form — in memory those pick one representative related value per row, a choice SQL cannot make without a rule nobody declared — and neither can a reference spanning adapter endpoints. The filter path reads `semiJoin` first; every other caller sees the unchanged `unresolved`/`fanOut` pair, drops the reference from SELECT and GROUP BY, and `warnAdapterDivergence` says so. That preserves the module's standing "degrades visibly, never silently wrong" contract for precisely the cases that still need it, while removing the degradation from the one case that no longer does.

A secondary win: because a semi-join does not multiply rows, the middleware's preflight `COUNT(*)` and the returned row count now agree for these widgets, where the `LEFT JOIN` form would also have mis-routed the tier decision.

**A batch is chunked at the server's per-request widget cap.** `MAX_BATCH_WIDGETS_PER_REQUEST` (50) re-exports `MAX_ITEMS_PER_BATCH` from the schema package's wire-protocol module (`dataWireTypes.ts`), which the data middleware's `MAX_WIDGETS_PER_BATCH` re-exports too — one constant, so the two cannot differ. It used to be a hand-kept COPY on each side, held equal only by a mirror assertion in each package's own suite; neither suite can see the other side of the wire, which is why that arrangement could not fail until it was too late. Studio does not cap widgets per page, and the middleware's `assertValidBatchQueryRequest` **throws** on an over-cap batch _before_ its per-widget loop, so no widget gets its own `{ error }`; a host mapping that throw to a bare 500 discards the server's actionable text, and client-side `!response.ok` fails every descriptor in the group. One widget past the cap therefore took down the whole page. Requests are grouped by `fetchFn`, then each group is sliced into chunks of at most `MAX_BATCH_WIDGETS_PER_REQUEST`, which also gives each chunk its own shared row budget. Batch descriptors additionally carry a row `limit` so that budget is expressible on the wire.

**The unattributed cross-source filter is announced, not resolved.** `resolveRows` reaches its cross-filter (semi-join) arm for a non-expression leaf only when `filterSourceId` is set **and** differs from the widget's own source; without that attribution the same leaf takes `nativeFilters` and is compared against the widget's own rows, where the foreign field is `undefined`. The wire plan is identical either way, so an unattributed leaf gives `wire=1 memory=0`, silently. This is reachable, not hypothetical — the AI middleware's `add_page_filter` stores `''` when the model omits `sourceId`, and `''` is indistinguishable from absent everywhere downstream. Resolving it would mean guessing which of two valid document representations the author meant, so it takes the same route the expression branches took: `warnAdapterDivergence`, once per build, in every environment. The detector works **per leaf**, not per field: `partitionFilterNode` records `predicateSourceIds` index-aligned with `predicates` (a leaf expanding into two predicates — a day-granular date translation, an `op2` second condition — contributes its attribution twice), because `resolveRows` routes every leaf independently. A per-field union let two leaves on one field whitelist each other, so the correctly-attributed sibling silenced the warning for the one that actually diverges.

Three smaller invariants:

- The ORDER BY clause is dropped whenever the sort field is either `skip` **or** `unresolved` (resolvable to no column here, for example, a groupBy field 2+ hops away). Checking only `skip` emitted `ORDER BY <nonexistent column>` and failed the whole batch entry when dropping the clause would have produced usable rows.
- Within one window, each request/response pair is matched by a composite `${widgetId}::${cacheKey}` (falling back to the bare `widgetId` only when unambiguous), so two calls for one widget with different descriptors can't be cross-wired and cached under the wrong key.
- In simple mode the shared per-endpoint loader reads `fetchFn`/`batchDelayMs` from a live, refreshable config object rather than baking them into its closure, so recreating an adapter at an already-registered endpoint (an auth-token rotation) updates the loader instead of pinning the first instance's stale `fetchFn`.

## Testing

- Nearly every module here has a co-located `*.test.ts`. The suite runs under
  `vitest.config.node.mts` with `environment: 'node'` — see [The boundary](#the-boundary) for why
  that is a design guardrail rather than a speed optimization.
- The golden-file regression test for L4's fan-out/grain-resolution behavior is
  `x-studio/src/internals/__fixtures__/fanOutGolden.test.ts`. It stayed in the binding because it
  pins the numbers a widget actually renders, which is the property worth freezing.
- `store/StudioController.test.ts` covers the controller end to end;
  `store/MutationHistory.test.ts` covers the undo/redo array bookkeeping in isolation.
- Cross-package agreement is pinned from the binding side:
  `x-studio/src/store/StudioController.crossLayer.test.ts` asserts that core and the binding still
  answer `getWidgetMinSpan` and `createChatTurnMutationLedger` identically.
- Benchmarks live in the binding (`x-studio/src/benchmarks/`) because they exercise the pipeline
  through the same entry points a widget uses; they measure each layer independently over a
  deterministic generator.
