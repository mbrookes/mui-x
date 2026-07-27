# Architecture

Internal reference for how `@mui/x-studio` is put together. For install/quick-start, see [`README.md`](./README.md).

## Contents

- [Overview](#overview)
- [Directory layout](#directory-layout)
- [The shared schema package](#the-shared-schema-package-muix-studio-schema)
- [State management](#state-management)
- [Data pipeline](#data-pipeline)
- [Widget system](#widget-system)
- [Canvas / layout](#canvas--layout)
- [Filters](#filters)
- [Persistence & schema migrations](#persistence--schema-migrations)
- [AI integration](#ai-integration)
- [Compose drawer & setup panels](#compose-drawer--setup-panels)
- [Internationalization](#internationalization)
- [Public API surface](#public-api-surface)
- [Testing & benchmarks](#testing--benchmarks)
- [Extension points](#extension-points)

## Overview

`x-studio` is an embedded analytics dashboard builder: a single `<Studio>` React component that lets end users compose pages of widgets (charts, grids, KPIs, maps, pivots, filters, text) backed by pluggable data sources, with an optional AI chat assistant that can drive the same authoring actions a human would.

Four layers:

1. **State** — `StudioController` (a `Store<StudioState>` with undo/redo) is the single source of truth. No component holds dashboard content, layout, filter, or selection state.
2. **Data pipeline** — a layered, aggressively-cached row-transformation pipeline (`internals/`) turning raw `dataSources[id].rows` into the exact rows a widget renders.
3. **UI** — a React tree (`components/`) that reads/writes the controller only through `useStudioSelector`/`useStudioController`.
4. **Server adapters** — optional (`server/`) helpers wiring a widget's data to a remote backend instead of in-memory rows, with request batching and cross-source join resolution.

Below `x-studio` sits `@mui/x-studio-schema`, which owns every state/widget/data/expression/AI-protocol type, the factories, the pure `applyMutation` reducer, persistence, and anomaly math. Both `x-studio` (client) and `@mui/x-studio-ai-middleware` (server) depend on it, so a `StudioState` shape change happens in exactly one place. See that package's own `ARCHITECTURE.md` for its internals.

## Directory layout

```text
packages/x-studio-schema/src/     Dependency-free shared types + pure functions
packages/x-studio/src/
  store/                          StudioController + docTransforms (persistence re-exported from the schema pkg)
  context/                        StudioProvider, useStudioSelector, selectors.ts
  internals/                      Data pipeline, caches, chart aggregation, widget/chart-type registries, i18n plumbing
  components/
    Studio/                       Studio, StudioDashboard, StudioContent, sidebar chrome
    StudioCanvas/                 Drag-and-drop grid layout engine
    StudioChatPanel/              AI assistant panel + backend adapter
    StudioComposeDrawer/          "Add/edit widget" authoring drawer + per-kind setup panels
    StudioDataDrawer/             Data sources, relationships, expression fields UI
    StudioFiltersDrawer/          Page/widget filters UI
    StudioWidgetCard/             Per-widget chrome (title, actions, export)
    StudioWidgetEditDialog/       Modal widget editor (filters, formatting)
    StudioExpressionFieldDialog/  Calculated-field / measure editor
    widgets/                      The 7 built-in widget kind implementations
  models/                         Re-exports of @mui/x-studio-schema + React-only custom-widget/feature-flag types
  utils/                          expressionEvaluator, gridGrouping, gridSummary, fieldCapabilities
  locales/                        Translation bundles (enUS, fr, de, es, ptBR)
  server/                         createBatchingAdapter, createSimpleAdapter
  benchmarks/                     vitest bench + a standalone tsx runner for the row pipeline
  icons/                          Custom SVG icon set
  themeAugmentation/              MUI theme defaultProps augmentation
```

## The shared schema package (`@mui/x-studio-schema`)

`packages/x-studio-schema/src/index.ts` is the single source of truth for the data model:

- **Types** (`baseTypes` / `dataTypes` / `widgetTypes` / `expressionTypes` / `stateTypes` / `aiTypes`). `stateTypes.ts` defines the lifetime-partitioned `StudioState` (see [State management](#state-management)). `widgetTypes.ts` composes the widget model from per-kind interfaces and exposes the discriminated union `StudioWidget`/`StudioWidgetOf<K>` alongside the flat patch type `StudioWidgetConfig`. The chart slice is split one level finer: `StudioChartWidgetConfig` is a union of ten per-family interfaces keyed by `StudioChartType` (a closed union of **sixteen** literals — no custom chart types, per `AGENTS.md`), with `StudioChartConfigOfType<T>` narrowing to one family.
- **`statePersistence.ts`** — `serializeState`/`serializeDoc`/`deserializeState`/`migrateState`, `CURRENT_SCHEMA_VERSION`, and the migrations registry. See [Persistence](#persistence--schema-migrations).
- **`factories.ts`** — `createDefaultStudioState`, `createDefaultWidget`, `normalizeGridColumn`, and the collision-resistant id minters (`createWidgetId`/`createPageId`/`createFilterId`/`createPresetId`: timestamp + per-process counter + random suffix, so two ids minted in the same millisecond never collide). `createDefaultWidget` dispatches off a `BUILTIN_WIDGET_DEFAULTS` table, so UI-created and AI-created widgets start from the same defaults and a kind with no table entry fails to compile.
- **`applyMutation.ts`** — the pure reducer mapping a `StateMutation` onto a `StudioState`, dispatched through a `MUTATION_HANDLERS` table keyed by mutation type (each entry co-locating its `apply` and `label`). It is the **one** implementation of every mutation's effect: the AI middleware computes its threaded `nextState` with it and the client's controller applies the identical function, so the two sides can never disagree about what a tool call did.
- **`anomalyDetection.ts`** — Tukey IQR outlier detection, shared so the AI's anomaly tool and the chart widget's client-side detection agree.

The schema package has **zero runtime dependencies** (no React, no Node built-ins) so it is importable from a browser bundle and a server bundle alike.

**The dividing line.** Anything that is _only_ a pure state-shape transform (mutation reducers, default-state factories, anomaly math) belongs in the schema package. Anything touching React, MUI, the DOM, in-memory row data (pipeline, caches, chart rendering), or that is a component prop rather than persisted state (feature flags, in `models/featureFlags.ts`) stays in `x-studio`. The dependency arrow runs `x-studio` → `x-studio-schema`, never the reverse.

## State management

### `StudioState` is partitioned by lifetime

Defined in the schema package's `stateTypes.ts`. Getting this partition wrong is the single easiest way to break the package, so it is spelled out:

| Partition                   | Contents                                                                                                                        | Persisted                 | Undoable | Reducer-mutable |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------- | --------------- |
| `doc` (`StudioDoc`)         | `dashboard`, `pages`, `widgets`, `relationships`, `filters`, `expressionFields`, optional `filterPresets`/`ai`, `schemaVersion` | yes (minus cross-filters) | yes      | yes             |
| `session` (`StudioSession`) | `mode` (view/edit), `shell` (open drawers, selection ids)                                                                       | no                        | no       | no              |
| `runtime` (`StudioRuntime`) | host-injected `dataSources`                                                                                                     | no                        | no       | no              |

Why each boundary sits where it does:

- **`mode` is in `session`, not `doc`** — switching view↔edit is not a dashboard edit and must not be Ctrl+Z-able.
- **`runtime.dataSources` is never undone** — an undo must never revert live data to stale rows.
- **Cross-filter-scoped filter entries live in `doc.filters`**, not `session`. The reducer manipulates them (cleanup on `removeWidget`/`removePage`/`applyBulkUpdate`) and `applyCrossFilter` is _deliberately_ undoable, so a chart-click cross-filter is Ctrl+Z-able like any other doc edit. They are stripped only at the persistence boundary.

### `StudioController` (`src/store/StudioController.ts`)

Wraps a `Store<StudioState>` from `@mui/x-internals/store` — a minimal observable (`state`, `subscribe`, `setState`, `getSnapshot`) built to back `useSyncExternalStore`. State is never mutated in place; every method computes a new object and passes it to a private `commitState`, which:

- Pushes the previous **`doc`** onto the undo stack (`StudioDoc[]`, capped at `MAX_UNDO_HISTORY = 100`) — only when `nextState.doc !== current.doc` by reference. A commit touching only `session`/`runtime` takes effect immediately but creates **no** undo entry regardless of the `undoable` flag.
- Clears the redo stack on every new undoable doc commit.
- Optionally appends a `{ label, at }` entry to the capped recent-mutation log (`MAX_MUTATION_LOG = 20`), surfaced to the AI via `getRecentMutations()`.
- Calls `store.setState(next)`, notifying subscribers synchronously.

**Undoability policy.** `{ undoable: false }` suppresses the undo entry even when the doc changed. It is for writes the user did not author as a document edit: interactive-filter selection, `setGlobalCrossFilterMode`/`setCrossFilterAllPages`, `setActivePage` navigation, AI chat-thread writes, a grid sort gesture, and _system-initiated self-repair_ (e.g. `KpiSetupPanel` fixing an invalid stored aggregation, `StudioDateRangeBar` expanding a persisted date-range preset to cover late-injected sources). A plain undoable commit fired from merely rendering a panel would push an unauthored undo entry and, when re-triggered after an undo, clear the redo stack — trapping the stack for as long as the panel stays open.

**Mutation-log labelling policy.** The log push is gated only on the doc actually changing, **not** on `undoable` — a non-undoable but genuine document change (`applyExternalMutation`'s `setActivePage`/`renameAIThread`) is still a real AI-authored change the model's change log must surface. Label suppression (`label: null`) is therefore an explicit, narrow choice, reserved for exactly two cases:

1. **System-initiated self-repair** — signalled by `{ undoable: false }` on `updateWidgetConfig`/`updateFilter`. Since the log is capped, a synthetic self-repair line could evict a genuine user entry.
2. **User-driven navigation** — `setActivePage`.

Every genuine user edit is labelled, including `updateWidget` (which carries the broader edit: title, subtitle, kind, sourceId, plus folded stale-filter removals) and `duplicateWidget` (labelled `addWidget:<kind>:<id>`, matching `insertWidgetAt`, because a duplicate _is_ a widget creation). Both previously inherited `label: null` from their pre-reducer hand-written implementations. That mattered because the same mutations arriving over the wire _are_ logged, so `getRecentMutations()` reported the assistant's own widget edits while hiding the user's — the exact inversion of the log's purpose.

**Undo/redo log reconciliation.** Every undoable commit also pushes its (possibly `null`) log entry onto a parallel `undoMutationLog` stack, 1:1 length-matched with the `StudioDoc[]` undo stack. `undo()` pops the paired entry, removes it from `mutationLog` by reference (it may already have scrolled out — `mutationLog` is capped independently), and pushes it onto `redoMutationLog`; `redo()` reverses the transfer.

`redo()` does **not** blindly re-append at the tail. A non-undoable but _labelled_ commit can land between an entry's undo and its redo without clearing the redo stack, so a genuinely newer entry may already sit there. Each entry therefore carries an exact insertion order from a private monotonic sequence counter held in a `WeakMap` — not the public `at` ISO timestamp, whose millisecond resolution ties across same-millisecond commits (routine in tests, reachable with two AI-tool mutations in one turn). `redo()` re-inserts just before the first entry with a strictly greater sequence number.

### Composition helpers

Each is the one-liner base for a family of writers, so no method hand-spreads the nested partition structure:

- `commitDocPatch(patch, options?)` — shallow-merges a `Partial<StudioDoc>`, with a reference-equality no-op guard (a patch whose every key is reference-equal commits nothing). **The guard is `===`, so it cannot see a fresh-but-equivalent object.** A writer that _rebuilds_ its slice from scratch (rather than reusing existing element references) therefore needs its own value-equality bail, or a semantically identical re-invocation pushes an undo entry, writes a mutation-log line, and clears the redo stack. The controller-managed filter rebuilders — the three date-range setters and `applyCrossFilter` — all share `docTransforms.isSameManagedFilterContent` for exactly this.
- `commitShellPatch(patch)` — merges onto `session.shell`, always non-undoable.
- `commitDataSourcePatch(sourceId, patch)` — merges onto one `runtime.dataSources` entry, always non-undoable, no-op on a missing source.
- `updateState({ doc?, session?, runtime? })` — partition-aware partial update; callers name the partition explicitly.

**Value-equality bail before committing.** Several writers build a fresh object unconditionally (`{ ...x, ...changes }`), which defeats `commitDocPatch`'s reference guard even when every patched key already holds its incoming value — the commit still pushes a no-op undo entry and wipes the redo stack. `setAdjacentWidgetColSpans`, `reorderPages`, `setPageStackBreakpoint`, `updateActivePage`, `updateRelationship`, `updateExpressionField`, `updateFilter`, `renameFilterPreset`, `updateDataSourceField`, `setGlobalCrossFilterMode`, and `setCrossFilterAllPages` all compare every key the patch would touch and return without committing when they all match.

### The `commitMutation` choke-point

Every user-driven method with a shared `StateMutation` equivalent, and every AI mutation, funnels through one private helper: `commitMutations(mutations, { label?, undoable?, transform?, resolveUndoable? })`. It folds an ordered sequence of `StateMutation`s through the shared `applyMutation` reducer with `reduce` and commits the final state as **one** undoable step, one subscriber notification, one log line (labelled by joining the mutations' own `mutationLabel`s with `' + '`). `commitMutation` is the single-mutation wrapper.

Because the reducer is pure, the whole fold happens before the store is touched. This lets a composite gesture converge on the reducer without a bespoke `StateMutation` variant — a cross-page move is two `setWidgetLayout`s; a compose-drawer insert is `addWidget` + `setWidgetLayout`; a duplicate is `addWidget` + `setWidgetLayout` + one `addFilter` per cloned filter. **Adding a `StateMutation` variant is deliberately avoided** — each variant is nominally AI-tool-facing wire surface.

Three subtleties:

- A commit is skipped entirely when the reducer returns the same state reference (unknown id, already applied).
- The no-op check runs on **`transform`'s output**, not the raw fold result, and `transform` always runs. Some callers (`updateWidget` re-triggering title inference off an idempotent payload) rely on `transform` alone to produce the real change. To avoid reintroducing spurious commits, the shell-selection transforms guard on the target widget's actual post-fold presence, and `applyInferredTitles` returns its input unchanged when the inferred _text_ didn't change.
- Every `transform` guards with `Object.hasOwn(next.doc.widgets, widgetId)` before dereferencing — the transform runs even on a no-op fold, so a stale id from a custom setup panel or a race with an AI `removeWidget` would otherwise throw.

**AI mutations**: `applyExternalMutation(mutation, label?)` is the wire-adjacent public wrapper. It classifies a transient-only doc diff (a `setActivePage`/`renamePage`-shaped mutation that must stay non-undoable) via a `resolveUndoable` callback evaluated against the fold's own result, rather than running the reducer a second time.

**`updateWidget`'s `undefined`-voiding is wire-safe.** Callers void a top-level field by passing explicit `undefined`, but the reducer skips `undefined`-valued `changes` keys (an `undefined` can never survive JSON). So `updateWidget` splits `changes` into real-valued keys (→ `args.changes`) and explicitly-undefined keys (→ `args.unsetFields`, which the reducer deletes). Required fields (`kind`/`title`/`config`) are never voidable.

**`updateWidgetConfig`'s write-side key guard.** `StudioWidgetConfigForKind<K>` only constrains code that reads `widget.config` _after_ narrowing on `kind`/`chartType`; this method is generic because it patches before any narrowing. It runs the patch through the schema package's key validators two layers deep — `validateConfigKeysForKind`, then (for a chart) `validateChartConfigKeysForType` against the effective chart type. Unlike the AI tool boundary (which rejects the call), this is **warn-and-strip**: a stray key reaching here is a UI bug, not untrusted input. Both layers validate only the incoming **patch**, never the stored config — key retention across `chartType` switches is a deliberate feature (see [chart config retention](#chart-config-retention-across-type-switch)).

### Cross-page moves and rank-filter uniqueness

`moveWidget` (canvas drag-and-drop) and `moveWidgetToPage` (context menu) share a private `commitWidgetMove` core. It composes the source/target `setWidgetLayout` pair and folds two kinds of cleanup into the **same** commit, so a drop and its consequences are one undo step:

1. **Rank-filter conflict.** A widget-scoped rank (Top-N) filter follows its widget; its page context is resolved from that page's `widgetRows` via `resolveRankFilterPageId`. Moving a rank-filtered widget onto a page that already has a conflicting rank filter would land two in one page context — the state `addFilter`/`updateFilter`/`duplicateWidget` reject and the filters drawer assumes cannot exist. The move drops the moved widget's filter, guard-and-continue, via the shared `hasConflictingRankFilter` check (modelling the widget's post-move context as page-scoped on `targetPageId`, since it isn't on that page yet).

   The `removeFilter` mutation is **unshifted** ahead of the layout mutations, not pushed after them. `setWidgetLayout` re-runs the reducer's own array-order rank-uniqueness sweep, which breaks a tie by array position (matching the load boundary) and could therefore drop the _target_ page's resident filter instead. The controller's policy is the more specific one — **the widget you just moved yields to the page it moved into** — so it must resolve the conflict first, leaving the reducer's sweep nothing to do. This is an ordering fix; neither rule is weakened.

2. **Emitted-scope cleanup.** Every filter the moved widget _emits_ whose scope is pinned to the source page — `interactive` (filter-widget/slider) selections and `cross-filter` (chart-click) entries, both keyed by `scope.sourceWidgetId` with a `scope.pageId` — is removed. The move rewrites layouts only; those `scope.pageId`s would keep pointing at the source page, leaving the old page hard-filtered with no controlling widget while the control on the new page advertises a live-looking selection that filters nothing. A selection made in page A's context has no defined meaning on page B. Widget-scoped rank filters travel with the widget under a different `scope.kind`, so the two loops never overlap.

Both cleanups are scoped to `sourcePageId !== targetPageId`; a same-page move cannot create either problem.

**Staleness guards.** `moveWidget`'s `sourcePageId` is captured at drag-start, so it re-resolves the widget's actual current page via `resolveWidgetPageId` right before committing (dev-warning on disagreement) — a concurrent relocation mid-drag would otherwise clear a page the widget no longer lives on while still appending it to the target, duplicating it across two pages' rows. `moveWidgetToPage` resolves its source page the same way rather than assuming the active page. Both no-op when `targetPageId` no longer exists in `doc.pages`.

`duplicateWidget` runs the same `hasConflictingRankFilter` check on cloned filters: the clone always lands on the active page, so a cloned rank filter would resolve to the same page context as the source widget's own. The reducer's `addFilter` handler applies a mutation verbatim with no rank check, so without the guard the invariant violation would persist into the saved doc.

### Drag-and-drop, layout, and orphan detection

The canvas owns only geometry/splice math. Drops commit via `controller.insertWidgetAt(widget, pageId, rows)` or `controller.moveWidget(widgetId, sourcePageId, pageId, targetRows)`, so drag-and-drop, keyboard reorder (`setWidgetLayout`), and the AI path share one column-span-cleanup implementation (the reducer's `enforceLayoutColSpans`).

Unlike public `setWidgetLayout` (which throws on unknown/omitted widget ids), `insertWidgetAt`/`commitWidgetMove`/`duplicateWidget` accept caller-computed geometry with no validation, so a canvas bug could silently orphan a widget (present in `doc.widgets`, absent from every page's rows). `warnOnOrphanedWidgets` is a dev-mode diagnostic run after `insertWidgetAt` and `duplicateWidget` that scans for exactly that.

Layout math lives in the 24-column unit system: `GRID_COLS = 24`, `MIN_SPAN = GRID_COLS / 4`, both exported from the schema package's `applyMutation.ts` so a manual drag-resize and an AI `set_widget_width` clamp identically. `setAdjacentWidgetColSpans` validates both ids exist and share a row before acting, and floors the right widget's span at its own minimum when the pair's combined minimums exceed the total — mirroring `enforceLayoutColSpans`: favour widening over ever committing a sub-minimum span. Keyboard move (`internals/widgetLayoutMove.ts`) enforces the same `MAX_PER_ROW = floor(GRID_COLS / MIN_SPAN)` cap the mouse path gets, splicing a new row rather than overflowing a full one.

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

- **`carryTransientDocState`** overlays the current doc's non-undoable transient `doc` state onto the swapped-in doc: interactive-filter selections, the `globalCrossFilterMode`/`crossFilterAllPages` toggles, and `doc.ai` (chat threads, written non-undoably on every streamed token). A Ctrl+Z on an unrelated edit must not revert any of them. Cross-filter entries are **not** carried — they are undoable by design. Each carried interactive filter's `scope.pageId` is _re-derived_ against the emitting widget's page in the **incoming** doc (via `resolveWidgetPageIdInDoc`), so undoing a widget's cross-page move makes its selection follow the widget back rather than keeping a stale new-page id.
- **`activePageId`** is re-derived, not carried: it overlays the current value only when the incoming doc actually contains that page, else falls back to the incoming doc's first page — so undoing `addPage` (which removes the page being viewed), or redoing `removePage`, lands somewhere real.
- **`normalizeSessionAfterDocSwap`** nulls `shell.selectedWidgetId` when the swapped-in doc no longer contains it. It is also invoked directly by `removeWidget`, `removePage`, and `applyExternalMutation` — a user-driven removal or an AI mutation can dangle the selection just as easily as time-travel can, and a dangling id renders the compose drawer blank instead of the add-widget view. `selectedSourceId`/`selectedFieldId` reference `runtime.dataSources`, which undo never touches, so they cannot dangle.

### Extracted pure `doc` transforms

Two families of `StudioDoc → StudioDoc` logic live outside the controller class so the methods stay thin wrappers. Each returns the **same** `doc` reference for a logical no-op, so `commitDocPatch`'s guard behaves exactly as it would inline.

**`store/docTransforms.ts`** — date-range setters (`setDashboardDateRange`, `setDashboardDateRangeAll`, `setWidgetDateRange`, sharing one `buildDateRangeFilter`) and filter-preset operations.

- `buildDateRangeFilter` encodes the custom-vs-preset value logic once: `'custom'` stores explicit `{from,to}`; every other preset stores `value: null`, resolved fresh at query time by `resolveDateRangePreset`, so a stored filter is never a stale absolute date.
- `setDashboardDateRangeAll` is **additive and field-preserving**, not rebuild-all: it indexes each page's existing `dashboard-date-range` filters by source, reuses an existing filter's `id`/`field`/`fieldType`, and mints a fresh filter only for a source not yet covered. This matters most for `'custom'`, where `StudioDateRangeBar`'s reconciliation effect threads the existing filter's bounds back through as `customFrom`/`customTo`. A rebuild-all produced an empty filter set whose length mismatch triggered a full non-undoable removal of every custom date-range filter — the Select silently flipping to "All time" with no Ctrl+Z recovery.
- Filter presets round-trip cascading references: `saveFilterPreset` re-keys each captured filter's id to `${presetId}-${f.id}` and rewrites `dependsOn` through the same scheme (dropping references outside the captured set); `applyFilterPreset` builds an oldId→freshId map up front and rewrites `dependsOn` through it. Both guard with `Array.isArray(f.dependsOn)` and explicitly null out a wrong-shaped value rather than letting the spread carry it through to a `TypeError`.
- `applyFilterPreset` retains every non-page filter, every page filter scoped to another page, **and every legacy `pageId`-less page filter** unconditionally. Those legacy entries apply to _every_ page (`selectFiltersForWidget`'s `!pageId` branch), so deleting them on any preset apply wiped an all-pages filter from the whole dashboard, not just the targeted page. It also runs each re-materialized rank filter through `hasConflictingRankFilter` (weighed against retained widget-scoped filters plus preset filters already accepted in the same apply), since `saveFilterPreset` applies no rank exclusion when capturing.

**`internals/rankFilterScope.ts`** — re-exports `resolveRankFilterPageId`/`hasConflictingRankFilter` from the schema package rather than maintaining a hand-synced copy. The reducer needs its own implementation and the dependency arrow forbids it importing a client copy, so the client re-exports the schema package's. One rank filter per page context, shared by `addFilter`, `updateFilter`, `commitWidgetMove`, `duplicateWidget`, `applyFilterPreset`, and the drawer rows.

### Data-source and adapter bookkeeping

The recurring hazard here is a **refetch loop**: a host passing an inline `dataAdapters={{ orders: adapter }}` map plus an `onStateChange` that stores the new state gets commit → parent re-render → new inline identity → effect refires → commit. Both `setDataSourceAdapter` and `upsertDataSource` therefore early-return (no invalidation, no commit) when the resulting entry is reference-identical to the stored one. The adapter-carry branch always allocates a fresh object, so it still commits and invalidates as before.

- `upsertDataSource`/`setDataSourceAdapter` otherwise invalidate the module-singleton `studioRequestCache` for the affected source. Invalidation **generation-tags in-flight requests**: it bumps the source's generation so an in-flight result started before the invalidation is not written back, and a caller arriving after sees that entry as absent (via `getInflight`) and starts a fresh fetch rather than joining a promise that will resolve to pre-invalidation rows. A caller already awaiting the promise still receives its result.
- `upsertDataSource` with a bare `dataSource` (no `adapter` field — e.g. from a `StudioDashboard` config swap, which round-trips through JSON) **preserves** an adapter previously registered on that id; an incoming source carrying its own adapter still wins. Cache invalidation runs regardless of whether either entry carries an adapter, so a config swap can never serve pre-swap rows.
- `StudioRequestCache` (30s TTL, in-flight dedup) caps its entry count (LRU, expired swept first) on every `set()` rather than only evicting on re-request after TTL — each filter/date-range tweak mints a new `cacheKey`, so the module singleton would otherwise grow monotonically across a session.
- `setDataSourceAdapter` no-ops when the target source doesn't exist yet, which the same-reference guard cannot close on its own. The fix lives in the caller that owns both the config and the adapter map — see [`StudioDashboard`](#studiodashboards-config-swap-protocol).

### React integration (`src/context/StudioContext.tsx`)

`StudioProvider` puts the controller into `StudioContext` and wraps UI configuration (`tableSourceMode`, `featureFlags`, merged `localeText`, `aiConfig`, `customWidgets`, `geographies`, `onOpenFilterPanel`) into a second `StudioUIConfigContext.Provider`. A module-level frozen `EMPTY_FLAGS` is the `featureFlags` fallback so the `uiConfig` memo isn't busted by a fresh `{}` per render.

- `useStudioController()` — throws outside a provider.
- `useStudioState()` — subscribes to the entire state (prefer a selector).
- `useStudioSelector(selector)` — `useSyncExternalStore`-based, re-renders only when the selected slice changes by `Object.is`.

`src/context/selectors.ts` holds a library of property selectors plus selector **factories** for per-id/per-page lookups (`makeSelectExpressionFieldsForSources`, `makeSelectPartitionedFiltersForPage`, `makeSelectActiveCrossFilter`, `makeSelectIncomingCrossFilters`, `makeSelectWidgetRankFilter`, `makeSelectWidgetSliderFilter`, `makeSelectActiveInteractiveFilter`, …). Factories are memoized per call site so each widget subscribes to only the slice it needs — adding an expression field to an unrelated source never re-renders a widget that can't reach it.

Two invariants the selectors must uphold, because the UI and the data paths otherwise disagree:

- **Every selector that decides "is this filter active" excludes `disabled` entries**, matching `selectFiltersForWidget` and the data paths. Otherwise a chip/pill/selection advertises a filter the rows don't apply.
- **Cross-filter selectors honour `crossFilterAllPages`**, matching `useWidgetRows`'s `hasChartCrossFilters` and `filterScoping.ts`'s row scoping. Without it, hover/highlight gating behaved as if no cross-filter were incoming while the rows were being filtered/ghosted for it.

`makeSelectActiveCrossFilter` and `makeSelectWidgetActiveCrossFilter` share one `isActiveCrossFilter` predicate so the two never answer the same question differently, and `makeSelectWidgetRankFilter` coerces the rank value with `Number(...)` so a numeric-string N (`"5"`) still surfaces its chip, matching the data paths' own coercion. The filter-partitioning variants share one core (`partitionFilters` + `isPartitionUnchanged`, composed by `makePartitionedFiltersSelector`); `selectPartitionedFilters` is the deliberate exception, staying on `createSelectorMemoized` because its per-store-instance cache key is load-bearing across multiple controller instances.

**Multi-instance mounting** (two `<StudioDashboard>`s on one page) is explicitly supported, including keyboard shortcuts. `useStudioKeyboardShortcuts(rootRef)` still attaches its `keydown` listener at `window` level — removing it would break shortcuts fired while focus sits on a portaled MUI popover outside the Studio subtree — but gates every keypress on `isActiveInstance()`: true when `document.activeElement` is inside that instance's root, or, when focus is outside every root, when this instance was the last to hold focus (a module-level `lastFocusedRoot` arbiter). Two instances never both react to one Ctrl+Z.

## Data pipeline

The pipeline turns `dataSources[id].rows` into the rows a specific widget renders, in four numbered layers plus widget-facing hooks.

### L1 — Normalize (`internals/normalizedRowsCache.ts`)

`getCachedNormalizedDataSource(dataSource, usedFieldIds?)` calls `normalizeDataSourceRows` (`temporalUtils.ts`) to canonicalize date/datetime values and pre-build per-field distinct-value indexes, caching on a `WeakMap<Row[], Map<fieldSetKey, entry>>`. `usedFieldIds` scopes normalization to the fields a widget actually uses ("lazy-by-widget"), each field set getting its own slot, so adding an unused field to a different widget's config is zero cost.

**Every foreign-source read in the package goes through L1**, not `dataSources[id]?.rows` directly — L4's anchor/junction/M:N-remote rows, `dataSourceGraph`'s related-field enrichment (one-hop and two-hop), `crossSourceEnrichment`, `grainResolution.enrichForeignExpressionFields`, and the CSV export. **Adapter responses count as foreign-source reads**: `useWidgetRows` wraps `adapterRows` in a synthetic `{ ...dataSource, rows: adapterRows }` and runs the same `getCachedNormalizedDataSource` call before L2 — memoized on the rows identity so the `WeakMap` slot is reused, and reusing the sync path's own slot outright for cold-cache placeholder rows (which _are_ `dataSource.rows`). Two failure modes justify this:

- The filter engine uses a local-calendar-day policy while the chart-grouping engine uses UTC components, so an un-normalized raw `Date`/timestamp buckets into different days for a non-UTC viewer. Both policies treat a canonical `YYYY-MM-DD` string identically.
- Worse, a raw `Date` through an expression's ordering comparator is outright wrong, not merely differently bucketed: the non-numeric fallback compares lexicographically, and `String(rawDate)` always sorts after any `YYYY-MM-DD` literal, so `>=` against a date literal evaluated `true` for every row regardless of the real date.

Non-ISO or zone-ambiguous inputs (`'1/15/2024'`, a zone-less datetime, a `Date`, a numeric timestamp) are read via local Y/M/D components (`isZonedDateInput`/`toLocalYmd`) rather than `toISOString()`, so ingestion doesn't day-shift for viewers ahead of UTC. Canonical ISO strings are unaffected.

The adapter case is the one where these inputs are the _norm_ rather than the exception: a zone-less `'2024-01-15T23:30:00'` is what MySQL/SQLite drivers routinely hand back, and it is precisely the shape `CANONICAL_DATETIME` refuses to accept as already-canonical. Skipping L1 there meant the same rows, the same dashboard, bucketed one way in memory and another through an adapter — the parity test in `useWidgetRows.test.ts` (run the same rows down both paths, assert identical canonical values) is the regression guard, and it holds in any timezone because it never asserts _which_ day is right, only that the two paths cannot disagree.

### L2 — Enrich (`internals/enrichedRowsCache.ts`)

`getCachedEnrichedRows(rows, sourceId, expressionFields, dataSources, relationships, usedFieldIds?)` evaluates non-measure `StudioExpressionField`s (calculated columns, including cross-source `JoinFieldExpression`s) via `enrichRowsWithExpressions` and merges the values onto each row.

- Two-level caching (`rows` WeakMap → `fieldSetKey` Map). An entry is invalidated only if its own rows changed, a _relevant_ expression-field object changed by reference (editing a formula replaces the object), a joined foreign source's rows changed, or a relevant relationship changed.
- `expandWithDependencies` walks each requested field's transitive expression dependencies (field A referencing field B pulls B in), so a widget only pays for the expressions it needs.
- **Measure expressions (`isMeasure: true`) are excluded from row-level enrichment entirely** — a measure's value doesn't exist per row.
- The ordering comparators (`<`, `>`, `<=`, `>=`) are null-safe and type-aware: they return `null` when either operand is null/undefined (propagating "unknown" the way the other null-aware operators do), and otherwise compare numeric-like operands numerically or fall back to a lexicographic string comparison — which also orders `YYYY-MM-DD` strings correctly with no date parsing. Coercing both sides through `toNumber` (which maps `null` and non-numeric strings to `0`, including any ISO date string) made every date comparison a constant.
- **The equality operators (`equals`, `notEqual`, `in`) use the filter engine's explicit comparison policy, never loose `==`.** `scalarEquals` mirrors `filterUtils`' `compileSingleCondition`: nullish equals only nullish; both sides numeric-like (numbers and cleanly-parsing non-blank strings — deliberately excluding booleans, exactly as `toNumericValue` does) compare as numbers so `'20'` still equals `20`; everything else compares `String(a) === String(b)`. Loose `==` cross-coerces (`'' == 0`, `false == '0'`, `true == 1`), so a CSV whose blank numeric cells import as `''` made `sum(if(discount == 0, 1, 0))` count every blank row as a genuine zero while the identical question asked as a filter excluded them — two answers to one question, breaking the "a KPI over a raw field and over a measure expression return the same number" invariant. `in` routes through the same helper, so `in(x, a, b)` is exactly `equals(x, a) || equals(x, b)`.
- `isTrue`/`isFalse` stay strict — they ask "is this the boolean true/false", not the truthiness question `and`/`or`/`if` ask through `toBoolean` — but they accept the `'true'`/`'false'` string form a CSV/API boolean column carries, matching `toBoolean` and `filterUtils`' string-comparing `fieldType: 'boolean'` branch. Otherwise one string-boolean column got three different answers from `isTrue`, `if`, and an equivalent filter.
- **`JoinFieldExpression` resolution is direction-independent.** `findJoinFields` matches a direct relationship with the evaluating source at _either_ end (and skips `many-to-many`, whose two fields are endpoint keys rather than an FK/PK pair), so a relationship declared from the "one" side resolves `join(customers.country)` on `orders` the same way `createBatchingAdapter.resolveField` always has. The fast (prebuilt index) and slow (per-row fallback) paths call the one helper, so they cannot drift. `enrichedRowsCache`'s `relevantRelationships` filter carries the **same** predicate — widening one without the other opens a cache-invalidation hole where an edit to a reverse-declared relationship changes the joined values while leaving `relRefs` untouched.

### L3 — Filter (`internals/filterScoping.ts`, `dataSourceGraph.ts`, `resolvedRowsCache.ts`)

**1. Scoping** — `selectFiltersForWidget(filters, { widgetId, widgetSourceId, activePageId, include, crossFilterAllPages, includeWidgetRank })` is the single source of truth for _which_ filters apply to a widget. It switches on `scope.kind` and then runs `resolveDateRangePresets` to turn a stored preset into concrete bounds computed at query time. Disabled filters are dropped up front.

`include` gates **only the two interaction-driven scope kinds**. `page`, `widget` and `dashboard-date-range` are authored filters and are considered for every value:

| `include`          | Scope kinds returned                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `'all'` (default)  | page + widget + **dashboard-date-range** + cross-filter + interactive |
| `'no-cross'`       | page + widget + **dashboard-date-range**                              |
| `'no-chart-cross'` | the above + interactive (no `cross-filter`)                           |

The `dashboard-date-range` term is load-bearing, not incidental: `useBlendedSeriesRows` passes `'no-cross'` precisely to get the page + dashboard-date-range set for a foreign series' source. Reading `'no-cross'` as "page + widget only" describes behaviour no caller wants.

**`activePageId === undefined` is a wildcard for every scope kind that carries a `pageId`** — page, cross-filter, interactive, dashboard-date-range alike. This matters for the non-React `StudioPipeline` (CSV export, benchmarks, tests), documented to run without page-navigation context: a caller in that position wants every authored filter to apply, not a mix where page filters are silently dropped while cross/interactive filters from every page are kept.

**2. Widget-scoped rank (Top-N)** — `includeWidgetRank` (default `false`) opts a caller into also returning a widget-scoped `filterMode: 'rank'` filter. The invariant is **a widget-scoped rank is applied exactly once, at either L3 or post-aggregation — never both, never neither**. `shouldApplyWidgetRankAtL3(widget)` (`internals/StudioPipeline.ts`) is the single decision:

- `true` for every non-chart kind (grid / KPI / map / pivot / filter / text / custom) **and** for the chart families that aggregate rows directly with no post-aggregation rank step (heatmap / funnel / sankey / gantt / scatter / gauge). These have no other enforcement point, so without L3 their authored Top-N would be silently ignored.
- `false` for the xy families (`bar*`, `line`, `area*`, `pie`, `donut`, `mixed`), which re-rank their aggregated series themselves via `applyRankToAggregated`/`applyRankToMultiSeries`/`applyRankToSeriesFieldData`. Applying at L3 too would double-reduce.
- A chart with no `chartType` resolves to `'bar'` via `resolveChartType`, matching what `StudioChartWidget` renders.

The family set backing it (`POST_AGGREGATION_RANK_CHART_TYPES`) is deliberately **not exported**, so no caller can re-derive the "is this a chart?" half of the rule and drift from it. Every path that resolves a widget's rows routes through the helper: `useWidgetRows`, `widgetExport.runWidgetExport`, and `generateInsight`'s AI summaries. `StudioKpiWidget` no longer calls `selectFiltersForWidget` (or this helper) at all — its five former call sites now share the one `kpiScopedFilters` value built from `useWidgetRows`' exposed sets, which is where the rank rule is applied. `StudioPipeline.resolveWidgetRows` applies it automatically when handed a `StudioWidget` object; the bare-id overload falls back to `false` and exists only for callers with no widget object (`richContext`'s dashboard-wide field stats, which uses a synthetic id no widget filter can match).

`queryDescriptor.ts` strips every `filterMode === 'rank'` leaf before building a server filter tree regardless of this flag — rank has no wire representation and is always applied client-side after the fetch.

**3. Row filtering** — `resolveRows` (`dataSourceGraph.ts`) separates _native_ filters (same source as the widget) from _cross-filters_ (`filterSourceId` differs, or the field is an expression owned by another source), resolves a `JoinPath` per cross-filter via `findJoinPath`, semi-joins the widget rows against matching foreign rows, and runs `applyFilters`/`compileRowTest` for the natives.

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

### L4 — Re-anchor (chart widgets only) (`internals/grainResolution.ts`, `chartSupport.ts`)

When a chart's x/y/series fields span more than one related source, aggregating the L3 result directly can double- or under-count through fan-out joins. `chartSupport.analyzeChartSupport` determines each field's owning source (`findDirectFieldOwner`) and whether the configuration can be safely aggregated (`isSafeWidgetBridgeOwner`). If it can, `resolveChartRowsForAggregation` calls `grainResolution.resolveRowsAtGrain(...)`, which re-derives the row grain relative to the chosen `anchorSourceId`.

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

**The L4 result cache** (`chartSupport.ts`) is keyed on `widgetRows`/`anchorRows`/a config fingerprint, `relationships`, the relevant expression fields, and the anchor-scoped (plus, for a junction anchor, remote-scoped) subset of the filter fingerprint — classified by the same `effectiveFilterSourceId` derivation, so a foreign-owned expression-field filter is folded in too. Grain resolution also reads rows from sources that are neither the widget's nor the anchor's (enrichment joins, M:N remote rows, third-source rows for a `seriesField`), so `resolveRowsAtGrain` takes a `collectReadSourceIds` out-param every branch populates; a hit requires every recorded source's `SourceDep` (rows **and** fields) to be unchanged, so refreshing e.g. `customers` while a chart on `orders` splits by `customers.segment` busts the entry instead of serving stale segments.

**The widget and anchor sources are recorded as `SourceDep`s too, not skipped as "already covered by the WeakMap keys".** A WeakMap key pins `rows` only, while the anchor rows are themselves read through `getCachedNormalizedDataSource` — keyed on rows _and_ fields. Retyping an anchor field (`updateDataSourceField` commits a new `fields` array with the same `rows` reference) therefore changed the re-anchored values with nothing in the validity check noticing, and the chart kept bucketing on `'1/15/2024'` while the grid beside it showed `'2024-01-15'`, unrecoverable short of replacing the anchor's rows.

**Scope limit.** This function handles only the "fan-out" direction (grouping dimension on the coarser side). The "fan-in" direction (aggregate a one-side measure grouped by a many-side field, e.g. summing `orders.total` grouped by `order_items.category`) has no single global grain and uses per-group dedup instead (`utils/gridGrouping.symmetricAggregate` for grids, an FK-keyed `Set` in the map widget). `analyzeChartSupport` never selects an anchor that would need it, so charts never hit that path.

### One join-key coercion policy

L3 semi-joins, L4 re-anchoring, display-column enrichment, grid fan-out dedup, **and L2's join-field expressions** all key through `normalizeJoinKey` (`internals/joinKeys.ts`): `null`/`undefined` → `null` (a missing FK never spuriously matches an empty key), `Date` → ISO string, everything else → `String(value)` (a numeric FK and a string PK compare equal). `indexRowsByKey`/`collectKeySet` build the `Map`/`Set` lookups on top. There is no pipeline stage that disagrees on join-key coercion.

### One numeric-coercion policy

`internals/aggregate.ts` owns it so widget kinds cannot drift on how they treat empty or non-numeric cells:

- `coerceAggregateValue(value)` — booleans → `0`/`1` (so `avg` yields a ratio), finite numbers → themselves, non-empty numeric strings → parsed (CSV/JSON sources have no native number type, so measures routinely arrive as strings, and parsing here keeps every accumulator in agreement with the aggregators' own numeric pre-detect). Everything else is **skipped**, never coerced to `0`, so it can't inflate an `avg` denominator or drag a `min` toward zero.
- `aggregateNumbers(values, fn)` reduces an already-coerced list. `min`/`max` reduce with a **loop**, not `Math.min(...values)` — the spread form throws `RangeError` past roughly 125k elements. The same applies in `gridGrouping`, `gridSummary`, and `richContext`'s `numericStats` (which runs synchronously inside every `sendMessage`).
- `createAggregateAccumulator`/`accumulateValue`/`finalizeAccumulator` stream values without buffering.

Every consumer routes through it: KPI `computeAggregate`, map region aggregation, pivot totals, the chart cell accumulator, grid group-by and footer totals, the expression evaluator's measure aggregation, and `filterUtils`' Top-N rank reduction. The generic chart aggregators coerce each **raw** cell before it reaches the accumulator (not only at finalize time — `Number(row[y] ?? 0)` coerced a null cell to `0`) and share one first-non-null pre-detect, all three falling back to `count` when the y-field is non-numeric.

**`'count'` means `COUNT(*)` everywhere**, independent of whether a per-row measure value is usable. Map regions, pivot cells/totals, and chart buckets each track a `rowCount` separately from the null-skipping accumulator, so a bucket whose measure values are all null still reports its true row count instead of disappearing or reading `0`. The expression evaluator's measure `count` matches SQL `COUNT(col)` for a non-numeric field by counting non-null raw values rather than coercing first and counting the numerically-valid subset.

**`null` means "unmeasured", not "zero".** Aggregated series carry `null` for a bucket with no usable measurement, and the whole stack preserves that rather than fabricating a `0`: the heatmap draws an unmeasured cell empty, the pie drops an unmeasured category, and the AI summaries report absence.

Ranking follows the same rule. `reduceRankScore` skips nulls (a null neither adds 0 to a sum, pulls an average toward 0, nor wins a `min`/`max`), and an all-null candidate scores `null`, which `selectRankedIndices` sorts to the **losing end in either direction** — a no-data candidate must never win a Top-N _or_ a Bottom-N slot, nor be coerced to a 0 that outranks every negative value. The comparator tests equality first so two no-data candidates don't compare `Infinity - Infinity === NaN`, which is not a consistent ordering and makes the surviving set engine-dependent.

### Aggregate & render

Per-chart-type aggregation lives in `internals/aggregators.ts` (`aggregateByField`, `aggregateByTwoFields`, `aggregateMultipleSeries`, `aggregateBlendedSeries`, `orderLabels`, and the three `applyRankTo*` helpers). `internals/chartShapes/` holds one file per chart-type shaping step (`scatter`, `heatmap`, `sankey`, `funnel`, `gantt`); `internals/chartAggregation.ts` is a composition barrel re-exporting `chartSupport` + `aggregators` + `chartShapes` so imports resolve through one entry point while the implementation stays split.

**Aggregation precedence.** Per-series `yAggregation` is honoured on every render path, not just the blended one: `aggregateByTwoFields` takes `config.yAggregation`, and `aggregateMultipleSeries` accepts either a single function or a per-field `Record<fieldId, fn>` map. Single-series/pie/heatmap/funnel aggregation is read from the **same `ySeries` entry that supplied the value field** (matched by `fieldId`, not `ySeries[0]`), falling back to `config.yAggregation` — mirroring the multi-Y path and the server push-down order in `chartTypeRegistry`, so a plain multi-series chart produces the same numbers as the push-down.

**The empty-value policy differs by dimension, deliberately.** An **axis/category** dimension DROPS a row whose value is `null`/`undefined`/`''` (`chartValues.isEmptyXValue`, applied by all three `aggregate*` functions, `chartShapes/heatmap`, `chartShapes/scatter` for either coordinate, and `StudioPieChart`); a **split/color** dimension KEEPS it under `emptyBucketLabel` (`aggregateByTwoFields`' `seriesField`, scatter's color field). A category axis answers "how does the measure break down _across_ this dimension", and a row with no value has no position on that breakdown — fabricating one invents a data point the source never held. A split merely partitions a category's rows, so deleting the unlabelled partition would make the stacked bars at a category sum to less than the single-series bar over the same rows. Two earlier fixes converged here rather than drifting: heatmap was changed _to_ drop so it would stop disagreeing with bar/line over the same field (T3.2b), scatter _to_ drop so null costs stopped stacking on `y = 0` (M13), while the series bucket was deliberately kept and localized (T3.2a).

The consequence worth knowing when reading a dashboard: **a chart's bars can total less than a KPI counting the same rows**, by exactly the number of rows with an empty x. That is the accepted cost of the rule, not a bug — changing it is a cross-family behaviour change across six call sites in four files. A corollary: because every axis call site runs the guard _before_ `toXValue`, `toXValue`'s own empty-bucket branch (and the `localeText` the aggregators thread into it on the x path) can never fire for an x value; the argument is kept so the guard-then-convert pair is spelled identically everywhere and the policy stays a one-line decision in `isEmptyXValue`.

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

**Adapter `avg` is never pushed down alongside `xGroupBy`.** `createBatchingAdapter` strips the spec and warns when `xGroupBy && hasAvgAggregation(...)`. The wire protocol cannot express the client's re-bucketing granularity: a server-side `avg` at the raw x-grain, client-re-bucketed by month, averages per-day averages — wrong unless every day has an equal row count. `sum`/`min`/`max` re-aggregate correctly across grains and are still pushed; `avg` and `count` must be finalized client-side over raw rows whenever `xGroupBy` re-buckets.

### Query-descriptor dispatch (`internals/queryDescriptor.ts`, `chartTypeRegistry.ts`)

The adapter path needs to know, per widget kind / chart type, which field ids belong in the SELECT and which aggregation specs to push down. `queryDescriptor.ts` builds the `StudioQueryDescriptor` but delegates per-type branching to `chartTypeRegistry.getDescriptor(kind, config)`, returning a `ChartTypeDescriptor` (`collectFields` + `buildAggregationSpecs`). Charts look up `config.chartType` in a map declared `satisfies Record<StudioChartType, ChartTypeDescriptor>` (a new chart type without an entry is a compile error); non-chart kinds look up `kind` in `widgetKindRegistry`.

Each type's push-down policy lives in exactly one place:

- **KPI and gauge never push aggregations.** Both aggregate client-side via `computeAggregate`; a server-side `COUNT` over one pre-aggregated row returns `1`, not the real count. Gauge is therefore _not_ routed through the shared `xyDescriptor` and has its own `gaugeDescriptor` whose `buildAggregationSpecs` always returns `[]`.
- Scatter/gantt return raw rows; foreign-source sparkline/blended-series fields are excluded from the primary SELECT and joined in memory.
- **Every descriptor reading a value field resolves it as `config.yField ?? config.ySeries?.[0]?.fieldId`**, mirroring the corresponding `render*` function's own fallback, so a config carrying the value only in `ySeries` (e.g. after a chart-type switch) is neither dropped from the SELECT nor missing from lazy expression enrichment.
- Sankey is the one family with no `yAggregation` concept — a link's weight is always the sum of its rows — so its descriptor hardcodes `fn: 'sum'`.
- `buildXYAggSpecs` de-duplicates by SQL alias: `config.yField` and a `ySeries` entry routinely name the same field (the setup panel writes both), and two specs for one alias produce an ambiguous duplicate-alias query. The more specific per-series fn wins.

**`select` is widened with incoming cross-filter / interactive-filter fields.** The adapter's client-side residual (`useWidgetRows`) is the _sole_ enforcement point for those scopes and evaluates them against the fetched rows, while the middleware projects only `select` — so a cross/interactive field not already in the widget's config would be missing from every row and `row[field] == value` would be `undefined == value` → false, emptying the widget.

For a same-source filter the filtered column is projected; for a cross-source filter the **relationship FK column on the widget's source** is projected instead (mirroring `findJoinPath`'s direct-relationship resolution). Only the _field set_ is folded in, never the per-value selection, so the `cacheKey` changes at most once when a cross/interactive filter first lands on a new field — clicking different values on the same field leaves it unchanged.

**The `cacheKey` folds in what each relative-date value currently _resolves_ to**, via the same `resolvedRelativeBound` helper `resolvedRowsCache.filterFingerprint` uses (including a bound nested inside a `between` value's `{from,to}`, which `isRelativeDateValue(value)` alone never sees). A `RelativeDateValue` is a stable object, so the raw filter tree stringifies identically across a `RELATIVE_DATE_REFRESH_CADENCE_MS` tick while the adapters resolve it to a different concrete instant at request time — one key naming two different windows. The segment is omitted entirely when no filter carries a relative date, so an ordinary dashboard's key does not churn.

**`buildWidgetQueryDescriptor(widget, pageId, tableName, state)` is the shared "descriptor from state" wrapper, and the only one production code should call.** The low-level `buildQueryDescriptor` defaults its last three parameters (`relationships`, `expressionFields`, `crossFilterAllPages`), which is convenient in tests but is exactly what let two production call sites drift: all three feed the `cacheKey`, so a caller silently defaulting one produced a _different_ key than one built from real state and missed an entry the other had populated. `WidgetQueryDescriptorState` requires them with no defaults, so omitting one is a compile error. Both `useAdapterRows` and `widgetExport.runWidgetExport` build through it.

### `useWidgetRows` (`internals/useWidgetRows.ts`)

The central widget-facing hook, branching on whether the widget's source has an `adapter`:

- **Sync path** — computes `usedFieldIds` from the widget's config plus _reachable_ filter fields (only filters `selectFiltersForWidget` actually scopes to this widget, so a filter elsewhere on the dashboard doesn't widen this widget's field set or invalidate its caches); runs L1 once per render, then a memoized `computeFilteredRows(include)` calls `selectFiltersForWidget` + `resolveRowsCached`.
- **Adapter path** — the fetch is encapsulated in `internals/useAdapterRows.ts` (descriptor via `buildWidgetQueryDescriptor`, `studioRequestCache` lookup, `adapter.getRows` in an effect), which returns the response **raw**. `useWidgetRows` then runs L1 over it (see the L1 section: a synthetic source wrapping `adapterRows`), re-applies L2 client-side (adapters return physical columns only; the server cannot compute a calculated field), and applies cross/interactive filters, reusing the **exact same** `getCachedNormalizedDataSource` + `selectFiltersForWidget` + `resolveRowsCached` calls as the sync path so the two cannot disagree about either canonicalization or scoping.
  - **Cold-cache placeholders run the full local chain.** While the fetch is pending, `dataSource.rows` are shown so the widget doesn't flash empty — but those rows never went to the server, so the residual-only pass's premise ("page/widget filters were baked into `descriptor.filter`") is false for them. Applying only the residual rendered the _full_ dataset, and KPI totals computed from it, on every load of a dashboard with e.g. a "last 30 days" range. The first real response flips the flag and restores the residual-only pass. Because the placeholder is `dataSource.rows` **by reference**, its L1 pass resolves to the sync path's own cache slot — same normalized array, no second clone.

Both branches pass `includeWidgetRank = shouldApplyWidgetRankAtL3(widget)`.

**The three row baselines and their paired filter sets.** Each baseline is exposed alongside the resolved filter set that produced it, derived from the _same_ deferred snapshot. This pairing is load-bearing: during a `useDeferredValue` window, re-deriving the scoped set from the live filter array pairs stale L3 rows with a freshly-resolved filter list, so L4's semi-join renders the intersection of two filter states — a transient flash toward empty.

| Rows                       | Filter set                    | Contents                                                          |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `filteredRows`             | `resolvedFiltersAll`          | page + widget + dashboard-date-range + cross-filter + interactive |
| `filteredRowsNoCross`      | `resolvedFiltersNoCross`      | page + widget + dashboard-date-range                              |
| `filteredRowsNoChartCross` | `resolvedFiltersNoChartCross` | the above + interactive, no chart-click cross-filters             |

`filteredRowsNoCross` is reference-identical to `filteredRows` when nothing incoming is active, so downstream memos short-circuit.

Plus:

- `hasCrossFilters` / `hasChartCrossFilters` / `shouldShowGhost` — a ghost renders only for `crossFilterMode === 'cross-highlight'` **and** an actual chart-click cross-filter. Interactive selections never trigger a ghost.
- `effectiveRows` — the primary dataset: `filteredRowsNoChartCross` in `crossFilterMode === 'none'`, `filteredRows` otherwise.
- `widgetScopedRankFilters` — the widget's own widget-scoped rank filters from the same deferred snapshot, for the chart's post-aggregation re-application.
- `isLoading`/`isError`/`errorMessage` (adapter fetch state) and a `useDeferredValue`-driven `isRecomputing` for sync-path filter changes, used for a non-blocking loading overlay.

**The `'none'`-mode baseline rule.** A `'none'`-mode widget deliberately ignores **only chart-click cross-filters**. Interactive (filter-widget) selections are _always_ hard filters — BI convention — while chart-click cross-filters drive a dim/highlight overlay. So a `'none'`-mode baseline is `filteredRowsNoChartCross`, never `filteredRowsNoCross` (which also strips interactive selections and conflates the cross-filter-suppression mode with an unrelated, always-applicable filter mechanism). This rule must be applied consistently at three levels or it re-breaks:

1. `useWidgetRows.effectiveRows` (above) and the non-React `StudioPipeline`'s equivalent `'none'` branch, which coerces `include` to `'no-chart-cross'`.
2. The widget's own baseline choice — `StudioGridWidget` resolves the same precedence (`globalCrossFilterMode ?? config.crossFilterMode ?? 'cross-highlight'`) and uses `filteredRowsNoChartCross`.
3. **The rows/filters pairing handed to L4.** `useChartWidgetData` derives `effectiveResolvedFilters` = `resolvedFiltersNoChartCross` in `'none'` mode and `resolvedFiltersAll` otherwise. Pairing `'none'`-mode rows with `resolvedFiltersNoCross` is a mismatch (the rows include interactive filters; the filter set excluded them) that makes L4's anchor-scoped re-application use the wrong set and resurrect rows an interactive filter excluded — the general-case bug the `widgetFilters` threading closed, creeping back in through one bad pairing.

`resolvedFiltersNoChartCross` is likewise the correct ghost/"filtered of total" baseline, keeping interactive hard filters applied in the ghost totals.

**Cross-source display columns** (grid columns or map fields referencing a directly related source) go through `enrichWithCrossSourceFields`/`enrichWithCrossSourceColumns` (`crossSourceEnrichment.ts`), applied after filtering via the `enrichIfNeeded` callback — a reference-preserving no-op when the widget has no cross-source columns. `enrichIfNeeded` threads the `relevantSourceIds`-scoped `expressionFields` through, and that is the **one shared fix point** every cross-source-column widget kind routes through for a related-source _calculated_ column. Grid and map both feed their field refs into this single call; the grid's former widget-local supplemental L2 pass was removed once the shared path covered it.

**One traversal helper answers "which source is one hop away, and on which fields?"** — `buildRelatedSourceJoinIndex` (`dataSourceGraph.ts`), shared by `crossSourceEnrichment`, `gridGrouping`'s group-by aggregates, `StudioGridWidget`'s fan-out-safe aggregation and `StudioMapWidget`'s region dedup. It matches **any non-many-to-many relationship with the widget's source at either end**, and returns both join fields already oriented from the widget's point of view, so no caller has to know which side the schema author declared first. Its predicate deliberately equals `enrichRowsWithRelatedFields`'s. Under its former name (`buildManyToOneRelationshipIndex`, kept as a compatibility alias) it matched only `type === 'many-to-one' && sourceId === widgetSourceId`, so a one-to-one or reverse-declared column silently rendered empty on every row while a chart on the identical field and relationship (`chartSupport.findDirectFieldOwner`) and the adapter path (`createBatchingAdapter.resolveField`) both resolved it — the same field populated or blank depending only on widget kind and data-source mode. The widened predicate also admits the one-to-many direction; there the first-write-wins lookup yields one representative related value per row, which is precisely the display-column semantics `enrichRowsWithRelatedFields` already documents.

**Two chart-specific hooks sit on top.** `internals/useChartRows.ts` encapsulates L4 by wrapping `resolveChartRowsForAggregation` with store subscriptions. `StudioChartWidget/useBlendedSeriesRows.ts` independently fetches each foreign-source series of a mixed chart against its own source — a blended series has no single grain to re-anchor to. Rather than hand-rolling filter matching, each foreign source's filters resolve through `selectFiltersForWidget` (called with a synthetic widgetId so no real widget-scoped filter can match, and `include: 'no-cross'`), then narrowed to filters whose field either exists physically on that foreign source **with a matching or absent `filterSourceId`**, or names one of its own non-measure expression fields. All three halves of that gate matter:

- A foreign series aggregates independently with no cross-source join, so a filter naming a field that lives only elsewhere must stay unconstrained rather than be evaluated against `undefined` and drop every row.
- Two sources can share a field name by coincidence (`status`, `date`, `total`), so mere existence is not enough — a page filter authored against one source (carrying an explicit `filterSourceId`) must not be matched by name collision and applied to a different source's column. The expression branch already implies ownership via `ef.sourceId === sid`.
- A filter on the foreign source's own calculated column _is_ evaluable (those fields are enriched into the very rows the series aggregates) and previously fell through a native-fields-only gate, silently exempting the foreign series from a filter the primary series honoured.

Routing through the shared authority (rather than a hand-rolled scope-kind match) also stops another page's filter leaking in and resolves a `dashboard-date-range` preset instead of leaving it `value: null` and silently skipped. The hook subscribes to each foreign source's expression fields and threads them through L2 on both paths (the adapter path both widens the descriptor's SELECT and re-enriches the returned rows). A failed refetch **clears** (rather than retains) that source's cached async rows, and the fetch effect prunes any `asyncForeignRows` entry whose source is no longer adapter-backed — the async merge applies after the sync path, so a lingering entry would permanently shadow freshly-resolved in-memory rows.

### The recurring caching design

Every cache in `internals/` uses **per-entry dependency tracking instead of blanket invalidation** — an entry stays valid unless the _specific_ upstream references it depends on changed (its own rows, the specific expression-field objects it evaluated, the specific foreign sources it joined against, the filter fingerprint). An unrelated edit elsewhere never forces recomputation. New caching code follows this pattern.

**Bounding is a second, separate concern.** `internals/rowCacheLru.ts` is the shared insertion-order LRU behind `normalizedRowsCache`, `enrichedRowsCache`, `resolvedRowsCache`, and `computedCache`. All four have the same `WeakMap<Row[], Map<innerKey, entry>>` shape: the outer WeakMap key is a rows array, so entries are GC'd when a source's rows are replaced — but that bounds **nothing** about the inner map, whose key is derived from widget config and churns freely while the rows array stays alive (adding grid columns one at a time mints a `fieldSetKey` per column; interactive/cross-filter churn mints a fingerprint per click). Each retained entry pins a full result array, so an unbounded inner map retains one clone of a 200k-row source per historical key.

A `Map` iterates in insertion order, so `keys().next().value` is the oldest key — a free LRU as long as every read re-inserts (`getLruEntry`) and every write deletes before inserting (`setLruEntry`). The row caches share `MAX_ENTRIES_PER_ROWS = 20`; `computedCache` uses a deliberately looser `MAX_COMPUTED_ENTRIES_PER_ROWS = 64`, because one rows array is shared by every widget with the same source and filters (that sharing is what `resolvedRowsCache` exists for) and each widget contributes several keys — capping at the row caches' number would evict entries still on screen, which is thrash, not bounding. Its entries are also orders of magnitude smaller (aggregated results, not row clones). `computedCache` boxes its values so a genuinely-cached `undefined` is distinguishable from a miss.

Foreign-source dependencies are tracked as a `SourceDep` (**rows _and_ fields** references), because the join reads the foreign source through `getCachedNormalizedDataSource`, which is keyed on both.

### The non-React pipeline façade (`internals/StudioPipeline.ts`)

`createStudioPipeline(state)` builds a pure-TypeScript object (`resolveWidgetRows`, `resolveChartRows`, `getEnrichedRows`) closing over a snapshot of `{ dataSources, relationships, expressionFields, filters }` plus the dashboard cross-filter settings, delegating to the exact same cached functions the hooks use. It accepts either a bare `StudioPipelineState` or a full `StudioState` (detected via `'doc' in state`). It exists for callers outside a render cycle: CSV export, `benchmarks/`, and pipeline unit tests.

`resolveWidgetRows` takes the `StudioWidget` object as its first argument so `shouldApplyWidgetRankAtL3` applies automatically — a new caller gets correct behaviour without knowing the rule exists. `options.includeWidgetRank` overrides it; the only legitimate reason to pass it is a caller reproducing a _different_ pipeline stage that must mirror another call's flag verbatim. Passing it to "make the numbers match the chart" is always wrong — the helper already does that. `resolveChartRows`' trailing `extraFields`/`widgetFilters` default to the underlying function's own defaults, so an existing caller keeps prior behaviour until it opts in.

**`options` is the per-widget override channel only — it does not gate the dashboard settings.** The snapshot's `crossFilterAllPages` and `globalCrossFilterMode` are honoured unconditionally, with the effective mode resolving as `globalCrossFilterMode ?? options?.widgetCrossFilterMode ?? 'cross-highlight'` (the same precedence `useWidgetRows` / `StudioGridWidget` / `applyCrossFilter` use) and `'none'` coercing `include` to `'no-chart-cross'`. This used to be gated behind "did the caller pass `options`?", which made the corrected behaviour opt-in and left the wrong branch as the default every new caller inherits. The remaining hazard is the flat `StudioPipelineState` input: it can only honour what the snapshot carries, so a hand-built state that omits the two fields still reads as "both unset" — prefer passing the full `StudioState`, and see `generateInsight`'s `toPipelineState` / `richContext`'s `buildFieldStats` for the flat-shape builders that forward them explicitly.

## Widget system

Seven built-in kinds live under `src/components/widgets/`: Chart, Grid, Kpi, Map, Pivot, Text, Filter.

### The widget-kind registry (`internals/widgetRegistry.ts` + `builtinWidgetDefs.ts`)

The registry **types** live in `widgetRegistry.ts`: `StudioWidgetRenderProps` (the normalized prop bag every kind's render wrapper receives), `StudioWidgetCapabilities` (`export`, `expand`, `widgetFilters`, `minHeight`, `contentSx`, `skeletonHeight`), and `StudioWidgetDef` (extending the consumer-facing `StudioCustomWidgetDef` shape).

The **values** live in `builtinWidgetDefs.ts`: `BUILTIN_WIDGET_DEFS` is declared `satisfies Record<BuiltinStudioWidgetKind, StudioWidgetDef>`, so omitting a kind after adding one to `StudioWidgetKind` is a compile error. `useWidgetDefMap()` merges it with consumer-registered `customWidgets` (custom wins on collision) into one `ReadonlyMap` — the single lookup every dispatch site uses (widget card, compose drawer, edit dialog, preview). Built-in and custom kinds are otherwise indistinguishable to callers.

**The two files are split deliberately.** `builtinWidgetDefs.ts` needs direct component references to every widget and setup panel, and those modules import hooks back from the UI-config context — importing the concrete defs into the context/registry-types file would create a real module cycle (in a couple of cases a literal self-cycle, e.g. `ChartSetupPanel` → context → `ChartSetupPanel`). So the concrete wiring lives in a file that depends on the context and is never depended on by it.

### `StudioChartWidget`

`StudioChartWidget.tsx` is the orchestrator: the data hook, the cross-filter selection/hover state machine (click toggling, `getSelectedDataIndices`, stale-hover reset on chart-shape change), the unconfigured/error/no-data guard chain, anomaly reference lines, and registry dispatch. It renders no series or axes inline.

Its **no-data guard tests the mode-appropriate baseline** (`effectiveRows`, or `filteredRowsNoChartCross` under an active ghost), not the `include: 'all'` `filteredRows` — a `'none'`-mode chart deliberately ignores cross-filters, so its data-presence check must too, or a sibling cross-filter matching zero rows blanks it to the empty state.

**Dispatch is a registry, not an if-chain.** `chartTypeDefs.tsx`'s `CHART_TYPE_DEFS` (`satisfies Record<StudioChartType, ChartTypeDef>`, exhaustive the same way `BUILTIN_WIDGET_DEFS` and `chartTypeRegistry` are) maps each of the sixteen literals to a def describing its guard-order behaviour — `needsXField`/`runsSupportGuard`/`runsNoDataGuard`, where `gauge` skips all three and handles its own unconfigured state, and `gantt` skips only the shared xField guard, having its own label/start/end guard — plus a `render(ctx)` method. Unrecognized/legacy types fall back to `bar`.

Two typing details are load-bearing. `render` is declared as a **method, not an arrow property**, so its `ctx` parameter is checked bivariantly, letting a family-narrow renderer satisfy the union-typed `Record`. And `ChartRenderContext<T>`'s `config` narrows to `StudioSharedWidgetConfig & StudioChartConfigOfType<T>`, so each `render*` reads only its own family's keys with no per-renderer cast. The single documented cast at the dispatch call site narrows the dynamically-indexed lookup — a contained TS correlated-union inference gap, not a soundness hole, since the resolved `chartType` and `renderContext.config.chartType` are the same value.

**Presentational renderers.** Each chart type has its own component (`StudioBarChart`, `StudioLineAreaChart`, `StudioPieChart`, `StudioMixedChart`, `StudioScatterChart`, `StudioHeatmapChart`, `StudioFunnelChart`, `StudioGanttChart`, `StudioSankeyChart`, `StudioGaugeChart`) — a plain function component (not `React.memo`) with a local props interface and **no Studio context or store access**. The orchestrator computes every cross-cutting concern once (cross-filter selection, hover state, ghost basis data, series colors) and passes it down; a renderer computes only what is specific to its own type.

**The three ghost mechanisms are deliberately not unified.** Pie uses `PieCrossHighlightContext`; line/area bakes the alpha directly into `series.color` (because `@mui/x-charts` resolves `series.color ?? colors[i]`, so the color itself must carry the alpha — via the shared `withAlpha()` `color-mix()` helper, never hex-string concatenation, which silently breaks on `rgb()`/`hsl()`/CSS-variable palettes); bar uses a slot-based `CrossFilterGhostBar` overlay, because bars encode value as geometry and a faded fill would misread. Each is shaped by what its underlying `@mui/x-charts` component actually needs.

**Ghost-rendering invariants** — the recurring bug class here is a guard that consults the _filtered_ data when the _baseline_ is what actually renders:

- Every ghost path gates on `preserveXFieldBaseline`, and none of them requires the filtered data to be non-empty. A cross-filter that empties every row must render the dimmed ghost of the prior data, not the empty-state placeholder — `renderBar`/`renderPieDonut`/`renderLineArea` each compute `hasGhostData` (`shouldShowGhost && allChartData && preserveXFieldBaseline`) and bypass the empty bail, and every branch that dereferences the filtered aggregation null-guards it first.
- Index alignment is computed against **whichever label basis actually renders** (via `alignFilteredToAllLabels`), not hardcoded to the baseline labels — the two sets differ in order/membership when `preserveXFieldBaseline` is false.
- Branch-entry checks key on the ghost-aware effective data, not the filtered data. Gating the split-by branch on an emptied `barSeriesFieldData` fell through to the single-series path, collapsing per-series structure (colors, legend, identity) into one unsplit ghost bar.
- `CrossFilterGhostBar` anchors its foreground fill at each segment's axis-adjacent edge (bottom for an upward bar, top for a downward one, mirrored left/right when horizontal) and treats any _defined_ filtered value — including `0` or a negative — as present, so a signed measure neither hides the foreground nor fills from the wrong end.

**Multi-Y reachability.** `useChartWidgetData` returns a `null` single-series `chartData` whenever more than one y-field is active, so each renderer's multi-Y branch must be reachable independently of the shared "empty chartData" guard — `renderBar` and `renderLineArea` compute `hasMultiY` and check it first. (`hasMultiY` true always implies `allChartData` is null, so `hasGhostData` is never spuriously true in that branch; both guards are alive and load-bearing.)

**Forecast confidence bands stack; they do not overlay.** Both band series share `stack: 'confidence'`, and `@mui/x-charts` stacks via d3-stack with `offset: 'none'`, which **sums** the two series at each point. Two consequences:

- `computeWidgetForecast`'s `lowerBand` carries the absolute lower bound (floor-clamped at 0 unless the historical series went negative) while `upperBand` carries the band's **width** above it, not the absolute upper bound — `lower + upper` reconstructs `forecast + stdError` at the rendered top edge. Their connection point at the last historical index carries width/value 0 so the stacked top lands exactly on that point.
- Both declare `stackOrder: 'none'` with `__forecast_lower__` listed first. `'ascending'` picks the stack base by comparing series sums, so whenever the forecast signal exceeds its noise band (the common real-data case) it flipped which series stacked first, collapsing the band to a strip hugging the x-axis.

**Other renderer-level rules worth preserving:**

- A rendered series' config is matched to its aggregated entry by **`fieldId`, never array index** — mixed/blended charts drop `ySeries` entries with no `fieldId` yet (an incomplete row mid-configuration), shifting every subsequent index.
- Category colors are keyed by **category identity, not series index** (scatter's `buildScatterCategoryColorMap`, the pie's stable union of split-by categories across all rings, computed after "Other"-grouping is applied identically to every ring). Baseline and filtered series lists differ in length and order, so a positional lookup gives a category's ghost a different hue than its highlighted series. Ghost series carry no `label`, so the legend shows each category once.
- Independent per-series Y-axes bind through the real `series.yAxisId` prop (`y-${i}`), the same name in bar, line/area, and mixed.
- Anomaly/annotation reference lines are modelled relative to the chart's **default (vertical) orientation** — `axis: 'y'` is a numeric threshold, `axis: 'x'` a category marker. `barLayout: 'horizontal'` swaps which physical axis carries the measure, so the annotation builder swaps the physical `x`/`y` props accordingly. Anomaly annotations are identified via `anomalyDetection.ts`'s `isAnomalyAnnotation()`/id-prefix constants, the single source of truth for that sentinel format.
- Localized labels are resolved through `useStudioLocaleText()`, not hardcoded English: the Top-N "Other" bucket (the merge-with-existing-category check and the axis-click cross-filter guard key on the _same_ localized label), the "(blank)"/"(empty)" bucket (`emptyBucketLabel`), and the ghost "filtered out" label. `useChartWidgetData` threads `localeText` through every aggregation call **and its cache keys**.

A few narrow display-only asymmetries are deliberately preserved ("preserve, don't harmonize"): the multi-Y line/area cross-filter `highlightedItem` targets a bare `fieldId` that can never match the rendered `${fieldId}-${index}` series id, so that highlight is a no-op; and the single-series area chart never gets line's "filtered / total" tooltip formatter. Neither affects data correctness.

**Supporting modules**: `useChartWidgetData.ts` (data-fetch/aggregation orchestration), `lineSeries.ts` (`buildMultiYLineSeries`, resolving each series' field def through the shared `resolveFieldDef()` so a computed y-field formats the same whether or not a ghost is active), `chartWidgetHelpers.ts` (value formatters, `crossFilterValueEquals`/`normalizeCrossFilterValue`, `densifyBarLabels`, `alignFilteredToAllLabels`, `resolveFieldDef` — the single field-lookup resolving a chart field's `StudioDataField` across the widget's own source and any blended/foreign sources, `isBarStacked`/`isAreaStacked`, and `computeStackTotals`/`formatPercentValue`/`formatPercentAxis` for 100%-stacked normalization), and the three cross-filter/selection contexts.

#### Chart config retention across type switch

Switching a chart's type (bar → gauge → bar) **keeps** the config keys the prior type used, so `xField`/`ySeries` survive the round-trip. This is a deliberate UX feature, not a bug, and two mechanisms respect it: `updateWidgetConfig` validates only the incoming patch, never the stored config; and each setup-panel section reads only its own family's keys, leaving the others untouched. Anything that replays the full stored config through a validating write path strips exactly those retained keys — see [`commitChartConfigWithSource`](#compose-drawer--setup-panels).

### Other built-in widgets

Compressed to the decisions that generalize; each widget's own module comments carry the rest.

**`StudioGridWidget`** — data table over DataGridPremium.

- **Sorting is mode-dependent, and that split is the point.** `sortModel` must be controlled in both directions: `initialState.sorting` is read once at mount (so a config-only sort edit had no effect until remount), while a controlled model with no `onSortModelChange` makes DataGridPremium ignore header clicks entirely (headers look clickable and do nothing). Where the resulting sort is _stored_ then depends on mode:
  - **Edit** — commit into `gridSortField`/`gridSortDirection`, the same keys `GridSetupPanel` writes, with `{ undoable: false }`. One logical sort gesture is DataGridPremium's asc→desc→none cycle, i.e. three `onSortModelChange` calls that would otherwise bury the author's previous real edit under three no-op undo steps and discard the redo stack each click.
  - **View** — keep it in component state. `doc` is the authored, persisted, undoable partition and a read-only viewer must not rewrite it. `viewSortModel === null` means "no viewer sort yet — follow the authored config", so a dashboard shipping with `gridSortField` opens sorted; switching modes drops the viewer sort rather than resurrecting a stale one.
- Column order follows the user-configured `config.columns` (`computeOrderedFieldIds` puts configured fields first in stored order, then remaining source fields), so a setup-panel reorder affects rendering, not just visibility.
- Cross-source columns resolve via `resolveCrossSourceFieldDefs` (physical field, then that source's non-measure expression fields normalized to a `StudioDataField` shape) and `buildGridColumnDefs`' `field ?? expressionField ?? crossSourceField` chain, marking cross-source columns non-editable. Row-level _values_ come from the shared `useWidgetRows`/`enrichIfNeeded` pass, not a grid-local one.
- Bare-field-id collisions are guarded in both directions: enrichment writes only when `!(fieldId in row)`, and `computeOrderedFieldIds` de-dupes so two `GridColDef`s never share a `field`.
- The footer summary resolves fields against the same merged def list (own physical + own expression + cross-source), and FK-dedupes a fanned-out cross-source summary field before reducing so it agrees with the grouped view rather than double-counting.
- Custom fan-out-safe `min`/`max` are registered for **number columns only** — the shared reducer coerces dates to `null`, so claiming `date`/`dateTime` produced a blank cell.
- Cross-highlighted rows are matched **by object reference** (a `Set` of row objects), not `row.id`, so highlighting works for sources whose rows have no stable id. `getRowId`'s synthetic fallback spreads `row` first and sets the id key last, so a nullish own `id` doesn't overwrite the fallback and collide every such row.
- `evalConditionalFormat` excludes `null`/`undefined`/`''` from numeric comparisons (`Number(null)` is `0`, so "less than 5" would match empty cells); only `is_empty` matches blanks.
- The group-header-row guard is not bypassable from a leaf row's grouping-column cell — DataGridPremium renders that internal column for leaf rows too, and clicking one emitted a cross-filter on the field id `'__row_group_by_columns_group__'`, a pair no other widget's filters can match.
- CSV export mirrors the on-screen resolution end to end (same enrichment, same field defs), so an exported cross-source column carries the same header label and formatting as the rendered one.

**`StudioKpiWidget`** — single-metric card (`kpiUtils.ts` for aggregate + trend, `KpiSparkline`/`KpiTrend`/`KpiValue` for rendering). It is the densest non-chart widget because it runs L4 four times (headline anchoring, trend anchoring, the sparkline's cross-source time join, the fixed-period trend's date join) and each site must agree with the others _and_ with an identically-configured chart on the same page.

- **Cross-source direction.** Its value field may be owned by a directly-related **"many" (child)** source (a KPI on `customers` using `orders.total`); `analyzeChartSupport`'s single-y-field branch anchors only this direction. The reverse fan-in reports `mixed_cross_source_fields` and is never anchored.
- **All four `resolveChartRowsForAggregation` sites thread the same resolved `widgetFilters`** (so an anchor-scoped filter is re-applied at L4, not just semi-joined at L3) — and they thread the _same value_, `kpiScopedFilters`, rather than four independent `selectFiltersForWidget` calls. The scoping inputs those calls each had to carry separately (`crossFilterAllPages`, `includeWidgetRank` via `shouldApplyWidgetRankAtL3`) are now applied once, upstream. Every omission produced the same class of bug — resurrected anchor rows, an out-of-scope cross-page cross-filter, or a previous period compared unranked against a ranked current period.
- **The expression-field subscription uses the full `relevantSourceIds` set** (own + one-hop + junction). An own-source-only list left an anchor/junction-owned _expression_ field invisible, which broke `effectiveFilterSourceId`'s classification for that one shape: the filter was neither re-applied at L4 (resurrecting rows) nor evaluable once classified (dropping every anchor row, reading the KPI as `0`).
- **Date-range derivation is deliberately conservative.** `extractDateRange` treats a single-sided filter symmetrically (`less_than*` "until X" mirrors `greater_than*` "since X"), reads `equals` as a single calendar day, and returns `null` for `not_equals`/`is_empty` — those describe no contiguous window, and a bogus open-ended range is worse than none. `findDateFilter` breaks a tie among several in-scope date filters by **scope specificity** (widget > page > dashboard-date-range), not array order.
- **The fixed-period trend re-derives its own baseline.** A rolling N-day window from today is computed from raw `dataSource.rows` with every non-date filter re-applied, not from `currentRows` — which already has the active date-range filter applied, so windowing it again double-restricted and collapsed the previous period to 0 rows (a bogus infinity/"New" badge). Adapter-backed sources have no reliable unfiltered client-side baseline and fall back to `currentRows`. Separately, "previous calendar period" uses its own `comparisonGranularity`, not the sparkline's `autoGranularity` — reusing the latter made a ~15–90 day range overlap its own previous period.
- **UTC vs. local is a deliberate, narrow split.** `getBucketKey` reads UTC components while `toDayKey`/`filterRowsByDateRange` read local ones, because they normalize different input shapes: an instant already known to be UTC midnight (from parsing a bare `'YYYY-MM-DD'`) vs. an arbitrary instant that must reduce to the viewer's calendar day. Window boundaries serialize via `toLocalYmd`, never `toISOString().slice(0,10)`, since `computePreviousPeriodRange` computes them in local time.
- **"Null means not measured, not zero" holds all the way to the badge and the sparkline.** `computePeriodValue` propagates the `null` `aggregateNumbers` returns for an `avg`/`min`/`max` over an unmeasurable period (and the `null` a measure's root-level divide-by-zero yields) instead of coercing it to `0`; both trend branches then suppress the badge. Coercing it produced a confident red **−100%** whenever an `avg` KPI's current fixed-period window happened to be empty — and only the fixed-period branch was exposed, since it windows independently of the `hasData`-gated headline. `computeSparklineData` follows the same rule: a bucket that has rows but yields `null` becomes a gap, not a plotted zero. `sum`/`count` are unaffected — `0` over no rows is a real total.
- **A measure expression value field aggregates via `evaluateMeasure` for headline, trend AND sparkline.** A measure's value doesn't exist per row, so `computeAggregate`/`computeSparklineData` reading `row[measureId]` produced a correct headline beside a flat-zero sparkline. Every cache key depending on a measure folds in a `stableStringify` of its `expression` AST, not just its id — measures are excluded from row-identity invalidation, so the AST fingerprint is the only thing that busts the cache when a formula is edited.
- **One date field per card.** `resolveKpiDateField` (`kpiUtils.ts`, exported) is the single answer to "which date field does this KPI use?", consumed by the sparkline, the fixed-period trend, and the compose drawer's `KpiSparklineOptions` alike. The rule is **in-scope date filter → explicit `kpiSparklineField` → first own-source date column**, and it reports the field's owning `sourceId`, an `isNative` flag, and the `origin` tier. Filter-beats-config matches the only affordance the UI offers (the panel replaces the time-field picker with "Using the date filter on X" the moment one is in scope); the own-source fallback exists because the trend section of the panel has no date picker of its own. The sparkline is the one consumer that declines the last tier (`origin === 'source-default'` → the "pick a time field" hint), so it never draws a chart the panel's empty picker says is unconfigured. Three independent rules used to live here: a cross-source date filter resolved to _no sparkline at all_ while the panel announced it was in use, and a page filter on a second date column bucketed the sparkline on one column while the trend windowed on another.
- **Every filter read goes through the SAME resolved set**, not merely the same helper. `kpiScopedFilters` is `useWidgetRows`' exposed `resolvedFiltersAll`/`resolvedFiltersNoCross` (deferred snapshot, matching the rendered rows) plus its exposed `widgetScopedRankFilters` — the latter because `useWidgetRows` builds those two sets _without_ `includeWidgetRank`, so a KPI's own Top-N filter is absent from them even though the paired rows were produced with it. Headline anchoring, sparkline, trend and hover filter-subtitle all consume that one value. Re-deriving from the live `selectFilters` array — which each site used to do — paired stale L3 rows with a newer filter list: the L4 semi-join rendered the intersection of two filter states and the trend compared a new-filter previous value against an old-filter current one.

**`StudioMapWidget`** — choropleth (`geographyLoaders.ts`, `countryUtils.ts`, `StudioMapShapePlot`, `StudioMapTooltipContent`).

- Each geography load is tagged with a monotonic request id, so a fast toggle can't apply a stale topology under the wrong projection. A rejected loader sets a retryable error state whose Retry re-triggers via a nonce dependency — the geography id alone can't re-arm a single-geography widget.
- Clicking a region that merges several raw variants (`'US'`/`'USA'`/`'United States'`) emits an `in` cross-filter over **every** raw variant feeding it, so downstream widgets filter to exactly what the region visually aggregates.
- `MapSetupPanel` deliberately offers value fields from related sources — every source `getReachableSourceIds` reaches, i.e. both directions and every relationship type, which is why the shared traversal helper must resolve that same set — so `regionData` FK-dedupes them (`buildRelatedSourceJoinIndex` + a per-region `Set` of normalized FK keys) — the map analogue of the grid's `symmetricAggregate`. A same-source field or unresolvable FK falls back to a plain per-row reduce, already correct there.
- Field-def resolution checks own source → own expression fields → the named source's fields/expression fields, matching the row pipeline's priority, and falls back to `inferExpressionType` for a typeless numeric expression field (`StudioExpressionField.type` is optional, so `revenue - cost` lost its currency format under a `type === 'number'` gate). The color scale handles all-negative and degenerate ranges without inverting.

**`StudioPivotWidget`** — `pivotUtils.buildPivotMatrix` computes the cross-tab; `PivotTable.tsx` renders it.

- A row/column category is **membership**, independent of whether its measure is usable, so `matrix.cells.get(rowValue)` always returns a (possibly empty) `Map` for any row that occurred, and each cell/total tracks a `rowCount` separately from its accumulator so `'count'` reads `COUNT(*)`.
- Category ordering uses a **total and transitive** comparator via a numerics-first partition (numbers sort numerically and all before non-numeric values, which sort lexicographically). A per-pair numeric-or-lexicographic branch is non-transitive on mixed input, and whitespace-only labels coerced to `0` and collided with a real `"0"`.
- CSV export and the on-screen table round through the same `roundPivotValue` and share the localized totals caption; the export-trigger ref nulls on cleanup, not only on set, so an export scheduled during unmount can't call into a gone instance.

**`StudioTextWidget`** — markdown block with AI-assisted generation (`useTextWidgetAI.ts`).

- It has its **own** `privateMode` gate, separate from the chat adapter's: `dashboardState` and `pageSnapshot` are each computed only when `aiConfig?.privateMode !== true`.
- It snapshots against its **own** `pageId` (threaded from `builtinWidgetDefs`), not `activePageId` — reading the active page meant every text widget on every page reacted to the same page-switch event, snapshotting the wrong page and firing a redundant LLM call each.
- Its snapshot memo subscribes to widgets/dataSources/**filters**/expressionFields/relationships as well as page/dashboard, since the memo body reads all of them via `getState()` and none changes page identity on its own. An added page filter otherwise left the narrative describing unfiltered numbers, and Refresh re-sent the same stale memoized snapshot.
- Its request declares `allowedTools: ['query_data_source', 'summarise_page']` — there is no chat UI here for a human to review an approval prompt — and its SSE handler auto-approves a `tool-approval-request` **only** when the requested tool is actually in that list. Defense in depth against a drifting server, not an unconditional rubber stamp.

**`StudioFilterWidget`** — on-canvas filter control, per-type implementations under `controls/` (`DateRangeControl`, `MultiSelectControl`, `SliderControl`, `ToggleControl`).

- It takes a `pageId` prop and reads its selection through the **page-scoped** `makeSelectActiveInteractiveFilter(widgetId, pageId)`. An interactive filter's scope is pinned to the page it was authored on, so a page-blind lookup advertises a control as "selected" while its selection applies elsewhere and filters nothing here.
- `DateRangeControl` cancels its pending debounced apply before clearing (else the cleared filter resurrects ~300ms later) and tracks per-field focus so the external-value sync effect doesn't reset a field the user is still typing in.
- The date slider floors bounds to local midnight, matching the `'YYYY-MM-DD'` precision the committed value is persisted at, so handles don't snap after release. `MultiSelectControl`'s Exclude toggle holds its pending intent while the selection is empty — there is no committed filter to re-stamp.

### Custom widgets

Consumers register `StudioCustomWidgetDef[]` (kind, label, `component`, optional `setupPanel`, `requiresDataSource`, `aiInsight`, `defaultConfig`, `fullBleed`, `shouldHide`) via `Studio`'s/`StudioProvider`'s `customWidgets` prop; `useWidgetDefMap()` folds them into the same registry, so dispatch is identical everywhere. `StudioCustomWidgetProps.dataSource.rows` includes L2 enrichment but **not** filters/cross-filters — a custom widget needing those calls `useStudioSelector` itself.

`expand` is a **built-in-only** capability: `StudioCustomWidgetDef` exposes only `export`, and `toWidgetDef` maps a custom entry to `capabilities: { export }`. Both toolbars gate the expand button on `def?.capabilities?.expand === true` — the same condition that decides whether `StudioWidgetExpandDialog` mounts at all.

Per `AGENTS.md`/`CLAUDE.md`, a bespoke chart type belongs in an app-level custom widget composing the public `@mui/x-charts*` APIs — never patched into the shipping `x-charts*` packages.

### Widget chrome (`src/components/StudioWidgetCard/`)

`StudioWidgetCard` wraps every kind with shared chrome — title/subtitle (falling back to a localized kind label when untitled), loading/error/empty states, and the hover action overlay. `StudioWidgetCardActionsOverlay.tsx` renders the per-action buttons (export, expand, insight menu, anomaly toggle/explain, AI refresh) as shared components reused between the edit-mode and view-mode toolbars.

**Error containment is layered, and the outermost layer lives at the canvas call site.** The card's three internal boundaries only cover what they wrap (actions overlay, header, `def.component`). Everything the card computes in its own render body — L2 enrichment for custom kinds, `inferKpiDateSubtitle`, the `def.shouldHide` predicate — sits _above_ them and would escape to the canvas-wide boundary in `StudioContent`, replacing every widget on every page with one error overlay.

`StudioPageRows` therefore wraps each card in a `StudioWidgetErrorBoundary` with `resetKeys={[widget, pageId]}`, identity-compared: the store hands out a new widget object on every doc edit, and the overlay's Retry covers view-only dashboards where neither ever changes. Two consumer callbacks evaluated during **layout resolution** — above every possible boundary — are additionally try/caught in place: `safeShouldHide` (a throw means "don't hide", since a hidden widget cannot be recovered by the user while a spuriously visible one can) and `skeletonHeight` (falls back to a default height).

**Cross-cutting concerns are focused modules, not inlined:**

- `widgetExport.ts`'s `runWidgetExport` owns CSV/PNG dispatch. For an in-memory grid it normalizes raw source rows through the **same L1 pass** the on-screen grid uses before feeding `resolveWidgetRows` (whose contract is raw, pre-normalized rows), so exported dates carry the canonical form. For an adapter-backed grid it rebuilds the descriptor via `buildWidgetQueryDescriptor` so the lookup hits the exact `cacheKey` `useAdapterRows` populated — a hand-picked argument subset produced a different key and made export report "No data available to export yet" while the grid was showing data.
- **PNG export clones before inlining.** `exportChartToPng` clones the live SVG _first_, reads each computed value from the connected live element (`getComputedStyle` only resolves meaningfully for a document-connected node) and writes it onto the **detached clone**. Inlining in place and cloning after permanently baked that snapshot's resolved theme colors into the on-screen chart's own inline styles, surviving later theme changes.
- **The legend is painted separately.** `@mui/x-charts` renders it as HTML (`<ul>`) _outside_ the `<svg>`, so each row's color/text/position is read from the live DOM and drawn onto the export canvas using that row's own `getBoundingClientRect()` — reproducing whatever arrangement is on screen (row/column, above/below/beside) rather than reimplementing the flex layout or rasterizing arbitrary HTML. A custom (non-`ChartsLegend`) legend falls back to exporting the chart alone.
- `useStudioWidgetInsights.ts` owns AI-insight/anomaly state; `useStudioWidgetCardDrag.ts` owns drag wiring, clearing its `document.body` drag flag and inline opacity on unmount or a mid-drag `canDrag` flip as well as on drop, so no global flag leaks.
- **CSV escaping is one shared policy** (`internals/csvUtils.ts`'s `escapeCsvCell`): standard quoting plus formula-injection neutralization (prefixing a `'` before a leading `=`/`+`/`-`/`@`/tab/CR). Whether a cell is "numeric" is decided by its **runtime value, not its declared field type** — a `number` column can hold dirty non-numeric data that must still go through the guard. A genuine runtime number _is_ quoted (`quoteNumericCsvCell`, because `Intl.NumberFormat`'s thousands separator would split the row into an extra column) but exempt from the apostrophe rewrite, which would corrupt a legitimate leading `-`. Download mechanics (`Blob`/`createObjectURL`/anchor, plus filename sanitization preserving the extension) are one shared `downloadCsv` in `internals/widgetUtils.tsx`, used by both the grid and the pivot.

## Canvas / layout

`StudioCanvas` (`src/components/StudioCanvas/StudioCanvas.tsx`) renders the active page's `widgetRows` (`string[][]`, each inner array a row of side-by-side widget ids) as a flex grid. Exported helpers: `getWidgetMinSpan(widget)` (`MIN_SPAN`, or `KPI_NO_SPARKLINE_MIN_SPAN = 4` for a sparkline-less KPI, which needs no room for a chart), `LiveDragState` (the transient state of an in-progress between-widget resize drag), and `computeGridLineLefts` (CSS `left` values for the divider overlay).

The drop handler computes the target page's desired final rows and hands them to `controller.moveWidget`/`insertWidgetAt` — **no column-span cleanup logic lives in the canvas**. For a same-row move it locates the dragged widget's column index before removing it and shifts the insertion index back by one only when the drop target sits after that position; otherwise removing first lands a rightward drag one slot past the intended gap.

**Background-click deselection is decided in two steps, because a DOM check alone is insufficient.** React dispatches events along the **React** tree, not the DOM tree, so a mousedown inside a portal rendered by a canvas descendant (every MUI Menu/Select/Dialog/Popover, the DataGrid column menu and filter panel, the widget edit and expand dialogs) bubbles into the canvas handler even though its node lives under `document.body`, and none of MUI's overlays stop `mousedown`.

A portal node is by construction never a DOM descendant of the canvas root, so one `event.currentTarget.contains(target)` check covers all of them at once while every genuine background click still passes. Non-portalled in-tree chrome (the date-range bar) needs its own explicit exclusion. Without this, choosing an option from any of those menus deselected the widget being configured and closed the AI chat, aborting an in-flight streamed answer.

**Empty-page and remount handling.** The empty-state `Paper` and the populated-state root `Box` are different DOM nodes in mutually exclusive branches of the same persistent, memoized component, so a `[ref]`-only effect never re-runs the first time a page's emptiness flips and keeps referencing a detached node. Two different fixes apply:

- `useStudioDropTarget` takes an explicit `watch` value (`isEmptyPage`) in its dependency array, forcing re-registration on that transition even though `ref` identity never changes.
- The `ResizeObserver` measuring `canvasWidth` for the responsive stack tiers uses a genuine **callback ref** instead, so swapping branches re-attaches automatically.

The empty page also registers its own drop target directly on the `Paper`: `StudioPageRows` (and its `InsertionPoint`/`WidgetGap` affordances) never renders with no rows, so the "drag them here" copy had no drop target behind it. That handler mirrors both of `StudioPageRows`' drop branches but always produces a single fresh row.

Drag-and-drop is `@atlaskit/pragmatic-drag-and-drop` via `useStudioDraggable`/`useStudioDropTarget` (drag types in `studioWidgetDndTypes.ts`), with auto-scroll near the viewport edge; `StudioDragLayer`/`createClonePreview` render the floating preview; `RowResizeHandle` is the draggable divider committing through `setAdjacentWidgetColSpans`. Also in this directory: `StudioDateRangeBar` (whose preset `Select` includes a `'custom'` item whenever `activePreset === 'custom'`, so a host/AI-set custom range renders as a valid selected value rather than blank — selecting it is a deliberate no-op, there being no UI here to edit the bounds), `StudioCrossFilterBar`, and `StudioQuickFilterBar`.

## Filters

`StudioFilterState.scope` (schema package, `stateTypes.ts`) is a discriminated union and the **sole** scope descriptor — there is no separate `widgetId`/`pageId`/`isDashboardDateRange` field to keep in sync:

| `scope.kind`           | Payload                    | Meaning                                                                  |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `page`                 | `pageId?`                  | applies to one page (a legacy `pageId`-less entry applies to every page) |
| `widget`               | `widgetId`                 | applies to one widget                                                    |
| `cross-filter`         | `sourceWidgetId`, `pageId` | a chart/grid/map click; hidden from the drawer; undoable                 |
| `interactive`          | `sourceWidgetId`, `pageId` | a filter-widget/slider selection; always a hard filter                   |
| `dashboard-date-range` | `sourceId`, `pageId`       | the dashboard date-range bar, per source                                 |

`internals/filterScoping.ts`'s `selectFiltersForWidget` is the single scoping authority for every path — sync, adapter, non-React pipeline, KPI trend/sparkline, blended series, AI summaries, and the drawer's own cascading-parent lookup. Anything hand-rolling a `scope.kind === 'page'` match without a `pageId`/`disabled` check is a bug: it leaks another page's filter, ignores the disabled flag, and skips `resolveDateRangePresets`.

**Authoring UI** (`src/components/StudioFiltersDrawer/`): `PageFilterRow`/`WidgetFilterRow` (rows), `FilterValueInput`/`DateValueInput`/`RelativeDateInput`/`SelectionFilterInput`/`RankFilterInput` (per-mode value editors), `CrossFilterSection`/`InteractiveFilterSection` (read-only summaries of live state), `filterDrawerUtils.ts`, `useFieldValues.ts`, and `FilterCard`/`FilterSection`/`FilterBody`/`SecondCondition`/`FilterModeToggle`.

- `InteractiveFilterSection`'s clear routes through `controller.clearInteractiveFilter` — the same non-undoable path the originating widget's own pill uses — so a Ctrl+Z elsewhere can't resurrect a filter the user just cleared.
- **`isFilterEffective` requires `!filter.disabled`.** A filter toggled off still carries its value, so without this a disabled parent kept narrowing a cascading child's option list, contradicting every data path's own guard. Cascading (`dependsOn`) parent narrowing is gated on it both in `PageFilterRow` and, defense-in-depth, inline in `useFieldValues`'s `applyParentFilters`.
- **`useFieldValues(fieldId, filterSourceId?, parentFilters?)`** collects distinct values for **every** field type (selection mode is offered for any field, and `in`/`not_in` compare `String(row[field] ?? '')`, so a numeric or boolean field yields a usable list). `filterSourceId` scopes the lookup to one source — a bare field-id scan pollutes the list when two sources share an id — and the record index is guarded with `Object.hasOwn` so a doc-authored id can't resolve a function off `Object.prototype`. The result is capped at `FIELD_VALUES_CAP = 1000`; hitting the cap signals the caller to show a "type to narrow" hint rather than render tens of thousands of unvirtualized checkbox rows.
- **`filterOperatorMetadata.ts`** is the single source of truth for which operators are valid per field type and their display labels, shared by the drawer and the widget edit dialog, and routed through `localeText` rather than hardcoding English (as is `summarizeFilter`, the plain-language chip summary). `getOperatorLabel` resolves the requested type's table first and then falls back to the first other table defining that operator, so an operator legitimately stored on a type whose table omits it (a host/AI-authored filter, or a field that changed type underneath) shows a translated word rather than the raw enum identifier leaking into card summaries and pickers. The raw identifier remains the last resort, for selection-only operators no table offers.
- **Unresolved fields are surfaced, not silently applied.** `resolveFilterField` distinguishes `'unresolved'` (the stored field names no real column) from `'unknown'` (a data-load race). `UnresolvedFieldAlert` renders only for the former, with an action that clears the field and drops the row back to its picker. A filter on a missing field is not inert — the engine reads `undefined` for every row, so the widget renders empty while the filter row itself looks normal, and this banner is the only thing distinguishing "the filter excluded everything" from "there is no data".
- **`between` has a two-shape value** (`{ from, to }`, not a scalar), so both `FilterValueInput` and the edit dialog's `FilterRow` give it a dedicated two-input editor (a number pair, or the date picker rendered twice) instead of the generic single-value `TextField`, which would stringify the object to `[object Object]` and clobber it on the first keystroke.
  - Switching an operator across the `between`/scalar boundary **resets the value in both directions** — a stranded value renders `"[object Object]"` while `toComparable` coerces it to `NaN`, silently matching nothing.
  - The reset predicate explicitly excludes `isRelativeDateValue(...)`: a `RelativeDateValue` is also a plain object but is a fully-supported _scalar_ value, so switching between two scalar date operators must not discard it.
  - `SecondCondition` mirrors both safeguards for `operator2`/`value2`, the self-repair effect repairs `operator2` alongside `operator`, and a field switch clears `operator`/`value`/`operator2`/`value2`/`conjunction` together so no stale second condition keeps evaluating with no UI to see it.
- Hidden fields are offered nowhere as selectable options or add-seeds (matching `GridSetupPanel` and the drawer), while a filter already authored on one still resolves its label and stays visible in its row.
- Row handlers commit **only the changed fields** to `controller.updateFilter`, which merges onto the current store filter. Passing a full render-time snapshot let a debounced value commit (whose snapshot came from the keystroke's render) silently revert a concurrent operator/conjunction edit.
- **Self-repair of an invalid stored operator** commits `{ undoable: false }` (see the [undoability policy](#studiocontroller-srcstorestudiocontrollerts)): the row's displayed `activeOperator` already falls back to `operators[0]`, and the effect writes that same fallback back so the engine's applied operator matches what the row shows.
- Widget-filter ids are minted via the shared `createFilterId()`, not `Date.now()` — a double-click otherwise no-ops the second filter through the reducer's duplicate-id idempotency.

**Filter evaluation** lives in `internals/filterUtils.ts` (`applyFilters`, `compileRowTest`, `resolveDateRangePresets`, relative-date resolution). Rules that generalize:

- `resolveDateRangePreset` turns a non-custom preset into concrete bounds at query time **regardless of `scope.kind`**, so dashboard-wide and widget-scoped presets resolve the same way and a stored filter is never a stale absolute date.
- `not_in` compiles to the inverse of `in` — the operator is explicitly consulted, not assumed inclusive.
- Date `equals`/`not_equals` route both sides through the same `toComparable` normalization the comparison operators use, so a relative-date "On" filter or a `datetime` field compared against a date-only picker still matches.
- Numeric comparison and `between` branches guard `rv != null` before comparing, so a null cell is excluded rather than treated as `0` — the same guard the date branches always had.
- `toComparable`'s `date` branch reads the canonical calendar day via the exported `normalizeToDateOnlyString` (`temporalUtils.ts`), not `toISOString().slice(0,10)`. Rows that went through L1 already carry a canonical day string, but a row that bypassed L1 (a foreign row in a cross-filter semi-join, an L4 anchor/remote/junction row) can still carry a raw local-time `Date`, which day-shifts for UTC-positive viewers.
- Cross-filter value comparison (does a clicked point match an existing cross-filter's stored value) is centralized in `chartWidgetHelpers`' `crossFilterValueEquals`/`normalizeCrossFilterValue`, not re-implemented per chart type.
- The quick-filter bar's "Clear all" computes the resulting `filters` array up front (every page filter and every cross-filter for a cleared source widget) and commits it in **one** `updateState` call rather than looping `removeFilter` — one click is one undo entry.

## Persistence & schema migrations

Persistence is a pure state-shape transform, so it lives in the schema package (`packages/x-studio-schema/src/statePersistence.ts`); `x-studio` re-exports `serializeState`/`serializeDoc`/`deserializeState`/`migrateState`/`CURRENT_SCHEMA_VERSION` from `store/index.ts` so consumers still import them from `@mui/x-studio`.

**The persisted JSON is exactly the `doc` partition minus its cross-filter entries.** `session` and `runtime` are reconstructed on load (session defaults; runtime re-injected by the host). `CURRENT_SCHEMA_VERSION` is an integer (currently `1`), carried on `doc.schemaVersion`.

- `serializeDoc(doc)` **spreads** every `StudioDoc` field — so a newly-added doc field is carried automatically, with no hand-picked list to forget — then strips `scope.kind === 'cross-filter'` entries and omits the empties (`expressionFields`/`filterPresets`/`ai`). `serializeState(state)` reads exclusively from `state.doc`, so `session`/`runtime` are excluded by construction.
- `deserializeState(serialized, dataSources, shellOverrides?)` rebuilds `doc` (defaulting omitted empties to `[]`), reconstructs `session` (`mode: 'edit'`, shell from defaults merged with overrides), injects the host's live sources as `runtime`, and runs `normalizeGridColumn` over grid `config.columns`.
- `migrateState(raw)` reads `raw.schemaVersion` (defaulting to `0` for pre-versioned payloads), **refuses to migrate from a newer version than the running code supports**, and applies the `migrations` registry — keyed by the **old** version — sequentially, one version at a time, collecting per-step errors into a `MigrationResult`.

**Migration policy** (restated because it is easy to violate by accident): never add a `fooV2`-shaped parallel field when a type's shape must change. Keep exactly one clean field name in the interfaces, bump `CURRENT_SCHEMA_VERSION`, and add a migration keyed by the previous version that rewrites old persisted shapes into the new one — the running code only ever reads the new shape. Add a fixture-based test in `statePersistence.test.ts` for each migration. Only `doc`-partition changes ever need a migration.

**Session persistence** goes one level further: `StudioController.serializeSession()`/`restoreSession()` capture the present doc _and_ the undo/redo stacks (`SerializedStudioSession` = a `present` snapshot plus `past`/`future`), so a reload resumes with full undo history. Because `mode` lives in the non-undoable `session` partition, every snapshot carries the same mode and `restoreSession` reads it from `present` only — the per-snapshot field is retained purely for on-disk compatibility.

Restoring treats the payload as untrusted: it drops an individual history entry that fails to migrate rather than aborting, truncates both stacks to `MAX_UNDO_HISTORY` (`commitState`'s own trim shifts only one entry per commit, so a tampered/legacy session would stay oversized forever), and validates `present`'s `mode` against the `'view' | 'edit'` union — every mode-gated UI branch trusts it to be one of the two literals.

## AI integration

**`x-studio` is UI-only — no LLM calls happen in this package.** `StudioAIConfig.endpoint` points at an `@mui/x-studio-ai-middleware` HTTP handler, which owns the API key, system prompt, and server-side tool execution. The only appended paths are `/chat` (streaming chat), `/approval` (tool-call approval responses), and `/widget` (natural-language widget creation).

### Chat panel (`src/components/StudioChatPanel/`)

`StudioChatPanel.tsx` orchestrates a UI built on `@mui/x-chat`'s `ChatBox`/`ChatMessage`/`useChat`/`useChatComposer` headless primitives across roughly 18 decomposed files. The concurrency model is the interesting part:

- **`useChatThreads.ts`** owns thread list/switching and a `StreamThreadPin` that pins an in-flight stream's writes to the thread it started on, so switching threads mid-response can't write into the newly-active thread. Every `doc.ai` write-back — including the one firing on each streamed token — commits `{ undoable: false }`; an undoable write here would push a snapshot per delta, hundreds per response, flooding and evicting the user's real undo history even though chat state lives in the persisted `doc` partition.
- **Switching threads mid-stream aborts the previous fetch first** (a `stopStreamRef` mirrors `useChat`'s `stopStreaming` out of the pinned-write component, called before resyncing `ChatBox`'s controlled `messages`), so the partial response already written is cleanly terminated and preserved rather than silently truncated as tokens arrive for a message id no longer in the active thread.
- **Auto-submit is pinned to the thread active at mount.** A stale mount-time `initialPrompt` gated only on "is the current thread empty" re-fired into any later empty thread. `pendingMessage` (from a widget's "AI insight" action) and `initialPrompt` **queue** rather than clobber each other. `AutoSubmitTrigger` defers via a macrotask and re-checks streaming state right before marking the message consumed — the chat hook's internal `isSending` guard clears slightly _after_ `isStreaming` resets, so an auto-submit gated only on `isStreaming` could land in the gap and silently no-op, dropping the message.
- **`insightFocusedWidgetId` has a bounded lifetime.** It reaches the middleware's system prompt as "the user is asking about widget X", so it is cleared when the panel closes, when the active page changes (compared against the previous value so the initial mount doesn't clear a focus set in the same commit), and when the focused widget is deleted. Leaving it set silently re-scoped every later message at whichever widget's Analysis button was pressed hours earlier.
- Retry regenerates in place via `useChat`'s `regenerate(messageId)` rather than appending a duplicate user turn, guarded by a per-message `isRegenerating` flag — a proportionate guard against re-triggering on a response that had already partially applied mutations (full envelope-id dedup is out of scope).
- Streaming a tool call emits a `tool-input-delta` chunk (input as text, for the live-typing effect) followed by `tool-input-available` carrying the parsed object — the delta alone never populates `toolInvocation.input` in `@mui/x-chat`'s stream processor, so without the second chunk the card shows a name and status but never its arguments. `STUDIO_TOOL_ICONS`/`STUDIO_TOOL_LABEL_KEYS` map tool names to icons and `StudioLocaleText` keys, not hardcoded English.

### Transport (`studioBackendAdapter.ts`, `sseUtils.ts`)

`createBackendChatAdapter` serializes skills (stripping non-JSON `execute` functions), POSTs a `StudioAIRequest` to `${endpoint}/chat`, parses the SSE stream, feeds text deltas into the UI, and applies `state-mutation` events to the local controller.

- **`serializeDashboardState` (shared with `useTextWidgetAI`) strips `runtime.dataSources` adapter/row payloads** (too large, not JSON-safe) and trims `doc.ai` to just `activeThreadId`. The server reads only that, and the live conversation travels separately in the request's `messages` array, so shipping the full transcript on every request was unbounded and unnecessary. This changes only what is serialized, not what `doc.ai` holds client-side.
- **`privateMode` gates client-side, not only server-side.** `pageSnapshot`, `dashboardState`, and `richContext` are built inside one `if (!privateMode)` block, so the guarantee that no real row values or dashboard structure leave the client doesn't rest on the middleware honouring the flag. `createWidgetFromDescription.ts` and `useTextWidgetAI.ts` are **separate request builders and need their own gates** — the former omits per-source and per-field `aiDescription`s and skips computing the distinct-value `cardinality` string entirely, forwarding `privateMode` in the body so the server can also refuse.
- **The stream settles exactly once**: a `streamSettled` boolean plus `closeStream()`/`errorStream()` helpers, including a `finally`-block fallback close for a connection ending without a `finish` or `error` event. Because thread switching means several `sendMessage` streams can be live at once, readers are tracked in a per-adapter `Set` so `stop()` cancels every one and one stream's cleanup can't null another's reader.
- `parseSSEStream` flushes the decoder and processes a trailing non-newline-terminated event on completion — a connection ending without a final newline previously surfaced a spurious "stream closed early" or silently dropped a dashboard-mutating `state-mutation`. A non-ok `/approval` response throws rather than leaving the conversation hanging until the SSE times out. The `tool-activity`/`usage` branches are defensively coerced like `tool-approval-request` already was, so a malformed event can't leave a tool card stuck in "input-streaming".

### Trust boundaries

`applyStateMutation.ts` is the SSE `state-mutation` trust boundary. The event is untrusted (`JSON.parse`'d) wire data, so it runs through the schema package's `parseStateMutation` validator; a malformed payload is logged and dropped (never applied, never thrown — one bad event can't kill the stream), and only a validated mutation reaches `controller.applyExternalMutation`, which runs it through the shared reducer — the same one the middleware ran server-side, so an `addWidget` always lands on the server-chosen page regardless of what page is active locally. **This is the only caller passing wire-sourced data to `applyExternalMutation`**; every other caller constructs mutations locally on the typed, non-validating path.

`createWidgetFromDescription.ts`'s `/widget` response is likewise untrusted: `data.kind` is checked against the finite `BuiltinStudioWidgetKind` set (falling back to `'chart'`) rather than coerced via `String(...)`, `config` is run through `sanitizeServerWidgetConfig`, and a hallucinated `sourceId` that doesn't resolve to a real visible source falls back to the first visible source — the same handling a _missing_ `sourceId` always had, since committing `sourceId: undefined` produced a broken empty widget while the tool call still reported success.

### Client-derived context (`richContext.ts`, `generateInsight.ts`)

`richContext.ts` builds purely-additive client-derived signal (field statistics, recent mutations, current selection) attached to every chat request so the model has more to work with without the user typing extra detail.

Its `buildFieldStats` resolves per-source rows through the pipeline under a **synthetic widget id** (`__rich_context__`), which matches no widget — so page, date-range, cross-filter and interactive filters apply while widget-scoped ones never can. That "the live view" contract obliges it to forward `crossFilterAllPages`/`globalCrossFilterMode` into its flat `StudioPipelineState`, exactly as `generateInsight`'s `toPipelineState` does: the field stats and the widget summaries travel in the **same prompt**, so if only one of them honours the dashboard's cross-filter toggles the model is reasoning over two different row sets.

`generateInsight.ts` — despite its name — no longer calls an `/insight` or `/title` endpoint; both were removed and insight generation is entirely server-side. Its remaining job is `buildWidgetDataSummary` (a compact pipeline-filtered CSV-style sample plus numeric stats) and `numericStats`, consumed by the chat requests and by `useTextWidgetAI`.

**Its governing rule: the summary must be computed over exactly the row set the widget renders**, or the model narrates numbers the user cannot see. That means mirroring `useChartWidgetData`'s call shape rather than keeping a drifting copy — the same resolved `widgetFilters`, the same per-chart-type `extraFields`, the same `!f.disabled` guard on the rank lookup, the same per-series `yAggregation` and rank application, the same `shouldApplyWidgetRankAtL3` on both current- and previous-period passes, and a `toPipelineState` forwarding `globalCrossFilterMode`/`crossFilterAllPages` (dropping either made the snapshot's L3 rows resolve cross-filters as if unset while its own L4 pass read them directly, so two layers of one summary disagreed).

Same rule, other call sites:

- The previous-period call sets `dateRangePreset: 'custom'`. Spreading the current filter's original preset let `resolveDateRangePresets` recompute the bounds back to the current window, zeroing every previous-period row.
- Field membership for the raw-row sampling path is checked against rows run through `enrichWithCrossSourceColumns`, not raw pre-L2 rows — else an own-source calculated column or a cross-source grid column (the very column a grid/pivot aggregates) is excluded from the sample and the stats.
- `buildMapWidgetSummary` mirrors the rendered map's cross-source enrichment **and** its region-spelling normalizer, else `'US'`/`'USA'`/`'United States'` are reported as three regions the map draws as one.
- `buildNumericStats` and the KPI/map label lookups resolve through `sourceFieldsWithExpressions`, so an expression field being aggregated gets a stats line and a readable label instead of a raw id.
- `selectSampleRows`' `'anomaly'` mode reserves slots for flagged anomaly rows **first**, then fills the remaining budget with a stride sample. Merging stride-first and slicing could cut off anomalies landing late in the dataset, breaking the contract that they are included.

The client-visible AI protocol types (`StudioAIToolName`, `StateMutation`, `SerializableSkill`, `StudioAIState`, `StudioAIChatThread`) are re-exported from the schema package's `aiTypes.ts`; the server-only pieces (`StudioAISkill.execute`, `SkillExecuteResult`, `StudioAIDataConfig`, rate-limiting/usage types) live exclusively in the middleware package. `useSpeechRecognition.ts` wraps the Web Speech API for voice input.

## Compose drawer & setup panels

`src/components/StudioComposeDrawer/` is the add/edit-widget authoring drawer: `StudioComposeDrawer.tsx` shells it, `AddWidgetView`/`WidgetTypeCard`/`WidgetInstanceList` are the kind picker, `DescribeWidgetSection` the natural-language creator. Each kind's setup panel is registered on its `StudioWidgetDef`, alongside shared editors (`FormatPanel`, `TextFormatPanel`, `GridConditionalFormatSection`) and field pickers (`DataSourceFieldSelect`, `FieldDetailView`, `InlineFormulaBar`).

**Field catalog** (`internals/fieldCatalog.ts`) is the shared fold behind every field picker. `buildFieldCatalog(dataSources, expressionFields, options?)` flattens every source's physical + non-hidden expression fields into `FieldCatalogEntry[]` (a `StudioDataField` annotated with `sourceId`/`sourceLabel`); `buildSourceFieldEntries` does one source. Both take an `expression` policy (`'all'`/`'non-measure'`/`'none'` — the grid's column list excludes measures, chart/KPI value pickers include them). `buildFieldLabelMap` builds a flat `fieldId → label` map for filter chips, first-writer-wins on duplicate ids across sources (a documented limitation).

`DataSourceFieldSelect` does **not** fall back to a same-id field from a different source when a provided `valueSourceId` fails to resolve: a caller passing it is asserting which source the value belongs to, so a miss must display as genuinely unresolved rather than a misleading wrong-source match. The bare-id fallback remains for callers that omit `valueSourceId` entirely.

**`ChartSetupPanel/`** follows the same orchestrator-plus-per-type-section pattern as `StudioChartWidget/` (`GaugeConfigSection`, `ScatterConfigSection`, `FunnelConfigSection`, `HeatmapAxesSection`, `SankeyConfigSection`, `GanttFieldsSection`, `AnnotationsEditorSection`, `PieArcLabelsSection`), each reading only its own family's config keys so an unrelated key survives a type switch untouched. Rules:

- Its `analyzeChartSupport` memo mirrors `useChartWidgetData`'s call shape **exactly** — including `scatterColorField`/`scatterSizeField` and the per-chart-type `chartTypeExtraFields` list. A narrower field set here means the authoring surface says valid while the canvas shows "unsupported chart configuration".
- Controls whose key no renderer consumes are **hidden, not allow-listed**: `AnnotationsEditorSection` for funnel (`StudioFunnelChart` has no reference-line support and `FUNNEL_CHART_KEYS` correctly omits `annotations`), and the `xGroupBy` "Group by" select for funnel and scatter (neither shaping function accepts it). Otherwise the control is a dead write, silently stripped by the write-side key guard with no feedback — and adding an allow-list entry would be worse, since no renderer exists to consume it either way.
- The X-field picker validates an **unrelated-source** candidate against the candidate's _own_ source as the anchor — the source it would adopt on pick — rather than disabling it forever against the current source. `selectedXField` resolves **scoped to the widget's source first**, so a field-id collision on a reachable related source can't re-anchor the panel onto the wrong source, and the "current selection" exemption from the adoption check compares both `id` **and** `sourceId`.
- Gantt field pickers anchor to the widget's existing `sourceId` rather than an unrestricted catalog — filling label/start/end/color top-to-bottom otherwise re-adopted a different source per field, orphaning earlier picks and deleting filters as a side effect of source-switch folding.

**Two shared commit helpers** hold the invariants no individual control should have to remember:

**`commitConfigWithSource.ts`'s `commitChartConfigWithSource`** — a chart has no separate source picker, so a field pick _is_ how it acquires or changes its source. Two invariants:

- **The whole gesture is one undo step.** The source change (plus folded stale-filter removals) commits **first and undoably** — that is what pushes the pre-gesture doc onto the undo stack — then the config patch rides along non-undoably. The order is load-bearing: committing config first would snapshot a doc that already carries it, so undo would revert only the source and land on a torn "new source, old field" state the UI never produced.
- **The config half goes through the merging `updateWidgetConfig`**, never `updateWidget`'s wholesale `config` replacement. Replaying the full stored config through a validating write strips exactly the cross-family keys the schema deliberately retains (see [chart config retention](#chart-config-retention-across-type-switch)).

The two commits exist only because the controller has no "update source and merge a config patch" entry point; the reducer already supports it, so once `updateWidget` forwards a config patch both writes collapse into one fold.

**`commitMeasureSeries.ts`** — `resolveMeasureSeries(config)` is the one canonical read (`ySeries` when present, else `yField` seeded as a one-entry list, else empty) and `buildMeasureSeriesPatch(chartType, next, widgetSourceId)` the one write, shared by the multi-series pickers and the single-measure scatter/funnel/heatmap/sankey sections. It upholds:

- `yField` mirrors the first **own-source** series field. A blended series carries its own `sourceId`, honoured for `mixed` only and resolved separately by the renderer, so a foreign id must never land in the flat single-source `yField` that `analyzeChartSupport` and the SELECT dispatch read back.
- **A field-less series list is a row `count`** — the one aggregation needing no measure field, re-locked here so a cleared picker can never leave an aggregation with nothing to compute. Written only for chart types whose schema declares `yAggregation`; sankey and scatter do not, and the controller's key guard would strip it.
- An existing non-default `yAggregation` survives a series change that keeps a field.

**Cross-cutting setup-panel patterns:**

- **Shared cross-filter section** (`CrossFilterModeSection.tsx`) — rendered by Chart/Grid/KPI/Map. It takes the panel's `modes` list (Chart/Grid/Map offer all three; KPI offers only `['cross-filter', 'none']`, a summary metric having no per-row visual to highlight) and normalizes a legacy-persisted `'cross-highlight'` to display as `'cross-filter'` on panels without a Highlight option — a **display-only** normalization that does not rewrite the stored config.
- **Source-switch undo folding** — every source-change handler early-returns when the picked id equals the current `sourceId`. A no-op MUI `Autocomplete` `onChange` still fires when freshly-mapped option objects differ by reference, and without the guard re-selecting the active source wiped every field-bound column/sort/conditional-format setting.
  - A gesture that both adopts a new source and writes a field commits as **one** call, with both folded into a single `changes` payload, so a single Ctrl+Z reverts the whole gesture instead of landing on a torn intermediate state.
  - `updateWidget` also accepts `{ removeFilterIds }`, folding a batch of `removeFilter` mutations into the same commit. Each panel computes `collectStaleWidgetFilterIds(...)` — widget-scoped filters whose field no longer resolves against the new source — so a switch can't strand a filter that then silently excludes every row with nothing in the UI to explain why.
  - KPI panels additionally reset `kpiSparklineField`/`kpiSparklineSourceId` alongside the value field (the sparkline field is exactly as source-specific) and resolve the value field scoped to the widget's own source first, so an id collision can't feed the wrong type into the repair effect below.
- **Buffer-then-commit-on-blur for numeric/free-text inputs** — every numeric/text/color control (gauge bounds, conditional-format values, expression nodes, sparkline options, annotation labels, slider min/max/step, scatter radii, pie min-angle, funnel gap, color hex and native picker, filter value/between bounds) buffers locally and commits on blur, Enter, or a discrete selection change. Committing per-keystroke through a validating/coercing write re-renders the input with a coerced value mid-type, effectively dropping the keystroke; and dragging the OS color wheel fires `onChange` continuously, pushing dozens of undo entries for one gesture.
- **Self-correcting effects commit non-undoably** — see the [undoability policy](#studiocontroller-srcstorestudiocontrollerts). One trap is worth calling out: `KpiSetupPanel`'s repair effect sources "is the stored aggregation valid" from `getKpiAggregations()`, the same list the panel renders as choices, so an aggregation genuinely omitted from that list is **indistinguishable from a stale value** and gets silently rewritten with no undo path back. That is exactly what happened to `count_distinct`, which the schema and the KPI renderer both fully supported. Anything added to the schema's aggregation set must be added to the option list too.
- Panel effects that read filters route through `selectFiltersForWidget` rather than a raw scope-kind scan (e.g. `KpiSparklineOptions`' auto-date-filter detection, mirroring `useKpiSparkline`'s own scoping), so a filter on a different page/widget scope can't drive the panel's UI. `MapSetupPanel` routes config edits through `updateWidgetConfig` (merging + key-guarded) rather than a wholesale `updateWidget` from a render-time snapshot, and disables/warns on an unreachable stored field, matching `ChartSetupPanel`'s existing reachability pattern.

## Internationalization

`internals/localeText.ts` defines `StudioLocaleText` — every translatable token — plus `DEFAULT_STUDIO_LOCALE_TEXT` (English). Both are re-exported from `internals/StudioUIConfigContext.ts` (a compatibility façade) so existing deep imports resolve. `StudioProvider`/`Studio`'s `localeText` prop is merged **shallowly** over the defaults, so a consumer can override a handful of tokens without supplying the whole set.

`internals/StudioUIConfigContext.ts` owns the React context/provider/hooks for UI config (`tableSourceMode`, `featureFlags`, `localeText`, `aiConfig`, `customWidgets`, `geographies`, `onOpenFilterPanel`), the flat `ResolvedStudioFeatures` shape, and the `resolveSubFlag` logic unwinding nested `StudioFeatureFlags` sub-objects into top-level booleans. It also re-exports the widget-registry types for the same compatibility reason.

`src/locales/` ships bundles: `enUS.ts` exports only the MUI-`Localization`-shaped object (the raw English text is `DEFAULT_STUDIO_LOCALE_TEXT` in `internals/localeText.ts`, re-exported from the package index). `fr`/`de`/`es`/`ptBR` each export both a raw `xxLocaleText` and a `Localization` built by `getStudioLocalization` (matching the `components.MuiStudio.defaultProps.localeText` shape other MUI X packages use). `locales.test.ts` asserts every bundle has exactly `enUS`'s key set.

Hooks: `useStudioLocaleText()` for the merged locale object; `useStudioFeatures()`/`useStudioUIConfig()`/`useStudioGeographies()`/`useCustomWidgetMap()` for the rest. Most feature flags default `true`, but `quickFilter` and `crossFilterBar` deliberately default `false`.

## Public API surface

Exported from `src/index.ts`:

- **Root components** — `Studio` (full authoring UI, imperative `StudioHandle` ref) and `StudioDashboard` (embed-first, view-oriented wrapper taking a pre-built `config: StudioState` + `dataAdapters` map, for displaying a live dashboard without the authoring UI).
- **Layout** — `StudioCanvas`, `StudioDateRangeBar`, `StudioWidgetCard`, `StudioWidgetEditDialog`, `StudioNoDataOverlay`, `DrawerPanel`/`DrawerPanelContext`, `TabbedSidebar`.
- **Widgets** — all seven, plus `CHART_MIN_HEIGHT`, the filter-control prop types, and `GeographyLoader`/`StudioMapGeographyDefinition`.
- **Drawers/dialogs** — `StudioDataDrawer`, `StudioComposeDrawer` (+ `InlineFormulaBar`, `DataSourceFieldSelect`), `StudioFiltersDrawer`, `StudioExpressionFieldDialog`.
- **Context** — `StudioProvider`, `useStudioController`, `useStudioSelector`, `useStudioState`, `useStudioFeatures`, `useStudioUIConfig`, `useStudioLocaleText`, `useStudioGeographies`, `useCustomWidgetMap`, `useStudioKeyboardShortcuts`, `CanvasScrollContext`, and the `selectors.ts` library.
- **Locales**, **widget utilities** (`WIDGET_TYPES`, `createDefaultWidget`, `normalizeGridColumn`), **controller/state** (`StudioController`, `createStudioController`, `createDefaultStudioState`, the persistence functions, `CURRENT_SCHEMA_VERSION`, `computeDateRangePreset` — which uses dayjs subtraction so a `last_3_months`/`last_12_months` window clamps day-of-month on a month-end rollover), **AI/chat** (`StudioChatPanel`, `createBackendChatAdapter`, `applyStateMutation`, `useSpeechRecognition`, the client protocol type subset), **server adapters**, **models** (the full type surface re-exported from the schema package plus local feature-flag types), and **brand** (`StudioWordmark`).

`StudioController`'s concrete class and `internals/` are reachable but not meant to be constructed directly outside `Studio`'s imperative `StudioHandle` ref (`undo`/`redo`/`canUndo`/`canRedo`, `setMode`, `setActivePage`, `removePage`, `reorderPages`, `getState`, `serializeState`/`loadSerializedState`, `serializeSession`/`restoreSession`, `setDataSourceAdapter`, `setDataSourceRows`, `upsertDataSource`).

### `StudioDashboard`'s config-swap protocol

On a `config` reference change it calls `loadSerializedState(config.doc)` (the persisted doc shape, run through `migrateState`/`validateStateStructure` — not a re-serialized string), logs migration errors, then performs three steps that exist because `loadSerializedState` deliberately **preserves the previous controller's entire `runtime.dataSources`**:

1. `upsertDataSource()` per entry in `config.runtime.dataSources` — otherwise a swap picks up no new sources.
2. Remove any runtime source the new config dropped — otherwise a pruned source survives forever.
3. Re-apply the current `dataAdapters` map via `setDataSourceAdapter` for every entry, read from a **ref** (the config-swap effect stays keyed only on `[config]`).

Step 3 is needed because the separate adapter-registration effect only re-runs on `[dataAdapters]` identity change, and hosts are deliberately steered toward a referentially **stable** map precisely so they don't need a fresh object each render. Since `setDataSourceAdapter` no-ops when its target source doesn't exist yet, a source that a config swap introduces or re-adds would otherwise be installed adapter-less, with every widget on it silently rendering from absent static rows instead of live data. `setDataSourceAdapter`'s own same-reference no-op guard makes unconditional re-application safe.

The registration effect also **unregisters** adapters the host dropped: it tracks the ids registered on the previous run and clears any key no longer present (a clean no-op when the source doesn't exist). Iterating only the new map left a removed key's adapter registered forever, its last fetched rows shadowing freshly-resolved in-memory rows — the same staleness class as the blended-series `asyncForeignRows` prune.

### Server adapters (`src/server/`)

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

The one divergence still merely warned about, via a one-time `warnAdapterDivergence`, is `not_equals` on a NON-date field: SQL three-valued logic excludes NULL rows server-side while the evaluator keeps them, and the wire protocol has no `IS NULL` to repair it with. It stays pushed down because it is a common, high-selectivity predicate and routing it client-side would defeat the pushdown (and drop the filter entirely for an already-aggregated widget). Also warned rather than silent: a filter on an arithmetic expression field (no server column exists; `resolve()` reports `{ skip: true }`), and `count_distinct` downgrading to a plain `count`.

`createSimpleAdapter` performs **none** of these rewrites: it POSTs the `StudioFilterNode` tree untranslated, so the host owns Studio's operator semantics — including the day granularity above. Its module doc block spells the required SQL out operator by operator.

**`count` is never pushed to the server at all.** The wire protocol's `count` becomes SQL `COUNT(column)` (skipping NULL measures) while Studio's `'count'` means `COUNT(*)` everywhere else, so a count-aggregated widget instead fetches raw rows (aggregations stripped, warned) and aggregates client-side, keeping the adapter path consistent with every in-memory widget kind.

Three smaller invariants:

- The ORDER BY clause is dropped whenever the sort field is either `skip` **or** `unresolved` (resolvable to no column here, e.g. a groupBy field 2+ hops away). Checking only `skip` emitted `ORDER BY <nonexistent column>` and failed the whole batch entry when dropping the clause would have produced usable rows.
- Within one window, each request/response pair is matched by a composite `${widgetId}::${cacheKey}` (falling back to the bare `widgetId` only when unambiguous), so two calls for one widget with different descriptors can't be cross-wired and cached under the wrong key.
- In simple mode the shared per-endpoint loader reads `fetchFn`/`batchDelayMs` from a live, refreshable config object rather than baking them into its closure, so recreating an adapter at an already-registered endpoint (an auth-token rotation) updates the loader instead of pinning the first instance's stale `fetchFn`.

## Testing & benchmarks

- Nearly every file in `internals/`, `store/`, and `context/` has a co-located `*.test.ts`; components co-locate `.test.tsx` files, often per concern (`StudioGridWidget.crossFilter.test.tsx`, `StudioCanvas.gridLines.test.ts`, `StudioCanvas.widgetErrorBoundary.test.tsx`, …).
- `internals/__fixtures__/fanOutGolden.test.ts` is a golden-file regression test for the L4 fan-out/grain-resolution behaviour.
- `internals/renderPerf.test.tsx` guards against render-count regressions in the hot widget path.
- `benchmarks/` (`pnpm --filter "@mui/x-studio" bench`, or `bench:vitest`) measures each layer independently — L1 `normalizeDataSourceRows`, L2 `enrichRowsWithExpressions`, L3 `resolveRows` cold vs. `resolveRowsCached` warm, L4 cold vs. cache-hit, and the aggregators — over a deterministic `syntheticData.ts` generator. The methodology mirrors `@mui/x-studio-data-middleware`'s for cross-package comparability.
- `packages/x-studio-schema` has its own node-only vitest config and suite, reflecting that it has no DOM/React dependency.

## Extension points

Most of these fail closed at compile time; the pattern is `satisfies Record<Union, …>` on a registry so a missed entry is a type error rather than a runtime fallback.

- **New built-in widget kind** — add the string to `StudioWidgetKind` (schema pkg), create `components/widgets/Studio<Kind>Widget/`, add a `BUILTIN_WIDGET_DEFAULTS` entry in `createDefaultWidget` (schema pkg `factories.ts`), and a `BUILTIN_WIDGET_DEFS` entry (`internals/builtinWidgetDefs.ts`). Both tables are exhaustive-checked.
- **New chart type** — add the schema-side plumbing described in the schema package's `ARCHITECTURE.md` (new `StudioChartType` literal, family interface, `StudioChartConfigByType`/`CHART_TYPE_CONFIG_KEYS` entries), then a `render*` function and `CHART_TYPE_DEFS` entry in `StudioChartWidget/chartTypeDefs.tsx`, and a `chartTypeRegistry` entry in `internals/chartTypeRegistry.ts`. Also decide whether it re-ranks post-aggregation — if so, add it to `POST_AGGREGATION_RANK_CHART_TYPES` in `internals/StudioPipeline.ts`; if not, L3 applies its widget rank automatically.
- **Custom widget kind** (app-level, no fork) — register a `StudioCustomWidgetDef` via `customWidgets`; folded into the same registry `useWidgetDefMap()` returns.
- **New data source backend** — implement `StudioDataSourceAdapter`, or use `createSimpleAdapter`/`createBatchingAdapter` (the latter also generating cross-source JOINs when given `dataSources`/`relationships`).
- **New expression operator** — add a case to `evaluateFunctionExpression` (`utils/expressionEvaluator.ts`); its `const exhaustiveCheck: never = operator` forces every call site to be updated.
- **New AI mutation type** — add the variant to `StateMutation` (schema pkg `aiTypes.ts`) and an entry to `applyMutation.ts`'s `MUTATION_HANDLERS` (co-locating `apply` and `label`); the mapped type requires one entry per variant, failing to compile in both the client and the middleware. Weigh this against composing existing mutations via `commitMutations` — each variant is nominally AI-tool-facing wire surface.
- **New locale** — add a file under `locales/` following the `Localization`/`getStudioLocalization` shape and matching the full `StudioLocaleText` interface; `locales.test.ts` fails on any missing token.
- **A `StudioState` shape change that breaks deserialization** — bump `CURRENT_SCHEMA_VERSION`, add a migration keyed by the previous version, add a `statePersistence.test.ts` fixture. Only `doc`-partition changes ever need a migration; `session`/`runtime` are reconstructed on load.
