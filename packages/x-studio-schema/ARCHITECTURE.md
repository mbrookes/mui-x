# Architecture — `@mui/x-studio-schema`

Internal reference for how the shared Studio schema package is put together: what the pieces
are, how they fit, and which decisions are load-bearing.

## Contents

- [Overview](#overview)
- [Directory layout](#directory-layout)
- [Type modules](#type-modules)
- [The widget and chart discriminated unions](#the-widget-and-chart-discriminated-unions)
- [Cross-cutting invariants](#cross-cutting-invariants)
- [Function modules](#function-modules)
- [Consumers](#consumers)
- [Testing conventions](#testing-conventions)
- [Extension points](#extension-points)

## Overview

`x-studio-schema` is the shared data model for MUI X Studio: every
`StudioState`/widget/data-source/filter/expression/AI-protocol type, plus the handful of pure
functions both consuming packages must agree on bit-for-bit. This is the single place a
`StudioState` shape change is made; `@mui/x-studio` and `@mui/x-studio-ai-middleware`
re-export from here rather than keeping independent copies, so they cannot drift.

**Zero runtime dependencies** — no React, no Node built-ins — so it is importable from both a
browser bundle and a server bundle. The one borrowed type is `chatTypes.ts`'s type-only
`import type { ChatMessage } from '@mui/x-chat-headless'`, which compiles away to nothing.
That package is declared under `devDependencies`, matching the AI middleware's identical
type-only declaration: neither package has a build step today (`main`/`exports` point straight
at raw `.ts`), so pnpm workspace linking resolves it either way, and `devDependencies`
correctly signals "not needed at runtime by an external consumer" for whenever a real publish
step is added.

### What belongs here

| Belongs here                                                     | Stays in the consuming package                                   |
| :--------------------------------------------------------------- | :--------------------------------------------------------------- |
| Pure state-shape transforms (mutation reducers, factories, math) | Anything touching React, MUI, the DOM, or in-memory rows         |
| Types both the client and the middleware read                    | UI-only prop types (for example, `x-studio`'s `featureFlags.ts`) |

`featureFlags.ts` is the canonical example of the second column: those interfaces look like
they belong here, but the AI middleware never references them, so they live client-side.

### Module kinds

- **Type modules** — pure types, no runtime code. `index.ts` re-exports each with `export *`.
- **Function modules** — pure functions, no side effects (no uncontrolled `Date.now()`, no
  undocumented randomness, no I/O). `index.ts` re-exports these **explicitly by name**, so the
  package's whole runtime surface is visible at a glance from `index.ts` alone.
- **`aiToolRegistry.ts`** — a hybrid carrying one runtime value alongside the types derived
  from it. Exported explicitly (not `export *`) because `StudioAIToolName` already surfaces
  through `aiTypes.ts` and a second blanket re-export would conflict.

Three function modules are deliberately **package-internal** and absent from `index.ts`:
`unsafeKeys.ts`, `internalGuards.ts` and `docScreening.ts`. So are `normalizePersistedPages` and `pruneDependsOn`,
exported from `applyMutation.ts` solely for `statePersistence.ts` — load-boundary internals, not
public API.

## Directory layout

```text
src/
  baseTypes.ts            Widget-kind/mode/format/operator unions — the "base" primitives
  dataTypes.ts            Data sources, fields, relationships, query/mutation descriptors, adapter contract
  widgetTypes.ts          StudioWidget union, per-kind + per-chart-family config interfaces, StudioPage
  expressionTypes.ts      StudioExpression AST + StudioExpressionField
  stateTypes.ts           Filters/scopes, dashboard/shell state, StudioDoc/Session/Runtime, CURRENT_SCHEMA_VERSION
  mutationTypes.ts        StateMutation union, MutationEnvelope, SerializableSkill, OptionalWidgetField
  richContextTypes.ts     StudioAIRichContext and its constituents
  chatTypes.ts            StudioAIChatThread / StudioAIState (persisted conversation state)
  aiTypes.ts              Composition facade over the three AI-type modules
  aiToolRegistry.ts       STUDIO_AI_TOOL_REGISTRY facts table + its derived types
  factories.ts            Id factories, createDefaultWidget/StudioState, envelope + leaf-shape normalizers
  anomalyDetection.ts     detectAnomaliesIQR (+ private median helper)
  unsafeKeys.ts           The single shared prototype-hazard key denylist
  wireLimits.ts           MAX_ARRAY_LENGTH/MAX_STRING_LENGTH — shared wire trust-boundary size caps
  internalGuards.ts       isPlainRecord/stripUnsafeOwnKeys/repairFilterDependsOn — shared boundary helpers
  docScreening.ts         The per-entry StudioDoc screens shared by the load boundary and the factory
  rankFilterScope.ts      Rank-filter page-scope resolution + the uniqueness sweep, shared by all three producers
  applyMutation.ts        The single mutation reducer; GRID_COLS/MIN_SPAN; two load-boundary internals
  parseStateMutation.ts   The runtime validation gate for wire-sourced mutations
  widgetTypeGuards.ts     Runtime narrowing + the three closed-union membership lists
  configKeyValidation.ts  Write-side config-key allow-lists, kind level and chart-type level
  temporalUtils.ts        truncateToPeriod / isoWeek — date-bucketing helpers
  statePersistence.ts     serialize / deserialize / migrate — the persistence boundary
  index.ts                Public export surface
```

Every runtime module has a co-located `*.test.ts` except four: `aiToolRegistry.ts` (a declarative
facts table whose invariants are compile-time-enforced by the mapped types deriving from it),
`unsafeKeys.ts` (a fixed three-literal `Set` plus a one-line membership check, exercised
indirectly by every prototype-hazard case in the boundary suites), `wireLimits.ts` (two exported
number constants, exercised indirectly by every size-cap case in `parseStateMutation.test.ts`,
`applyMutation.test.ts`, and `statePersistence.test.ts`), `docScreening.ts` (whose
screens are exercised through both of their callers — `statePersistence.test.ts` and
`factories.test.ts` — since what matters is that the two boundaries agree on a payload, which only
a per-caller test can assert), and `rankFilterScope.ts` (same reasoning, across its three callers'
suites). The pure type modules have no runtime behavior to test.

## Type modules

- **`baseTypes.ts`** — `StudioMode`, `StudioDrawer`, `BuiltinStudioWidgetKind`/`StudioWidgetKind`
  (the latter widens to `string & {}` so consumer-defined custom kinds typecheck),
  `StudioFilterWidgetType`, `StudioCrossFilterMode`, `StudioChartType` (16 members, CLOSED),
  `StudioBarLayout`, `StudioNumberFormat`, `StudioKpiAggregation`,
  `StudioGridSummaryAggregation`, `StudioFilterOperator`. Intentionally small (~110 lines):
  every widget-config-shaped or data-model-shaped type lives in `widgetTypes.ts`/`dataTypes.ts`.

- **`dataTypes.ts`** — `StudioDataField` (+ `FieldCapability`), `StudioFilterNode` (the wire
  filter tree adapters/middleware consume), `StudioQueryDescriptor`/`StudioQueryResult`,
  `ClientMutationDescriptor`/`ClientMutationResult`, `StudioDataSourceAdapter` (the contract a
  host implements to wire a data source to a remote backend, with an optional `submitMutation`
  write-back), `StudioDataSource`, and `StudioRelationship` (cross-source joins covering
  `many-to-one`/`one-to-one`/`many-to-many` — a data-model concept, not an expression concept,
  hence its home here).

- **`widgetTypes.ts`** — the widget-config type surface (see
  [the unions section](#the-widget-and-chart-discriminated-unions) for the full treatment):
  - Building blocks: `StudioConditionalFormatStyle`/`StudioConditionalFormat`,
    `StudioGridColumn`, `StudioChartSeries`, `StudioChartAnnotation`, `StudioWidgetForecast`.
    `StudioChartSeries`'s render-kind field has a canonical spelling (`type`) and a deprecated
    alias (`seriesType`); `normalizeChartSeries` collapses the two.
  - Chart mixins: `StudioChartConfigBase` (currently empty — `crossFilterMode` moved to
    `StudioSharedWidgetConfig` because every kind's runtime reads it, not just charts) and
    `StudioChartSortConfig` (`chartSortBy`/`chartSortDirection`). The cartesian families share
    the sort mixin, and so does pie/donut: pie isn't cartesian, but its sort and date-group-by
    keys are read one layer above `renderPieDonut`, in the shared `useChartWidgetData`
    aggregation, and the compose drawer writes them the same way — hence
    `StudioPieFamilyChartConfig` extends the mixin and also carries `xGroupBy?`. Funnel declares
    `chartSortBy` alone with no direction; heatmap uses its own `heatSortBy`/`heatSortDirection`.
  - The ten per-chart-family config interfaces plus the union/map/flat recomposition.
  - Per-kind config interfaces (`StudioGridConfig`, `StudioKpiConfig`, `StudioTextConfig`,
    `StudioFilterWidgetConfig`, `StudioPivotConfig`, `StudioMapConfig`) and
    `StudioSharedWidgetConfig` (keys common to every kind: `titleFontSize`, `cardExpandTitle`,
    `crossFilterMode`, `measures`/`dimensions`, `customConfig`).
  - The widget-kind union machinery: `StudioWidgetConfig` (flat), `StudioWidgetConfigByKind`,
    `StudioWidgetConfigForKind<K>`, `StudioWidgetOf<K>`, `StudioWidget`.
  - `StudioPageTheme`, `StudioPage` (`id`, `title`, `widgetRows: string[][]` — a 2D layout grid
    of widget ids — `widgetColSpans?`, `theme?`, `stackBreakpoint?`).

  > `crossFilterMode: 'none'` suppresses cross-filters contributed by OTHER widgets only. An
  > interactive filter-widget selection is a hard filter, not a cross-filter, and deliberately
  > still applies. `StudioCrossFilterMode`'s doc comment spells this out, since `'none'` reads
  > at a glance like "always show the unfiltered dataset", which it is not.

- **`expressionTypes.ts`** — `StudioExpressionOperator` (a closed 22-member union),
  the four `StudioExpression` AST node variants
  (`StudioFunctionExpression`/`StudioValueExpression`/`StudioFieldExpression`/`StudioJoinFieldExpression`),
  and `StudioExpressionField` (a user-authored calculated column/measure).

- **`stateTypes.ts`** — `StudioFilterScope`, `StudioDateRangePreset` (11 presets),
  `StudioFilterState`, `StudioShellState`, `StudioDashboardState`, `StudioFilterPreset`,
  `CURRENT_SCHEMA_VERSION`, and the lifetime-partitioned state shape (below).

  `StudioFilterScope` is a discriminated union — `{kind:'page';pageId?}` /
  `{kind:'widget';widgetId}` / `{kind:'cross-filter';sourceWidgetId;pageId}` /
  `{kind:'interactive';sourceWidgetId;pageId}` / `{kind:'dashboard-date-range';sourceId;pageId}`
  — and is the sole scope descriptor, with no parallel boolean/ID fields to keep in sync. Only
  `page`'s `pageId` is optional (a legacy pageId-less filter applies on every page); the other
  three that carry one require it.

  `CURRENT_SCHEMA_VERSION` (an integer, currently `1`) lives here, next to the
  `StudioDoc.schemaVersion` field consuming its literal type, rather than in
  `statePersistence.ts`: `factories.ts` needs it as a runtime value when stamping a fresh doc,
  and importing it from `statePersistence` (which imports `factories`) would form a cycle.
  `statePersistence.ts` re-exports it, so every existing import site is unaffected.

### The lifetime partition

`StudioState` is `{ doc; session; runtime }` — a three-way partition by lifetime, not a flat bag.

| Partition       | Persisted | Undoable | Reducer touches it | Contents                                                                                                                  |
| :-------------- | :-------- | :------- | :----------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `StudioDoc`     | yes       | yes      | yes                | `schemaVersion`, `dashboard`, `pages`, `widgets`, `relationships`, `filters`, `expressionFields`, `filterPresets?`, `ai?` |
| `StudioSession` | no        | no       | no                 | `mode` (`edit`/`view`), `shell` (open drawers, selection)                                                                 |
| `StudioRuntime` | no        | no       | no                 | `dataSources` (host-injected)                                                                                             |

Three consequences worth stating plainly:

- A view↔edit switch is not a dashboard edit, so `mode` is in `session` and Ctrl+Z must never
  flip it.
- An undo must never revert live data sources to stale rows, so `dataSources` is in `runtime`.
- Cross-filter- and interactive-scoped entries live in **`doc.filters`**, not `session`,
  precisely because the reducer manipulates them and `applyCrossFilter` is deliberately
  undoable. They are stripped only at the persistence boundary (`serializeDoc`), never from
  the live doc.

`StudioController`'s undo/redo stacks snapshot `StudioDoc[]` only.

### AI-protocol types

- **`mutationTypes.ts`** — the mutation/skill wire protocol:
  - `SerializableSkill` — the client-safe subset of a skill definition, stripped of its
    non-JSON `execute` function before crossing the wire.
  - `OptionalWidgetField` — a derived type resolving to exactly the OPTIONAL keys of
    `StudioWidget`. It types `updateWidget.args.unsetFields`, so a wire caller structurally
    cannot type a payload that voids a required field (`id`/`kind`/`title`/`config`), and it
    stays correct automatically as `StudioWidget` gains or loses optional fields.
  - `StateMutation` — the discriminated union over all 14 mutation kinds.
  - `MutationEnvelope<T>` — wraps a mutation for SSE transport with a collision-resistant `id`
    and a production timestamp `at`. Envelope metadata, distinct from any domain field the
    mutation itself persists (for example, `renameAIThread.args.updatedAt`).

  Four variants carry an explicit, server-chosen targeting field so the reducer never has to
  guess "whichever page/thread is active on the applying side": `addWidget.args.pageId`,
  `setWidgetLayout.args.pageId`, `setWidgetColSpan.args.pageId`, `renameAIThread.args.threadId`.
  All are optional, falling back to the applying side's active page/thread for legacy payloads.

  `updateWidget.args` carries a wire-safe field-clear affordance — `unsetFields` and
  `unsetConfigKeys` — because a `changes`/`config` entry with an `undefined` value cannot
  survive `JSON.stringify`. A key **name** is the only way to void a field over the wire.

  `applyBulkUpdate.args` is a lost-update-safe **delta**: `removedWidgetIds` / `addedWidgets` /
  `updatedWidgets` layered on the receiver's _current_ `widgets` record, targeted at the required
  `activePageId`, plus optional `widgetRows` / `widgetColSpans` for that page's layout. Because the
  deltas layer onto current state rather than a turn-start snapshot, a widget concurrently
  created or edited while an agentic turn runs keeps its record entry instead of being silently
  reverted. `widgetRows`/`widgetColSpans` are **optional** because an updates-only bulk has no
  layout snapshot to attach; see [`applyBulkUpdate`](#applybulkupdate) for how the reducer stays
  total over every partial shape.

- **`richContextTypes.ts`** — `StudioAIFieldStat`/`StudioAILayoutWidget`/`StudioAICrossFilterEdge`/`StudioAIPageLayout`/`StudioAIRecentMutation`,
  the constituents of `StudioAIRichContext`: the purely-additive client-derived signal attached
  to each chat request. Each section is droppable to stay under a token budget (dropped names
  recorded in `omitted`), and none is sent in `privateMode`.

- **`chatTypes.ts`** — `StudioAIChatThread`/`StudioAIState`, the persisted conversation state
  serialized inside `doc.ai`.

- **`aiTypes.ts`** — a thin composition facade: `export *` over the three modules above (every
  name is unique, so the blanket re-export is safe) plus a `StudioAIToolName` pass-through.
  Server-only AI types (`StudioAISkill` with its `execute`, `SkillExecuteResult`,
  `StudioAIDataConfig`, rate-limit/usage types) are **not** here — they live in the AI
  middleware, since the client never needs them.

- **`aiToolRegistry.ts`** — `STUDIO_AI_TOOL_REGISTRY`, the single declarative source of truth
  for per-tool **facts** (not implementations, not JSON-schema parameters): display `title`,
  `destructive`, `mcpDestructiveOverride`, the MCP `readOnly`/`idempotent`/`openWorld` hints,
  `privateModeExcluded`, `mcpSupported`. `StudioAIToolName = keyof typeof STUDIO_AI_TOOL_REGISTRY`
  is the canonical tool-name union; `StudioAIToolFacts` is the per-entry shape.

  Living in a dependency-free package lets the client read tool facts without depending on the
  AI middleware, and every scattered server-side per-tool artifact (`STUDIO_AI_TOOLS`,
  `DESTRUCTIVE_TOOLS`, `TOOL_TITLES`/`TOOL_ANNOTATIONS`, `PRIVATE_MODE_EXCLUDED_TOOLS`,
  `MCP_UNSUPPORTED_TOOLS`, the `executeToolOnState` switch) derives from it, so two of them
  cannot disagree.

  `mcpDestructiveOverride` controls the MCP `destructiveHint` only. A tool carrying it (for example
  `remove_page_filter`) is destructive on MCP even though `destructive` is `false` for chat —
  MCP clients have no separate confirmation step. That does **not** mean the operation is
  unguarded on chat: the composed default chat policy gates filter removals through its own
  `removedFilterIds` check.

## The widget and chart discriminated unions

Two nested unions carry the widget-config type surface, and they behave differently in a way
that is load-bearing for the rest of the package.

### `StudioWidget` — the widget-kind union (OPEN)

```ts
export type StudioWidget =
  | { [K in BuiltinStudioWidgetKind]: StudioWidgetOf<K> }[BuiltinStudioWidgetKind]
  | StudioWidgetOf<string & {}>;
```

Each `StudioWidgetOf<K>` narrows `config` to `StudioWidgetConfigForKind<K>` — the shared chrome
(`StudioSharedWidgetConfig`) plus that kind's own interface from `StudioWidgetConfigByKind` (or
just the chrome plus `customConfig` for a custom kind). `StudioWidgetConfigByKind` is the single
source of truth wiring a `widget.kind` discriminant to its precise config shape; `chart` maps to
the `StudioChartWidgetConfig` union, one level finer.

The trailing `StudioWidgetOf<string & {}>` member makes consumer-defined custom kinds
first-class — and its non-literal `kind: string` means **`StudioWidget` is not a TypeScript
discriminated union**. A bare `if (widget.kind === 'chart')` does not narrow `widget.config`,
because TypeScript cannot rule out `string === 'chart'` for that member. This is a real TypeScript limitation,
not an oversight; it is exactly why `isWidgetOfKind()` exists.

### `StudioChartConfig` — the chart-type union (CLOSED)

One level finer, a chart widget's `config` is itself a union over `chartType`. Ten family
interfaces cover the 16 `StudioChartType` literals:

| family interface                  | `chartType` literals                       |
| :-------------------------------- | :----------------------------------------- |
| `StudioBarFamilyChartConfig`      | `bar`, `bar-stacked`, `bar-100`            |
| `StudioLineAreaFamilyChartConfig` | `line`, `area`, `area-stacked`, `area-100` |
| `StudioMixedChartConfig`          | `mixed`                                    |
| `StudioHeatmapChartConfig`        | `heatmap`                                  |
| `StudioFunnelChartConfig`         | `funnel`                                   |
| `StudioGanttChartConfig`          | `gantt`                                    |
| `StudioSankeyChartConfig`         | `sankey`                                   |
| `StudioPieFamilyChartConfig`      | `pie`, `donut`                             |
| `StudioScatterChartConfig`        | `scatter`                                  |
| `StudioGaugeChartConfig`          | `gauge`                                    |

`StudioChartConfigByType` maps each literal to its family, locked complete by a compile-time
`AssertChartTypesCovered` check. `StudioChartConfigOfType<T>` indexes it;
`StudioChartWidgetConfig` is the union of all ten and is the type of a chart widget's `config`.

`StudioChartType` is **CLOSED** — there is no consumer-extensible custom chart type, per
`AGENTS.md`'s "x-studio custom charts" rule (custom charts are custom _widgets_, never new chart
types). Because the union has no `string`-typed catch-all, a bare `config.chartType === 'gauge'`
narrows **natively**; no runtime guard sweep is needed the way the kind union needs
`isWidgetOfKind()`. The discriminant is optional on the bar family only: an absent `chartType`
means `'bar'`, which makes the empty config `{}` a valid bar config.

### The flat patch types

`StudioWidgetConfig` and `StudioChartConfig` — every key, all optional — are KEPT deliberately
as the generic/patch types. `StudioChartConfig` is RECOMPOSED from the ten family interfaces via
`Partial<Omit<Family, 'chartType'>>` intersections, so it can never structurally drift from them.

Their keys are all optional because a widget can carry keys authored while it was a different
kind — switching a widget's `kind` does not clear its `config`. Code that must operate on config
BEFORE the kind is known, or across kinds by design, uses these: the reducer,
`StudioController.updateWidgetConfig`'s generic patch path, the AI tool-argument builder,
cross-kind registries, the compose drawer's shared top controls, and untrusted wire input before
narrowing. The per-kind split exists so a setup panel can reference a focused type
(`StudioGridConfig`) instead of the 100+-key union.

### Key retention across `chartType` switches

**This is a deliberate, permanent feature, not a bug.** `applyMutation`'s merge (patch, not
replace) semantics mean a widget toggled bar → gauge → bar keeps its `xField`/`ySeries` so the
user's prior configuration isn't destroyed. Nothing strips stale-for-current-type keys and no
migration exists to do so.

Consequently, every reader of the narrow per-family types must gate on the resolved `chartType`
rather than assume a stray other-family key can't be present. For narrow-typed readers the type
system enforces this structurally, and a stray key is expected, not corrupt.

**All three write boundaries PRESERVE foreign-family keys** — `deserializeState`, `applyMutation`'s
config merge, and the wire boundary's `validateWidget`. The last of these used to strip them, which
made round-tripping a stored widget through `addWidget`/`applyBulkUpdate.addedWidgets` (duplicating
it, moving it across dashboards) destroy the very keys this feature exists to keep.
`stripForeignFamilyKeys` (see [`configKeyValidation.ts`](#configkeyvalidationts--write-side-config-key-guards-two-levels-deep))
still exists, but as an opt-in utility for a caller that genuinely wants a config reduced to one
family — not as anything a boundary applies.

## Cross-cutting invariants

These rules recur at nearly every call site in the package. They are stated once here; the
per-module sections below reference them rather than re-arguing each one.

### The four trust boundaries

A `StudioDoc` can be reached by untrusted input at exactly four places, and each has its own
guard layer:

| Boundary               | Module                                    | Input                                                                                     |
| :--------------------- | :---------------------------------------- | :---------------------------------------------------------------------------------------- |
| **Wire**               | `parseStateMutation.ts`                   | An SSE `state-mutation` event the client `JSON.parse`d                                    |
| **In-process reducer** | `applyMutation.ts`                        | A server-built mutation from `executeToolOnState.ts`, which bypasses the parser           |
| **Persistence load**   | `statePersistence.ts` + `docScreening.ts` | A `JSON.parse`d persisted, shared, or hand-edited doc                                     |
| **Factory overrides**  | `factories.ts` + `docScreening.ts`        | `createDefaultStudioState({ doc })`, reachable from the public `Studio initialState` prop |

**The factory was the unscreened fourth producer**, and that is what `docScreening.ts` exists to
close. The per-ENTRY screens used to live inside `deserializeState`, which made the persistence load
boundary the only producer that applied them — yet `createDefaultStudioState` builds a doc from
`overrides.doc`, and that bag is reachable straight from `Studio`'s public `initialState` prop via
`new StudioController(initialState)`. Three defects traced through the hole, each already repaired
per-entry by the load boundary: a filter with no `scope` threw `Cannot read properties of undefined
(reading 'kind')` inside `serializeDoc` on the FIRST autosave and on every undo snapshot; a widget
with `config: null` threw mid-reduce in `shallowRecordEqual`; and `ai.threads: 'junk'` threw
`threads.map is not a function` on the first `renameAIThread`. Extracting the screens into a shared
module — rather than duplicating them in the factory — is what keeps the two producers from
drifting, the same reason `internalGuards.ts` exists.

`screenDoc(partialDoc)` touches **only the keys the bag actually carries**. That rule is what makes
it safe for the factory, whose documented merge contract is that an absent override field keeps the
factory default: stamping `filters: []` / `ai: undefined` onto a bag naming neither would change the
shape of every default doc in the codebase.

Two of `deserializeState`'s behaviours are deliberately **not** applied by the factory:

- **Stripping `cross-filter`/`interactive`-scoped filters** (`stripSessionScopes`). Those two kinds
  are session-flavoured and `serializeDoc` never writes them, so one arriving from disk must not
  install — an orphaned cross-filter would permanently filter its page, since the reducer's cleanup
  for it fires only when the source widget is REMOVED and it was never present. The factory produces
  LIVE state, and an in-process caller legitimately builds state carrying both kinds, so the bar is
  on the disk boundary only.
- **The orphan page/widget anchor probes** (`FilterAnchorProbes`). The load boundary has already
  swept the page map and widget record and can tell an orphan anchor from a live one; the factory
  merges its `pages`/`widgets` overrides onto the defaults AFTER the screen runs, so a filter
  anchored to the default page would look like an orphan here and be wrongly dropped.

Everything else `deserializeState` does, the factory does too, and each of the three that are
_reconciliations_ rather than per-entry screens is applied at the same point in the factory's own
assembly — after the merge, once the final page map exists:

- **`schemaVersion` is STAMPED, never taken from the override.** The factory used to let
  `{ ...baseDoc, ...docOverrides }` carry an override's value through (`screenDoc` copies the field
  untouched), making it the only doc producer that did: `deserializeState` writes
  `CURRENT_SCHEMA_VERSION` unconditionally and ignores the persisted value, and no reducer handler
  writes the field at all. The realistic path in is a cast —
  `initialState={{ doc: JSON.parse(saved) as StudioDoc }}`, since the literal type blocks a direct
  `schemaVersion: 2` — and the consequence is not cosmetic: `serializeDoc` spreads the value back
  out on the first autosave, so the NEXT load hits `deserializeState`'s deliberate
  newer-than-current throw (or `migrateState`'s matching refusal) on a doc **this build produced
  itself**, permanently unloadable.
- **`dashboard.activePageId` is reconciled with the same `typeof === 'string'` guard as the load
  boundary.** See [string ids: the coercion-desync class](#string-ids-the-coercion-desync-class):
  `Object.hasOwn` coerces its key, so a numeric `activePageId: 2` "matches" a string-keyed page
  `"2"` and was waved through as valid, installing a number into a string-typed field.
  `screenDashboard` deliberately does not check `activePageId` (it needs the final page map), so
  this is the only screen it passes. Nothing downstream heals it: `removePage`'s strict `===`
  compare never matches, so removing page `"2"` leaves `activePageId: 2` dangling and every legacy
  pageId-less mutation no-ops forever.
- **Rank-filter uniqueness is re-checked**, via the shared `dedupeRankFilters` — the reducer keeps
  `dropConflictingRankFilters` in three handlers precisely so a doc is never "live-valid and
  load-invalid", and the factory was the last producer that could still mint one. It runs after the
  page map is final (the sweep needs the merged `pages` to resolve a `widget` scope's context, for
  the same reason the anchor probes cannot run at screen time) and, unlike the reducer and the load
  boundary, does NOT cascade the drops into the survivors' `dependsOn` — `pruneDependsOn` lives in
  `applyMutation.ts`, out of reach, and the factory already leaves `dependsOn` alone after every
  other drop `screenFilters` makes.

**Known gap, worth stating rather than implying completeness:** the factory's `pages` override gets
only a SHAPE screen, not the layout sweep. `screenPagesShape` coerces a non-record `pages` to `{}`
and drops a prototype-hazard page key, a non-record page value, and a page carrying a
prototype-hazard own key — the subset that needs no import `docScreening.ts` cannot have. The full
sweep is `normalizePersistedPages`, which lives in `applyMutation.ts` and needs its layout
machinery; `docScreening.ts` cannot import it, because `factories.ts` imports `docScreening.ts` and
moving it would cycle. The load boundary calls it directly, so a factory `pages` override's
`widgetRows` / `widgetColSpans` / `title` / `id` are still unswept. (The factory does separately
uphold the "at least one page always exists" invariant, since a `doc.pages` override replaces the
default page map wholesale.) The rank sweep used to be blocked by the same cycle and is no longer:
its two helpers needed nothing but `StudioDoc['pages']` and `StudioFilterState` as types, so
hoisting them into the dependency-free [`rankFilterScope.ts`](#rankfilterscopets) freed them.
`normalizePersistedPages` has no such easy hoist — it pulls in the span/row layout primitives.

The shape screen is what makes the repair convention below true of `pages` too. `pages` used to be
the ONE `StudioDoc` field `screenDoc` skipped entirely, and therefore the one field where a `doc`
override could make a boundary **throw**, all three reachable from the public `Studio initialState`
prop: `{ pages: undefined }` (which type-checks — `Partial<StudioDoc>` accepts an explicit
`undefined`, and every OTHER field with one was already repaired) threw
`Cannot convert undefined or null to object` from the factory's own zero-page check;
`{ pages: { p1: null } }` plus any widget-scoped rank filter threw
`Cannot read properties of null (reading 'widgetRows')` from `resolveRankFilterPageId`, via the
`dedupeRankFilters` sweep the factory itself runs — the load boundary is immune only because
`normalizePersistedPages` drops the null page BEFORE that sweep; and `{ pages: 'junk' }` installed
the string AS the page map (with `activePageId: '0'`), after which the reducer threw on the first
`addWidget`.

The governing rule is that **all four must agree on the same payload.** A shape the wire
rejects but the reducer accepts becomes _deferred data loss_: the value installs, renders fine,
and is silently discarded by the next `deserializeState`. A shape the reducer accepts but the
load boundary drops is the same bug seen from the other side. Wherever the boundaries differ in
_response_, the difference is deliberate and noted at the site.

Repair convention, uniform across all of them:

- A **required** field with a bad value ⇒ drop the whole entry (`kind`, `title`, a filter's
  `id`/`field`/`operator`, a thread's `id`).
- An **optional** field with a bad value ⇒ strip just that key and let the field's default take
  over (`subtitle`, `sourceId`, `titleMode`, `subtitleMode`, a stray config key).
- A **display-only** field ⇒ coerce to a fallback rather than dropping (`page.title` →
  `'Untitled Page'`, `dashboard.title` → `'Untitled Dashboard'`, `dashboard.id` →
  `'dashboard-1'`, a thread's `name` → `'Untitled Thread'`, a preset's `name` →
  `'Untitled Filter Preset'`).
- A bad value never **throws** at a boundary; it no-ops, drops, or coerces. The one deliberate
  exception is a doc claiming a newer `schemaVersion` (see
  [`deserializeState`](#deserializestate)).

### String ids: the coercion-desync class

Every id-bearing handler requires `typeof id === 'string'` **before** any existence check runs.

The reason is one specific asymmetry: `Object.hasOwn(record, key)` **coerces** its key to a
string, while every other id comparison in the package (`===`, `Set.has`, `.includes`) does
**not**. A numeric id like `42` therefore passes an `Object.hasOwn` existence check against a
widget keyed `"42"` while every downstream cleanup silently misses it. Concretely, without the
guards:

- `removeWidget` deletes the widget but leaves it on its page and in its scoped filters.
- `removePage` deletes the page but leaves its filters and a dangling `activePageId`.
- `setActivePage` installs a number into the `string`-typed `dashboard.activePageId`.
- `addFilter` installs a filter `removeFilter`'s strict `!==` can never match — unremovable
  in-session.
- `setWidgetColSpan` persists a dead span on the wrong page.

The guard applies at three depths: the mutation's own ids, the ids inside `filter.scope`
(`widgetId`/`sourceWidgetId`/`pageId`), and each entry of an id-bearing array
(`removedWidgetIds`, `widgetRows` rows, `addedWidgets[].id`). Non-string ids **no-op** rather
than throw, matching the skip-not-throw convention every sibling guard uses. The one place the
package filters rather than rejects is `applyBulkUpdate`'s arrays, where "no-op the bad, keep
the good" keeps a partially-junk payload usable.

The invariant is enforced **uniformly**, not only where a mismatch is currently observable.
Several handlers (`updateWidget`, `renamePage`, `applyBulkUpdate`'s `updatedWidgets[].widgetId`,
and the three `args.pageId` reads) are benign under coercion _today_, because every write they
perform is a bracket assignment through the same coerced key the `Object.hasOwn` read matched —
so read and write agree. That is a property of those bodies, not of the id, and it is one added
`Set.has`/`===`/`.includes` away from silently breaking, which is exactly the history above.
They carry the guard anyway. The three explicit-`pageId` handlers share one resolver,
`resolveTargetPageId(doc, args.pageId)`, which returns the active page for a nullish value (the
legacy pageId-less fallback, preserving the `??` semantics) and `undefined` for any other
non-string — so the caller no-ops instead of handing a number to the coercing existence check.

`renameAIThread` now has the mirror of that resolver, `resolveTargetThreadId(ai, args.threadId)`,
with the identical three-state shape: nullish falls back to `ai.activeThreadId`, a string passes
through, anything else yields `undefined` and the handler no-ops. Written out inline, the same
`args.threadId ?? activeThreadId` expression handed a non-string straight to the `t.id === threadId`
scan — which can never match, so the mutation silently did nothing with no way to tell it apart from
an unknown id.

### Prototype-hazard keys

`UNSAFE_KEYS` (`'__proto__'`, `'constructor'`, `'prototype'`) and `isSafeKey` live in their own
module so no boundary can drift into an independently-maintained literal list. Two distinct hazards, guarded separately:

1. **A record KEY written from untrusted input.** `record[key] = value` with `key === '__proto__'`
   invokes the inherited setter and rewrites the record's prototype instead of adding an own key.
   Every key-by-key `Record` rebuild in the package screens with `isSafeKey`, and the two
   load-boundary `widgets` rebuilds (`docScreening.ts`'s `screenWidgets` and
   `statePersistence.ts`'s legacy-leaf-shape pass) plus the load-boundary `pages` rebuild
   (`applyMutation.ts`'s `normalizePersistedPages`) all use `Object.fromEntries` over surviving
   entries rather than bracket assignment for the same reason.
2. **An own DATA property named one of the three.** `JSON.parse('{"__proto__":…}')` produces
   exactly this. It round-trips through `serializeDoc` and then poisons a later
   `Object.assign`/spread. `hasUnsafeOwnKeys` screens for it symmetrically at every
   boundary, on the widget object, the filter object, the nested `filter.scope`, the page
   object, and every config channel — including, on the REDUCER boundary, `addWidget`'s
   handler and `applyBulkUpdate`'s `addedWidgets` admission (`isInsertableAddedWidget`),
   which screen the widget object's own keys in addition to its `config`'s.

Note the asymmetry in the response: `dashboard` and the `ai` container have their unsafe own
keys **stripped** (keeping the rest); a widget, page, filter, relationship, expression field,
thread, or preset-inner filter carrying one is **dropped whole**. The preset-inner-filter screen
is the sharpest case — `applyFilterPreset` rematerializes preset filters into live `doc.filters`,
so an unscreened one would land on a live filter the next load then drops entirely.

Both `Object.hasOwn` (never `in`) and lookups through a `Set` are used for the same reason
everywhere a table is indexed by untrusted input: `MUTATION_HANDLERS`, the validator table,
`BUILTIN_WIDGET_DEFAULTS`, `getAllowedConfigKeys`, `CHART_TYPE_CONFIG_KEYS`,
`MERGEABLE_WIDGET_CHANGE_KEYS`, `STUDIO_RELATIONSHIP_TYPES`.

#### A prototype-member-named id is not the same thing as a hazard key

This distinction is re-litigated often enough to be worth stating outright, because the two halves
have **opposite** answers and a plausible-sounding argument gets the second half wrong.

- **A page/widget id that merely names an `Object.prototype` member — `toString`, `valueOf`,
  `hasOwnProperty`, `isPrototypeOf` — is KEPT, everywhere.** That is precisely what converting
  every table read to `Object.hasOwn` bought. Nothing resolves such an id up the chain any more,
  so there is no reason to drop a user's page or widget over it, and no boundary does. This is
  also why `isSafeKey` is a **three-name denylist** and not "reject anything that appears on
  `Object.prototype`" — the latter would be over-broad and would cost real data.
- **An id that IS one of the three `UNSAFE_KEYS` is DROPPED, everywhere.** All four boundaries
  agree, and have to: the wire boundary rejects it (`parseStateMutation`'s `isValidId`), the
  reducer refuses to mint it (`addPage`'s and `addWidget`'s `isSafePatchKey` gates), the
  persistence loader drops it (`normalizePersistedPages`, `screenWidgets`), and the factory drops
  it (`screenPagesShape`, `screenWidgets`).

Note that `'constructor'`/`'prototype'` cannot actually pollute anything through these particular
rebuilds — they all use `Object.fromEntries` or spread, which are define-semantics. Their
membership is denylist policy, not a live vector: they travel with `'__proto__'` so that one
predicate covers every channel and no boundary has to reason about which of the three it is
looking at.

**The tradeoff, stated rather than implied: dropping is silent data loss** for a hand-authored or
foreign doc that legitimately names a page/widget `constructor`. It is accepted because the
alternative is worse in the specific way this package keeps getting bitten by — _deferred_ data
loss. Until round 3 the factory (`createDefaultStudioState`) was the one producer with no `pages`
screen at all, so an `initialState` naming a page `constructor` installed it, rendered it, let the
user edit it, and then lost it on the first save/reload when `normalizePersistedPages` swept it —
with no error anywhere. One consistent answer at four boundaries beats three different ones. If
this policy is ever revisited, it has to be revisited at **all four boundaries at once**, plus the
`x-studio` controller tests that mirror them.

### `isPlainRecord` — the one "is this a usable bag" predicate

Every trust boundary routes through `internalGuards.ts`'s `isPlainRecord`, so a tightening lands
everywhere at once. It requires `typeof value === 'object'`, non-`null`, non-array, **and** a
prototype of exactly `Object.prototype` or `null`.

The prototype clause matters because the first three clauses are all true for an exotic object —
a `Date`, `RegExp`, `Map`, `Set`, or class instance. Downstream every passing value is treated
as a plain data bag (spread, key-screened, read by arbitrary string key), so an exotic object was
silently **laundered** into an empty-looking record (`{ ...new Map([['a', 1]]) }` is `{}`),
discarding whatever it carried with no error anywhere. The tightening changes nothing for the
values the predicate was ever meant to accept: every object literal and every `JSON.parse` output
already has `Object.prototype`, and an explicit `Object.create(null)` bag is accepted too.

"Every trust boundary" was one short until recently: `statePersistence.ts`'s
`validateStateStructure` kept a hand-rolled `!state || typeof state !== 'object'`, which is true
for an ARRAY and for every exotic object — so its `state is Record<string, unknown>` predicate
narrowed values that are not plain records. It never produced a wrong ANSWER (an array fails
`findMissingRequiredField` on the very next line, for a missing `"dashboard"`), but an unsound
predicate is a trap for the next reader and a hand-rolled one cannot receive the next tightening.
It now delegates like everything else.

The last hand-rolled holdout was `normalizePersistedPages`' per-page value check
(`page === null || typeof page !== 'object' || Array.isArray(page)`), and unlike the one above it
DID produce a wrong answer. The factory's `pages` screen (`screenPagesShape`) routes through
`isPlainRecord`, so a page value that is an exotic object — a class instance with own
`id`/`title`/`widgetRows` data properties — was **dropped by the factory and kept by the loader**,
for byte-identical input. Nothing downstream repaired it either: the sweep's rebuild is skipped
exactly when `id` already matches the record key and `title`/`widgetRows` already look valid, so
the instance was embedded into `doc.pages` **by reference**, then spread by `withSpans` and
re-serialized as if it were a plain bag. It now delegates too, which is what makes the page channel
match the widget channel (`screenWidgets`, whose own `isPlainRecord` bypass was closed earlier) and
the factory.

### Reference-equality no-op contract

**Every** handler and helper returns its input reference unchanged when nothing changed. This is
not just memoization: `StudioController`'s `commitDocPatch` pushes an undo-stack entry only when
the doc reference changes, so a handler that skipped this check would make a re-delivered or
already-satisfied mutation (an SSE retry of `set_active_page`, say) a visible no-op on the very
next Ctrl+Z.

Two comparison helpers exist because `enforceLayoutColSpans` mints a fresh object even when its
contents are unchanged: `rowsEqual` and `spansEqual` (an `undefined`-tolerant wrapper over the
same `shallowRecordEqual` core, so the two can never drift apart). `shallowRecordEqual` is
key-count plus per-key `===`, so a re-supplied but reference-different nested value (a fresh
`ySeries` array) still counts as a change.

The two **merge**-shaped handlers — `updateWidget`'s `changes` and `applyBulkUpdate`'s
`updatedWidgets` — extend this to "did this attempt a write" vs "did this actually change
anything": each incoming field is compared against the widget's current value before the widget
is rewrapped, so a `changes: { title: 'Same' }` on an already-`'Same'` widget returns the SAME
state reference.

Per-field comparison alone is not sufficient for `updateWidget`, because its five layered steps
can each rewrap the widget and then have that write **reversed by a later step in the same
mutation** — the kind-coherence screen stripping exactly the config key the patch loop just
installed is the canonical case. Its closing check therefore compares the final widget against
the original by VALUE (`widgetsValueEqual`, shared with `applyBulkUpdate.addedWidgets`' replace
path) rather than by identity. `widgetsValueEqual` is shallow, so a re-delivery whose nested
config value is re-created by `JSON.parse` still compares unequal and is conservatively treated
as a change — the same documented limit `shallowRecordEqual` carries everywhere else.

### Cascade pruning is a per-CLASS invariant

`StudioFilterState.dependsOn` lists the other filter ids a filter cascades from. Its own doc
comment calls it "purely a UX hint", but the client's cascade drawer maps over it directly, so a
dangling id silently gates option-narrowing on a filter that no longer exists — and `serializeDoc`
re-persists the dangling reference forever with no self-heal.

The rule: **every path that drops a filter prunes `dependsOn` against the survivors.**
`pruneDependsOn(filters, survivingIds)` is the ONE implementation, exported from
`applyMutation.ts` (not from `index.ts`) so the load boundary uses identical code. The
file-private `pruneDependsOnAgainstSelf(filters)` wrapper covers the common "some filters were
just dropped from this array" shape; the exported primitive keeps its explicit
surviving-id-set signature for the load boundary, which computes the set itself.

It drops the whole `dependsOn` array (never leaves `dependsOn: []`) when the prune empties it,
mirroring `docTransforms.ts`'s convention for this exact field, and is reference-stable at both
levels — the same array back when nothing needed pruning, and each untouched filter keeps its
object identity. "Drops" means the KEY is `delete`d on the rebuilt filter, not spread as an
explicit `dependsOn: undefined`: an own key with an `undefined` value still answers
`Object.keys(filter)` and `'dependsOn' in filter`, so the in-memory shape would differ from a
filter that never carried one. `deserializeState`'s `activeThreadId` reconciliation preserves
the same distinction the same way.

The prune began life INLINE in `removeFilter`, which is exactly why it covered one filter-dropping
path and no other. Extracting it turned the invariant from something each handler had to remember
into something the shared primitives enforce. The paths are: `removeFilter`,
`dropWidgetScopedFilters` (via `removeWidget`/`applyBulkUpdate`), `removePage`'s page-anchor drop,
`dropConflictingRankFilters`, the whole load-boundary filter screen, and — the one this list used
to omit — **`serializeDoc`'s cross-filter/interactive strip.**

That last one is a drop path like any other, and omitting it cost a user-authored cascade on every
reload. `serializeDoc` removed the session-scoped entries but left the survivors' `dependsOn`
pointing at them; `deserializeState`'s own prune, which runs against the ids the LOADED array
carries, then deleted those references for good:

```text
live        f1.dependsOn = ['x1', 'f2']   (x1 = a cross-filter entry)
serialized  f1.dependsOn = ['x1', 'f2']
loaded      f1.dependsOn = ['f2']
```

Pruning at serialize time makes the written doc self-consistent, so what a reload restores is what
was written rather than what survived a second, later prune.

### "At least one page always exists"

A zero-page doc is unrecoverable. Every legacy pageId-less mutation
(`addWidget`/`setWidgetLayout`/`setWidgetColSpan` without an explicit `pageId`) resolves its
target through `Object.hasOwn(pages, dashboard.activePageId)`, which no id satisfies once the map
is empty — so the dashboard renders nothing and silently no-ops every edit forever, with no error
and no affordance to recover.

All three producers of a doc uphold it, each in the way its own constraints allow:

- **`removePage`** refuses to delete the last page. Synthesizing a replacement was rejected: a
  fresh page needs a fresh id, and this reducer must stay DETERMINISTIC so the server-threaded
  state and the client-applied state cannot diverge. A caller that wants an empty dashboard adds
  the replacement page first.
- **`deserializeState`** synthesizes the factory's default page when its sweep empties the map
  (`normalizePersistedPages` legitimately drops pages for an unsafe key or a non-record value).
  The loader has no determinism constraint and already mints replacement values for other missing
  required fields, so the repair belongs here.
- **`createDefaultStudioState`** falls back to the default page when a `doc.pages` override is
  empty — reachable from the public `Studio initialState` prop.

This makes `activePageId: ''` unreachable, and the `?? ''` arms of both fallbacks are retained as
total fallbacks rather than swapped for non-null assertions.

### Alias normalization on every live write

`normalizeChartSeries` collapses the deprecated `seriesType` alias into the canonical `type`.
`deserializeState` normalizes it at the load boundary; without a write-time pass too, a widget
written with `seriesType` would carry the alias until the next reload. The file-private
`normalizeConfigChartSeries(config)` therefore runs on **every** path that installs or merges a
chart config: `addWidget`, `updateWidget`'s `config` patch and its `changes.config` wholesale
replacement, and `applyBulkUpdate`'s `addedWidgets` inserts and `updatedWidgets[].config` merges.
Reference-stable when every entry is already canonical.

## Function modules

### `factories.ts`

- **`makeIdFactory(prefix)`** (file-private) builds a collision-resistant id minter:
  `${prefix}-${Date.now()}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`.
  Three components, each load-bearing — the millisecond timestamp, a per-factory monotonic
  `sequence` (deterministically unique within one process, even under a tight same-millisecond
  loop), and a random suffix (so ids minted independently by client and server don't collide).

  A millisecond-only scheme would collide whenever two ids were minted in the same millisecond,
  and every id below becomes a `Record` map key: a collision silently overwrites a `state.widgets`
  or `state.pages` entry, or — for a filter id — makes a genuinely-new filter look like a
  re-delivery and get dropped as a no-op by `addFilter`'s idempotency check.

- **`createWidgetId`/`createPageId`/`createPresetId`/`createFilterId`/`createMutationId`** are
  thin `makeIdFactory(prefix)` calls, so the scheme is implemented once instead of five
  hand-copies. Each owns an independent counter, so ids from different domains never share a
  sequence.

- **`createIdFactory(prefix)`** is the public generic escape hatch onto the same helper, for
  ad-hoc client-side entities that don't warrant a dedicated named factory (a chart annotation, a
  manually-created relationship). Mint one factory per entity type at module scope, exactly as
  each named factory does. Prefer adding a dedicated `create<Entity>Id` when the entity becomes a
  `Record` map key.

- **`createMutationEnvelope(mutation)`** is the one place a `state-mutation` SSE event's envelope
  is built (fresh `id` + `at: new Date().toISOString()`), so every producer stamps identically.

- **`createDefaultWidget(kind, overrides?)`** — the single factory both the UI ("Add widget"
  drawer) and the AI (`addWidget` tool) call, so UI-created and AI-created widgets start from
  identical defaults and always get an id via `createWidgetId()`. Generic over `K`, so
  `createDefaultWidget('grid')` returns a `StudioWidgetOf<'grid'>` with a narrowed `config`.

  It dispatches through `BUILTIN_WIDGET_DEFAULTS`, a **factory-function-per-kind** table (not a
  plain object table) typed against the per-kind config type, so a mutable default like `grid`'s
  `config.columns: []` gets a fresh array on every call rather than being shared by reference.
  Membership is tested with `Object.hasOwn`, so an untrusted kind like `'constructor'` is treated
  as custom rather than invoking `Object.prototype.constructor` as a defaults factory. Because
  the table is a `Record` over `BuiltinStudioWidgetKind`, a new built-in kind without an entry is
  a compile error. `overrides.customConfig` is threaded into a built-in kind's config too, not
  just the custom-kind branch.

- **`normalizeGridColumn(col)`** — a persisted grid column may be a bare field-name string or a
  full `StudioGridColumn`; this normalizes to the object shape.

- **`normalizeChartSeries(series)`** — the same pattern for a series' render kind, which may be
  persisted under the canonical `type` or the deprecated `seriesType` (`type` wins when both are
  present). Total over junk: a `null`/non-object entry (reachable via the unvalidated config
  leaf) is returned unchanged rather than throwing on the `.type` read. Reference-stable when the
  series is already canonical, since churning identity on every read would defeat memoization in
  chart widgets that key off series identity. A NULLISH `seriesType` with no canonical `type`
  resolves to nothing and the result OMITS `type` — the contract is that the result expresses the
  render kind through `type`, and `null` is not a render kind.

- **`createDefaultStudioState(overrides?)`** — builds the default state: one page, no widgets,
  `session.mode: 'edit'`, data/compose drawers open, empty `runtime.dataSources`.

  `overrides` is a `CreateDefaultStudioStateOverrides` bag partitioned by lifetime
  (`{ doc?; session?; runtime? }`), deliberately nested rather than flat so callers name the
  partition explicitly. A flat bag would need a hand-maintained field-routing table — exactly the
  fragility the lifetime partition exists to eliminate.

  The merge is intentionally asymmetric: `doc.dashboard` and `session.shell` (including
  `shell.openDrawers`) are deep-merged so a partial override doesn't clobber siblings; every
  other field replaces its default wholesale. `schemaVersion` is the one field an override can
  never supply — it is stamped from `CURRENT_SCHEMA_VERSION` after the spread, matching every
  other doc producer.

  The `doc` bag then goes through `screenDoc`, and three post-merge reconciliations run once the
  page map is final: the default-page fallback for an empty `doc.pages` override (see
  ["at least one page"](#at-least-one-page-always-exists)), the `dashboard.activePageId` fallback
  to the first page id when it is not a string or names no page (the same fallback `removePage`
  uses), and the shared `dedupeRankFilters` rank-uniqueness sweep. All four behaviours mirror the
  load boundary — see [the four trust boundaries](#the-four-trust-boundaries) for each one's
  failure mode and for the two load-boundary options the factory deliberately does not take.

### `anomalyDetection.ts`

`detectAnomaliesIQR(values)` — Tukey IQR outlier detection, returning a `Set<number>` of
anomalous _indices_ into `values`, shared so the AI's `summarise_page` tool and the chart
widget's client-side detection agree.

- **Non-finite values are filtered out first** (keeping each survivor's original index). A single
  `NaN`/`Infinity` — which row data reaching `summarise_page` can carry — would poison
  `toSorted`'s comparator, making `q1`/`q3`/`iqr` and every fence `NaN`, so every comparison is
  `false` and the series silently reports no anomalies. The returned `Set` still indexes into the
  caller's original array.
- **Fewer than 4 finite values** ⇒ no anomalies (too few points for a meaningful quartile split).
- **A degenerate spread** (`iqr <= epsilon`, not just `iqr === 0`) does not bail out. The fence
  formula collapses to a single point, which is still a meaningful comparison, so the function
  falls through to flagging every finite value that differs from the constant. Returning an empty
  `Set` was a false negative for `[5, 5, 5, 5, 5, 5, 5, 1000]` — an obvious spike against a
  constant baseline.
- That "differs from" comparison is **epsilon-relative**: `Math.max(Math.abs(q1) * 1e-9, 1e-9)`,
  a tolerance scaled to `q1`'s own magnitude with an absolute floor for a `q1` at or near zero
  (where a relative tolerance would collapse to 0 and stop tolerating anything). A bare
  `value !== q1` would flag the last value of `[100, 100, 100, 100, 100.0000001]` purely on
  upstream floating-point jitter. The same `epsilon` gates both the branch selection and the
  per-value comparison, so the two can't disagree.

`median` (a sorted-input helper) stays file-private: it has no consumer outside this file, and
its pre-sorted-input contract is a footgun not worth exposing.

### `temporalUtils.ts`

Date-bucketing math shared by the client (`internals/temporalUtils.ts`'s
`truncateToGranularity` delegates here) and the AI middleware (`mcp/dataTools.ts` imports
`truncateToPeriod` for its `x-axis` grouping), so chart date-bucketing and `summarise_page`
grouping always agree on where a period boundary falls.

- **`isoWeek(d)`** — the ISO week number (1–53) for a UTC `Date`, as `{ year, week }`. It shifts
  to the Thursday of the same ISO week first, so a date near a year boundary reports the ISO year
  its week actually belongs to (Dec 31 2024 is ISO week 1 of 2025).

- **`truncateToPeriod(value, granularity)`** — truncates a date-like value to
  `'day' | 'week' | 'month' | 'quarter' | 'year'`, returning a sort-stable key (`'2024-01-15'`,
  `'2024-W03'`, `'2024-01'`, `'2024-Q1'`, `'2024'`) or `null` when the value can't be parsed or
  the granularity is unrecognized. It accepts `Date` instances, ISO date/datetime strings, other
  `Date`-parseable strings, and millisecond timestamps.

Three sharp edges, all handled by private helpers:

- **Two-digit years.** `Date.UTC` (and the multi-arg `Date` constructor) silently reinterprets a
  `year` in `[0, 99]` as `1900 + year`, so a year-50 date would report its ISO year as 1950.
  `utcDateFromYMD` sidesteps this by constructing off a placeholder epoch and re-stamping via
  `setUTCFullYear`, which takes the year literally at any magnitude. Both `isoWeek` and the
  `week` branch use it, and `padYear` zero-pads every emitted key's year to at least 4 digits so
  a low year doesn't collide with or mis-sort against a 4-digit one.
- **The fast path.** `toUtcYMD` slices canonical, offset-free `YYYY-MM-DD`/`YYYY-MM-DDTHH:…`
  strings directly (range-checking the components so a malformed `2024-13-40` falls through), and
  falls back to `new Date(value)` otherwise — slicing an offset-carrying string's _written_
  components would bucket it into the wrong UTC day.
- **Deciding "offset-carrying"** uses a regex ANCHORED to the end of the post-date tail,
  `/[+-]\d{2}:?\d{2}$/`. A real UTC offset always trails the time-of-day with nothing after it.
  A bare `.includes('-')` test treated a hyphen ANYWHERE in the tail as an offset, contradicting
  the helper's own documented "a non-offset garbage tail is ignored" behavior: `'2024-06-01Tgarbage-more'`
  fell through to the slow path, which can't parse it either, and the function returned `null`
  instead of the documented best-effort `'2024-06-01'`.

### `unsafeKeys.ts`, `wireLimits.ts`, `internalGuards.ts` and `docScreening.ts`

All four are package-internal (absent from `index.ts`) and exist purely so their guards have
exactly one implementation across every trust boundary.

- **`unsafeKeys.ts`** — `UNSAFE_KEYS`/`isSafeKey`. Imported by `applyMutation.ts` (as the local
  `isSafePatchKey` alias), `parseStateMutation.ts` (behind `isSafeId` and `hasUnsafeOwnKeys`),
  `internalGuards.ts` (`stripUnsafeOwnKeys`), and `docScreening.ts` (screening persisted
  `pages`/`widgets` record keys, shared by `statePersistence.ts` and `factories.ts`). See
  [prototype-hazard keys](#prototype-hazard-keys).
- **`wireLimits.ts`** — `MAX_ARRAY_LENGTH`/`MAX_STRING_LENGTH`, the wire trust-boundary size caps.
  Zero-dependency, mirroring `unsafeKeys.ts`. `parseStateMutation.ts` imports them for every
  shape-and-size leaf predicate it defines (`isStringArray` and friends); `internalGuards.ts`
  imports the SAME two constants for `repairFilterDependsOn`'s size cap, so the reducer/load
  boundary's `dependsOn` repair (reachable by a server-built `addFilter` that bypasses the wire
  parser, and by a persisted/shared doc) enforces the identical bound the wire boundary does,
  rather than an independently-declared (and driftable) one.
- **`internalGuards.ts`** — `isPlainRecord` (see
  [above](#isplainrecord--the-one-is-this-a-usable-bag-predicate)), `stripUnsafeOwnKeys`, and
  `repairFilterDependsOn`. It began as a pure dedup of three helpers previously defined
  independently in `applyMutation.ts`, `parseStateMutation.ts`, and `statePersistence.ts`. It
  earned its own test file once `isPlainRecord` gained a rule of its OWN (reject an exotic
  object) rather than being a byte-for-byte relocation of three call sites' checks: no call-site
  test naturally constructs a `Map` where a config is expected.
- **`docScreening.ts`** — the per-ENTRY screens a `StudioDoc` must pass before it becomes live
  state: `screenDashboard`, `screenPagesShape`, `screenWidgets`, `screenFilters`,
  `screenRelationships`, `screenExpressionFields`, `screenFilterPresets`, `screenAIState`,
  `screenOptionalWidgetScalars`, and the `screenDoc` roll-up over a partial doc. Shared by
  `statePersistence.ts` and `factories.ts` — see
  [the four trust boundaries](#the-four-trust-boundaries) for why the factory needs them and which
  two load-boundary behaviours it deliberately does not take.

  **Import-cycle constraint, load-bearing:** this module must not import `factories.ts`,
  `applyMutation.ts` or `statePersistence.ts`, because `factories.ts` imports it. That is why the
  load boundary keeps three things of its own rather than moving them here — the legacy leaf-shape
  normalization (`normalizeGridColumn`/`normalizeChartSeries`, a persisted-shape concern rather than
  a screen), `normalizePersistedPages` (which needs `applyMutation.ts`'s layout machinery — only
  its shape-only subset lives here, as `screenPagesShape`), and the `dashboard.activePageId` /
  `ai.activeThreadId` reconciliations (which need the FINAL page map, assembled differently by each
  caller).

  **Reference stability is per ENTRY, not per container.** A surviving well-formed entry keeps its
  object identity, which is what the memoization downstream of a load actually depends on; the
  CONTAINER is not always the same object. `screenWidgets` rebuilds through `Object.fromEntries`
  and `screenFilters` through `.map().filter()` on every call, so both hand back a fresh
  record/array even when nothing was dropped or repaired. The screens that DO return their input
  container untouched in the clean case say so individually (`screenDashboard`,
  `screenOptionalWidgetScalars`). Where whole-array stability matters it is arranged by the
  CALLER, not the screen — `deserializeState`'s `pruneDependsOn` and the shared
  `dedupeRankFilters` both return the same array they were given when nothing changed.

### `rankFilterScope.ts`

`resolveRankFilterPageId`, `hasConflictingRankFilter` and the array-wide `dedupeRankFilters`. See
[rank-filter uniqueness](#rank-filter-uniqueness) for the semantics; this section is about why they
live in a module of their own.

All three began inside `applyMutation.ts`, beside the handlers that enforce the invariant. That home
made them unreachable from `factories.ts` — the factory-overrides trust boundary — because
`applyMutation.ts` imports `factories.ts` for `normalizeChartSeries`, so the arrow cannot run both
ways. The factory was therefore the one producer of a doc that could not re-check rank uniqueness,
and an `initialState` carrying two conflicting rank filters installed both.

Splitting them out works because they need **nothing at runtime**: `StudioDoc['pages']` and
`StudioFilterState` are type-only imports, so the module is dependency-free by construction and
every boundary can import it. That is the general escape hatch for this class of constraint, and
it is why the `pages` gap above is genuinely harder — `normalizePersistedPages` pulls in the
row/span layout primitives, not just types.

`dedupeRankFilters` returns `{ filters, changed }` rather than baking in what to do next, because
the callers differ: the reducer and the load boundary cascade the drops into the survivors'
`dependsOn` via `pruneDependsOn` (which lives in `applyMutation.ts`, out of this module's reach),
while the factory takes the array as-is. All three share the loop, so the predicate and the
array-order tie-break cannot drift.

### `applyMutation.ts` — the single mutation reducer

#### The two layers

- **`applyDocMutation(doc: StudioDoc, mutation): StudioDoc`** is the semantic core. Confining it
  to `doc` is a **compile-time access boundary**: a handler literally cannot reach `session` or
  `runtime`, because those fields don't exist on `StudioDoc`. The "reducer only touches the
  persisted/undoable partition" rule is enforced by the type system, not by convention. (Handler
  bodies still name their parameter `state` for historical reasons; its type is `StudioDoc`.)
- **`applyMutation(state: StudioState, mutation): StudioState`** is the thin wrapper: it applies
  the core to `state.doc` and rewraps, leaving `session`/`runtime` untouched by construction, and
  returns the SAME `state` reference when the doc is unchanged.

Both transports use it for the state-transformation step — the AI middleware's
`executeToolOnState.ts` threads `nextState` across tool calls in a turn (and, for MCP, a whole
session), and the client's `StudioController.applyExternalMutation` applies the identical
function when a `state-mutation` SSE event arrives. Because it is the _one_ implementation of
every mutation's effect, the server-threaded state and the client-applied state cannot disagree
about what a tool call did.

Side effects a pure reducer cannot own — undo-stack management, title inference from live data
sources, React shell selection — stay in `StudioController` on the client.

#### Dispatch shape

Rather than two parallel `switch` statements (one for the state transition, one for a
human-readable label), the reducer is a single dispatch table:

```ts
type MutationHandler<M extends StateMutation> = {
  apply: (doc: StudioDoc, args: M['args']) => StudioDoc;
  label: (args: M['args']) => string;
};

const MUTATION_HANDLERS: { [M in StateMutation as M['type']]: MutationHandler<M> } = {
  /* one entry per mutation kind */
};
```

Each of the 14 kinds (`addPage`, `setDashboardTitle`, `addWidget`, `updateWidget`,
`removeWidget`, `setWidgetLayout`, `setWidgetColSpan`, `renamePage`, `removePage`,
`setActivePage`, `addFilter`, `removeFilter`, `applyBulkUpdate`, `renameAIThread`) has one entry
co-locating `apply` and `label`, so the two can never drift the way two switches could. The
mapped type over `StateMutation` makes a new variant without an entry a compile error.

The dispatch boundary is **total over malformed input**, in three layers:

1. `isPlainRecord(mutation)` — a `null`/primitive `mutation` would throw on the `mutation.type`
   read below.
2. `Object.hasOwn(MUTATION_HANDLERS, mutation.type)` before the bracket read. `MUTATION_HANDLERS`
   has an ordinary prototype, so a bare bracket read of `type: 'constructor'` would resolve
   `Object.prototype.constructor` and call `Object.apply(doc, args)`, replacing the whole doc with
   a bogus `{}`; `'__proto__'`/`'valueOf'` would throw mid-apply.
3. `isPlainRecord(mutation.args)` — every handler's first field read (`args.rows`, `args.widget`,
   …) would throw on a non-record `args`.

All three fall through to the documented graceful no-op: `applyDocMutation` returns the unchanged
`doc`, and `mutationLabel` returns `'unknown'` (for a non-record mutation) or
`String(mutation.type)`. The `String(...)` matters: `mutation.type` is only KNOWN to be a string
for a RECOGNIZED type, and this is by definition the unrecognized branch, so a `type: 42`/`null`
would otherwise be returned raw and violate `mutationLabel`'s own `: string` contract for callers
that use the result as a log line, a React child, or a `.slice()` target.

`MUTATION_TYPES` (the table's keys) is exported so a runtime test can pin that
`parseStateMutation`'s validator table covers exactly the reducer's variant list — the mapped
types already guarantee it at compile time, but this turns it into an observable assertion.

#### Shared removal and layout primitives

Several handlers converge on file-private helpers. All return their input references unchanged on
a no-op.

| Helper                                         | Responsibility                                                                                                                                  |
| :--------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `dropWidgetScopedFilters`                      | Drop `widget`/`interactive`/`cross-filter` filters anchored to any removed widget                                                               |
| `pruneDependsOn` / `pruneDependsOnAgainstSelf` | The SOLE `dependsOn` cascade prune (see [cascade pruning](#cascade-pruning-is-a-per-class-invariant))                                           |
| `removeSpanEntries`                            | Prune `widgetColSpans` entries (`isSafeKey`-screening every surviving key), collapsing an emptied map to `undefined`                            |
| `withSpans`                                    | The SOLE way a page's `widgetColSpans` is installed — writes the map, or DELETES the key when it is `undefined`                                 |
| `stripWidgetIdsFromPages`                      | Strip a set of ids from every page's rows, dropping an emptied row and clearing a surviving row-mate's stale span when the row collapses 2+ → 1 |
| `dedupeLayoutRows`                             | The SOLE layout-matrix dedup — first occurrence wins across the whole matrix, dropping any row it empties                                       |
| `enforceLayoutColSpans`                        | The SOLE col-span invariant pass (2→1 collapse, row-overflow drop, orphaned-span drop)                                                          |
| `rebalanceRowSpans`                            | Fit ONE row's spans inside `GRID_COLS` around the widths a mutation explicitly asked for                                                        |
| `removeWidgetIds`                              | The "genuinely gone" removal primitive (below)                                                                                                  |
| `dropConflictingRankFilters`                   | The shared `dedupeRankFilters` sweep plus the `dependsOn` cascade (see [`rankFilterScope.ts`](#rankfilterscopets))                              |
| `normalizePersistedPages`                      | The load-boundary layout sweep (documented under [`statePersistence.ts`](#statepersistencets--the-persistence-boundary))                        |

**`withSpans(page, spans, overrides?)`** is what makes "drops" mean the same thing for
`widgetColSpans` that it means everywhere else in this file. `removeSpanEntries` and
`enforceLayoutColSpans` both correctly collapse an emptied map to `undefined`, but their callers
then re-materialized it as an own key via `{ ...page, widgetColSpans: nextSpans }` — contradicting
this file's own stated rule (see [`pruneDependsOn`](#cascade-pruning-is-a-per-class-invariant):
"drops" means the KEY is `delete`d, never spread as an explicit `undefined`), so `Object.keys(page)`
and `'widgetColSpans' in page` both still reported a span map on a page that has none. All **eight**
install sites now route through this one helper, across six handlers/helpers:
`stripWidgetIdsFromPages`, `removeWidgetIds`, `normalizePersistedPages`, `setWidgetLayout`,
`setWidgetColSpan`, and **both** of `applyBulkUpdate`'s (its pre-strip span prune and its layout
rebuild). Counting by HANDLER rather than by call site is what let the claim stand while it was
false: `applyBulkUpdate`'s pre-strip prune still did the bare
`{ ...strippedActivePage, widgetColSpans: spansPruned }`, and `removeWidgetIds`' later pass never
healed it because that pass short-circuits on `if (!spans) return spans`. Nothing observes the
difference today only because `JSON.stringify` erases it at the persistence boundary — which is
exactly why it needed a structural fix rather than eight remembered ones.

**`removeWidgetIds(pages, widgets, filters, candidateIds)`** takes `pages` already carrying the
caller's row edits, computes which candidates are _genuinely gone_ — no longer referenced on ANY
surviving page — then deletes them from `widgets`, drops their scoped filters (cascading into
`dependsOn`), and prunes their stale spans everywhere. A candidate still referenced on another
page is fully preserved.

That "genuinely gone" step is load-bearing for **`removePage` alone**: it hands in `pages` with
the removed page deleted but every surviving page's rows untouched, so a widget that also lives
elsewhere must keep its entry, filters, and spans. The other two callers pre-strip the candidate
ids from ALL pages first, so for them the step is inert by construction — deliberately, since
both delete the widget from `doc.widgets` outright and leaving it on another page's rows would
strand a dangling reference. The step is kept rather than pruned as two-thirds-dead code because
it IS the whole contract for `removePage`, and is the correct default for any future caller that
does not pre-strip.

It also rebuilds the `widgets` record **only when at least one removed id is an own key**. A
re-delivered removal bulk (SSE is at-least-once) whose `removedWidgetIds` names an already-gone
widget classifies it as genuinely removed, yet a `{ ...widgets }` + no-op `delete` would mint a
fresh, content-identical record — flipping the caller's `widgetsChanged` gate and pushing a
spurious undo entry.

#### The column-span unit system

`GRID_COLS = 24` and `MIN_SPAN = Math.round(GRID_COLS / 4)` (= 6) are the **single source of
truth** for widget widths, and they live here because the dependency arrow runs `x-studio` →
`x-studio-schema`. `canvasGridConstants.ts` (what the canvas drag-resize handle renders against)
and `StudioController` both **import** these exact values rather than re-declaring them, and a
round-trip test in `@mui/x-studio` pins that a drag-resize and an AI resize agree on the units.

`clampSpan` clamps to `MIN_SPAN`–`GRID_COLS`, rounding non-integer input and guarding non-finite
input (`NaN`/`Infinity` from a malformed payload clamps to `MIN_SPAN` rather than surviving to
serialize as `null`).

**`rebalanceRowSpans(spans, rowIds, anchorIds, canWriteSpan)`** fits one row inside `GRID_COLS`
around the spans a mutation explicitly asked for. `anchorIds` are the members whose width this
mutation is setting; every other member is an ABSORBER whose stored span may be reduced or
cleared. Resolution order:

1. **Anchors overflow on their own** — grant each anchor, in row order, as much of the budget as
   remains, and clear the span of any anchor that cannot be granted at least `MIN_SPAN`.
2. **Exactly one absorber** — it takes the remainder, or loses its span entirely when the
   remainder is below `MIN_SPAN` (a sub-minimum span is not a legal width).
3. **Two or more absorbers** — there is no non-arbitrary way to split the remainder, so all their
   spans are cleared and the row falls back to equal flex.

`canWriteSpan` is a named `CanWriteSpan` type rather than an inline signature so its own parameter
is documented on the callback. A span is only ever written for an id it accepts, so a row-mate
that is not a real widget (or carries a prototype-hazard key) can never receive a persisted span.

Sharing this between `setWidgetColSpan` and `applyBulkUpdate`'s span merge is what makes an AI
`set_widget_width` and an `apply_bulk_update` carrying the same width resolve an overflowing row
identically. Without it the bulk path fell through to `enforceLayoutColSpans`' drop-EVERY-span
rule, so setting one widget's width through the bulk tool erased its neighbor's.

`enforceLayoutColSpans(oldRows, newRows, spans)` is the invariant pass every layout path reaches:

- **2→1 collapse** — a widget left alone in a row it previously shared has a stale
  multi-widget-era span, so the span is cleared. A widget that was _already_ a lone occupant keeps
  its intentional span (for example, an AI `set_widget_width` narrowing). This is why `oldRows` is a
  parameter rather than derived.
- **Row overflow** — a row summing past `GRID_COLS` with no explicit anchor to rebalance around
  has every span dropped, falling back to equal flex.
- **Orphaned span** — a span for a widget no longer in this page's rows is dead weight.

#### Rank-filter uniqueness

Only one `filterMode: 'rank'` (Top-N) filter may occupy a page context. This used to be enforced
only by `StudioController`'s five call sites — a UI-layer convenience, not a contract boundary —
so a caller bypassing the controller could install two. The reducer enforces it directly, through
helpers in [`rankFilterScope.ts`](#rankfilterscopets) that the client's
`internals/rankFilterScope.ts` re-exports rather than hand-syncing, and that
`statePersistence.ts` and `factories.ts` reuse at their own boundaries.

**`resolveRankFilterPageId(filter, pages)` is deliberately THREE-state**, and the three are not
interchangeable:

| Result      | Meaning                                                                                                           |
| :---------- | :---------------------------------------------------------------------------------------------------------------- |
| `string`    | A `page`-scope filter's explicit `pageId`, or the page whose rows currently hold a `widget`-scope filter's widget |
| `null`      | **Applies EVERYWHERE** — a legacy pageId-less `page` filter, active on every page                                 |
| `undefined` | **UNRESOLVABLE** — a `widget`-scope filter whose widget sits on no page's rows, or any non-rank-eligible scope    |

`hasConflictingRankFilter` treats the two sentinels as **opposites**: an unresolvable TARGET
conflicts with nothing (the add is always allowed) and an unresolvable OTHER filter blocks
nothing. Conflating them was a real bug — when `null` meant both, a single unplaced-widget rank
filter (which nothing removes, since `dropWidgetScopedFilters` only fires on widget _removal_)
read as "conflicts with everything" and silently rejected every subsequent rank `addFilter` on
every page. Worse, the load-boundary dedup runs the same predicate in array order, so whenever
the unplaced entry came first it DROPPED the user's legitimate rank filter and the next
`serializeDoc` persisted the loss permanently.

Only `page`/`widget` scopes are rank-eligible. `filterMode: 'rank'` on a `dashboard-date-range`
or `interactive` scope is wire-valid (the wire boundary never restricts `filterMode` by scope
kind) but is not a rank window over a page, and treating it as one made a single such filter
reject every legitimate rank filter dashboard-wide. Both sides enforce the restriction:
`addFilter` skips the gate entirely for those scopes, and `hasConflictingRankFilter`'s
existing-filter loop excludes them too.

**`dedupeRankFilters(filters, pages)`** enforces uniqueness across a whole array, keeping the
FIRST rank filter per page context in array order. It exists because `addFilter` can only gate the
filter it is installing, against the context that filter resolves to AT THAT MOMENT — a later
PLACEMENT can create a conflict after the fact. The reducer wraps it as
`dropConflictingRankFilters`, which adds the `dependsOn` cascade, and three handlers run it:

- **`setWidgetLayout`** and **`applyBulkUpdate`** — placing a widget whose rank filter previously
  resolved to UNRESOLVABLE can drop it onto a page that already has one.
- **`removePage`** — a widget placed on both `p1` and `p2` resolves to `p1` while `p1` exists and
  to `p2` once it does not. `removeWidgetIds` does not cover this: the widget survives on `p2`, so
  its filter survives too, carrying the stale resolution with it.

All three run the same shared sweep as the load-boundary dedup AND the factory's override screen,
so all three boundaries agree at **commit** time on which filter survives. Without them the doc
was live-valid and load-invalid: `deserializeState` silently deleted the user's filter and the next
autosave persisted the loss.

The **factory** runs the sweep too, but at a different point in its own assembly and without the
`dependsOn` cascade — see [`factories.ts`](#factoriests) and
[`rankFilterScope.ts`](#rankfilterscopets).

#### Notable per-handler semantics

Every handler applies the [string-id](#string-ids-the-coercion-desync-class),
[prototype-hazard](#prototype-hazard-keys), and [no-op](#reference-equality-no-op-contract) rules
above; only what is specific to each is listed here.

- **`addPage`** is idempotent: re-delivering an event for an existing `pages[id]` does not reset
  that page's `widgetRows: []` (which would orphan its widgets) — it only re-activates the page. A
  missing/non-string `id` no-ops rather than minting a page keyed `"undefined"` while
  simultaneously setting `activePageId` to `undefined`, which is strictly worse than a no-op.

- **`setDashboardTitle`** and **`renamePage`** require a STRING `title`. A non-string installs with
  no immediate throw but violates the `title: string` shape until something downstream (the
  page-header renderer, a `serializeDoc` round-trip) trips over it.

- **`addWidget`** is idempotent, keyed off the flat `state.widgets` record rather than the target
  page's rows — so a re-delivery can't render a since-moved widget twice. Its explicit
  server-chosen `pageId` (falling back to the active page for legacy payloads) lands the widget on
  the page the model was told about, even if the client has since navigated elsewhere.

  Both widget ADD channels (this and `applyBulkUpdate`'s `addedWidgets`, the latter through the
  shared `isInsertableAddedWidget` predicate) first screen the widget object's OWN top-level keys
  against the prototype-hazard denylist via `hasUnsafeOwnKeys`, dropping the whole widget on a hit
  — symmetric with the wire boundary's `validateWidget` and the load boundary's `screenWidgets`
  (Finding T2-1). A `JSON.parse`-built widget from a server-built mutation that bypasses
  `parseStateMutation` (the `executeToolOnState` path) can materialize a real own `"__proto__"`
  DATA property that an object literal never would; installing it verbatim would otherwise
  round-trip through `serializeDoc` only to be dropped wholesale by `deserializeState`'s widget
  screen on the very next load — deferred data loss, not an immediate crash.

  Both channels then run the same screening pipeline, in order: `coerceWidgetConfig` (a
  non-record `config` → `{}`, plus a strip of the CONFIG's own unsafe keys),
  `screenOptionalWidgetScalars`, then `normalizeConfigChartSeries`. A non-string `kind`/`title`
  skips the entry whole; a non-string `subtitle`/`sourceId`, a non-`'auto'|'manual'`
  `titleMode`/`subtitleMode`, or an unknown `config.chartType` has just its key stripped. That
  matches the load boundary's screens exactly — see
  [the boundary-agreement rule](#the-four-trust-boundaries).

  The `chartType` strip lives INSIDE `screenOptionalWidgetScalars` for that reason. It used to be
  a second block in `screenWidgets` alone, which made the reducer the only one of the four
  boundaries with no `config.chartType` membership screen — and the claim that the add channels
  matched the load boundary "exactly" false by one repair. One payload therefore got three
  answers: the wire boundary REJECTED `config: { chartType: 'trendline' }`, the reducer installed
  it VERBATIM, and the next load STRIPPED the key. Deferred data loss, and the expensive kind: the
  widget renders blank, every later AI `update_widget` hard-errors in `executeToolOnState` on the
  unknown stored chartType, and the widget then silently becomes a bar chart on the next reload.
  The three UPDATE-shaped channels (`updateWidget`'s `config` patch and `changes.config`,
  `applyBulkUpdate.updatedWidgets[].config`) get the same screen through
  `stripInvalidChartType`, a thin wrapper over the wire boundary's own
  `hasInvalidChartTypeInConfig` — the same predicate, not a re-spelled copy, since the two
  boundaries must not disagree about which chart types exist. For the merge-shaped channels the
  strip is applied to the INCOMING patch rather than the merge result, so the widget's existing
  valid `chartType` survives an update that carries a bad one. A `chartType: undefined` still
  performs the sanctioned patch-delete of the key.

  `coerceWidgetConfig` closes a deferred landmine rather than an immediate crash: a `config: null`
  widget renders fine until the next config-touching mutation, where
  `shallowRecordEqual`/`Object.keys` on it throws `Cannot convert undefined or null to object`.

- **`updateWidget`** layers five changes in a documented, load-bearing order:
  1. **A `config` patch** — keys with an explicit `undefined` value are deleted; a non-record
     `config` is treated as ABSENT.
  2. **A shallow `changes` merge onto the widget**, `isPlainRecord`-gated. A `config` key inside
     `changes` **wholesale-replaces** the already-patched config rather than merging with it.
  3. **A kind-coherence reconciliation**, run on **every** config-touching path, against the
     FINAL `updated.kind`: it strips config keys not in that kind's allow-list, reusing
     `getAllowedConfigKeys`. Without it a `changes.kind` flip left the config exactly as
     steps 1–2 produced it — a grid widget still holding a chart-only `xField`, with nothing
     downstream to reconcile the mismatch (`screenWidgets` does no per-kind key check, and
     `serializeDoc` persists it forever). A custom kind (allow-list `null`) and a non-record
     live `config` are both left untouched — the latter guarded by `isPlainRecord` so the step
     repairs or no-ops rather than throwing on `Object.keys(null)`.

     **The SCOPE of the screen depends on whether `kind` changed; that it RUNS does not.** A
     `kind` flip screens the WHOLE config (every key authored under the old kind is foreign
     now). An unchanged `kind` screens only the keys THIS mutation named, tracked across both
     config-touching paths in an `incomingConfigKeys` set — a stored config legitimately
     carries keys retained across a chartType switch (see `StudioChartConfig`'s doc, and the
     wire boundary's matching "preserve, never strip" stance), so an unrelated edit must not
     sweep them, but it must not INSTALL a fresh foreign one either.

     Gating the whole step on `updated.kind !== existing.kind` — what it used to do — made
     one mutation that BOTH flips `kind` and supplies a config non-idempotent in the worst
     direction. First delivery: the gate is true, so it stripped the keys steps 1–2 had just
     installed. Second delivery: `kind` no longer changes, the gate is false, and the SAME
     foreign keys installed **permanently**. Both `{ changes: { kind }, config }` and
     `{ changes: { kind, config } }` reproduced it, and both pass `parseStateMutation`. SSE is
     at-least-once, so that is a routine re-delivery, not an exotic payload — the
     client-applied doc diverged from the server-threaded one and landed in exactly the
     mismatch this step exists to prevent.

  4. **`unsetConfigKeys`** — delete the named keys from the post-merge config.
  5. **`unsetFields`** — delete the named top-level widget keys.

  The closing no-op check compares by **value** (`widgetsValueEqual`), not by identity. Steps
  1–5 can each rewrap the widget and then have their effect reversed by a LATER step in the
  same mutation — step 3 stripping exactly the config key step 1 installed is the canonical
  case — leaving a fresh but value-identical object, and a bare `updated === existing` then
  returned a new doc reference for a mutation that changed nothing. That pushed a phantom undo
  entry on an at-least-once re-delivery, violating the
  [reference-equality no-op contract](#reference-equality-no-op-contract).

  The `changes` merge is **fail-closed on the key itself**: only a member of
  `MERGEABLE_WIDGET_CHANGE_KEYS` (`kind`, `title`, `titleMode`, `subtitle`, `subtitleMode`,
  `sourceId`, `config` — every non-`id` field of `StudioWidgetOf`, held in a `Set`) may land on the
  widget. The allow-list is scoped to this PATCH channel; the full-widget CREATE channels KEEP
  their unknown-key tolerance, which is where the forward-compatibility argument actually applies
  (an older client receiving a newer server's widget must not strip a field it doesn't yet know).
  A patch bag has no such round-trip to preserve, and without the allow-list a
  `changes: { evil: {…} }` round-tripped through `serializeDoc` forever — the wire boundary
  tolerates unknown keys by policy and `deserializeState` never screens them either. It also
  closes an asymmetry: the `config` channel one level DOWN has always been fail-closed via
  `validateConfigKeysForKind`, so a stray key was rejected _inside_ `config` and accepted
  _beside_ it.

  Within the merge, `title`/`kind`/`subtitle`/`sourceId` must be strings and
  `titleMode`/`subtitleMode` exactly `'auto'`/`'manual'`. All four are guarded because they fail in
  three different ways: `title`/`kind` have no fallback (the factory keys off `kind`, the canvas
  card renders `title`) and cost the WHOLE widget at the next load; `subtitle` is rendered as text
  by `StudioWidgetEditDialog` and crashes that render immediately; `sourceId` drives the
  widget-to-data-source lookup and breaks it silently with no self-heal. `changes.id` is rejected
  because `id` is also the `state.widgets` map key — writing it would desync `widget.id` from its
  key and split every id-keyed invariant.

  Unsets are applied **last** so an explicit clear always wins over a set of the same key in the
  same mutation, and both arrays are `isStringArray`-gated rather than truthy-gated: a non-array
  string is also truthy-with-`.length`, so a naive guard iterated it char-by-char and deleted
  single-character keys, while an array-like record threw as non-iterable. The four REQUIRED
  fields are never deletable — the runtime denylist rejects `id`, `kind`, `title`, and `config`
  (clearable via `unsetConfigKeys` only), a backstop that is load-bearing for untrusted input even
  though `OptionalWidgetField` already excludes them at compile time.

  Each of the three rewrap-triggering branches tracks whether it actually changed a key, so an
  effect-free `updateWidget` leaves the widget reference unchanged and pushes no undo entry.

- **`setWidgetLayout`** sanitizes incoming `rows` in one pass — each row must itself be an array
  (`rows: ['w1']` or `rows: [null]` would throw on the per-id `.filter`), each id must be a string
  before the coercing `Object.hasOwn(state.widgets, id)` membership check, and phantom ids are
  dropped. `dedupeLayoutRows` then drops repeats: a duplicated id renders the widget twice
  (duplicate React key in `StudioCanvas`) and double-counts its span in the overflow sum. It
  reconciles spans via `enforceLayoutColSpans`, then re-runs `dropConflictingRankFilters`.

- **`setWidgetColSpan`** derives the row's membership from the target page's **current**
  `widgetRows`, never from `args.rowWidgetIds` — the producer computed that from a turn-start
  snapshot, and it goes stale if the user drags widgets between rows mid-turn. The field is
  consequently no longer consulted at all (it remains on the wire type, still validated per-entry
  by `parseStateMutation`, for compatibility with existing producers).

  A `currentRow` of `undefined` is a **no-op**, covering both ways it happens for the same reason:
  the widget lives on ANOTHER page (writing here persists a dead entry on the wrong page), or it is
  on NO page at all (a span for an unplaced widget is an orphan by the same rule
  `enforceLayoutColSpans` and `normalizePersistedPages` enforce, so the next layout mutation or
  load deletes it — an AI-set width that silently reverts on reload). Collapsing the
  not-yet-placed and wrong-page cases into one rule makes this handler agree with the two sites
  that already enforced it.

  It also no-ops on a `widgetId` absent from `state.widgets`, then clamps the requested span and
  calls `rebalanceRowSpans` with the target as the sole anchor.

- **`removeWidget`** drops the widget from its page's rows (removing an emptied row) and — only for
  the specific row it was removed from — clears a surviving sibling's span when the removal
  collapses that row from 2+ widgets to exactly one (a lone widget fills the row, so a leftover
  multi-widget-era span would render it at the wrong width). The scoping is deliberate: a
  single-widget row can legitimately carry its own stored span, so a pre-existing singleton-row
  span is never touched by an unrelated removal. This is the single-id case of
  `stripWidgetIdsFromPages`. It finishes via `removeWidgetIds`, which drops the widget's entry,
  prunes its spans everywhere, and drops the filters that only made sense while it existed — its
  own `widget`-scope filters and the `interactive`/`cross-filter` filters it emitted (a source
  widget's cross-filter left behind would filter the page with no affordance to clear it).

- **`removePage`** refuses to remove the last page (see
  ["at least one page"](#at-least-one-page-always-exists)), then performs full cleanup mirroring
  `StudioController.removePage`: drop the page; remove every widget that lived only on it (one
  still referenced on a surviving page keeps its entry, filters, and spans); drop the filters that
  no longer have a home — page-scoped filters targeting it and any `cross-filter`/`interactive`
  filter whose `scope.pageId` is the removed page, plus (via `removeWidgetIds`) the widget-anchored
  filters of a genuinely-removed widget; re-run `dropConflictingRankFilters` over the pruned pages;
  and reassign `activePageId` when the removed page was active.

  The page-anchor drop cascades into surviving filters' `dependsOn` HERE rather than being left to
  `removeWidgetIds`, because that primitive short-circuits and returns its input `filters`
  untouched when the page held no exclusively-owned widget.

- **`addFilter`** is idempotent on `filter.id`. Before appending it screens the payload the way the
  widget ADD channels screen theirs, since both are reachable from a parser-bypassing server-built
  mutation: `field` must be a string and `operator`/`operator2` members of the closed
  `StudioFilterOperator` union (via the shared `isStudioFilterOperator`); an unsafe own key is
  stripped from both the filter and its nested `scope`; a malformed `dependsOn` is repaired to
  absent rather than sinking the append. Both repairs are reference-stable, so the common
  wire-validated case appends the SAME object.

  The `operator` membership check matters more than it looks: the client's evaluator **fails open**
  on an unrecognized operator (`default: return () => true;`), so a plausible-but-wrong string like
  `'equal'` renders an active-looking filter chip that filters nothing until the next load drops
  the whole entry.

  It applies the filter as-is, without re-stamping its scope to the applying side's active page —
  the filter already carries its server-chosen target.

  Scope screening runs in **two stages, split by what each boundary can actually know**:
  1. **Wellformedness** is delegated to `isValidFilterScope` — the SAME predicate the wire
     boundary and the load boundary already use — run against the already-stripped/repaired
     filter, so a scope carrying a prototype-hazard own key is repaired rather than dropped.
     Kind membership, the required id fields per kind, `page`'s optional-but-must-be-a-string
     `pageId`, and the size bound all come from that one implementation. Hand-rolling per-kind
     id checks here is what let the three boundaries disagree: this handler once screened only
     `typeof scope.kind === 'string'`, so an **unknown kind** (`{ kind: 'pages' }`) and a
     `dashboard-date-range` **missing its required `sourceId`** both installed live. The first
     then escaped every cleanup path forever — `dropWidgetScopedFilters`, `removePage`'s
     page-anchor drop and `removeWidgetIds` all key off the five KNOWN kinds — and the second
     matched its date window against a source id that could never be right and was silently
     dropped by `isValidFilterScope` on the next load.
  2. **Existence** — the orphan checks, which stay here because the wire boundary validates a
     payload in isolation and has no doc to look ids up in. The reducer's only cleanup path for
     a scoped filter fires when its anchor is _removed_, so a filter anchored to something that
     never existed is never removed and filters its page forever with no clearing affordance.
     Two mirrored checks: `scope.widgetId`/`scope.sourceWidgetId` must name a live widget, and
     an explicit `scope.pageId` must name a live page (for `page`, `dashboard-date-range`,
     `cross-filter`, and `interactive`; a legacy pageId-less `page` filter applies everywhere,
     is not an anchor, and is left alone).

  The two session-flavoured kinds needed this most and had it least: `serializeDoc` STRIPS
  `cross-filter`/`interactive` entries, so unlike every other scope kind the load boundary can
  never repair one that got in, and `removePage`'s cleanup only fires for a page that was present
  and then removed. A filter anchored to a page the doc never had was permanent, invisible,
  unclearable dead weight. This is specifically a parser-bypass gap — `executeToolOnState.ts`
  builds mutations straight from LLM tool arguments and never runs the wire validator, whose
  `FILTER_SCOPE_REQUIRED_IDS` has always listed `pageId` for both kinds.

  Finally it rejects a second `rank`-mode filter on the same page context (see
  [rank-filter uniqueness](#rank-filter-uniqueness)), running the gate only for `page`/`widget`.

- **`removeFilter`** removes by strict `!==` compare, then cascades into every remaining filter's
  `dependsOn` via the shared `pruneDependsOn`. The handler no longer owns that prune, which is
  precisely why the invariant used to hold here and nowhere else.

- <a id="applybulkupdate"></a>**`applyBulkUpdate`** applies its widget deltas on top of the
  receiver's **current** `state.widgets`, never a turn-start snapshot.

  **Array-shape guards first.** `removedWidgetIds`, `addedWidgets`, and `updatedWidgets` must each
  be a genuine `Array.isArray` value — not merely truthy — before anything reads them. `new Set(…)`
  iterates a STRING char-by-char, so `removedWidgetIds: 'w1'` would delete widgets named `'w'` and
  `'1'`; a truthy non-array handed to `for...of` throws `is not iterable` instead of the graceful
  no-op every sibling guard provides. Each surviving entry is then screened individually (a string,
  or a plain record), so a junk entry among well-formed ones is skipped, not fatal.

  **Removals are page-independent.** Before `removeWidgetIds`' "still referenced" check runs, every
  page's rows are stripped of every id in `removedWidgetIds` via `stripWidgetIdsFromPages` —
  unconditionally, not only when the bulk also supplies a `widgetRows` replacement, and across ALL
  pages rather than the active page alone. Both scopings closed a silent bug:
  - Without the unconditional strip, an updates/removals-only bulk (the common case) left the
    widget still referenced on the very page the removal targeted, so `removeWidgetIds` classified
    it as still-in-use and the removal simply dropped.
  - Without the all-pages scope, a widget the user dragged to another page mid-turn was reported as
    still-referenced there and survived the removal. `removedWidgetIds` names widgets to remove
    DOC-WIDE, and mirroring `removeWidget`'s own all-pages call is what makes single and batch
    removal carry the identical cross-page guarantee. `removeWidgetIds`' cross-page guard exists to
    protect an id NOT named for removal from being deleted because a colliding id elsewhere was —
    it was never meant to veto an explicit, named removal.

  The pre-strip also prunes each stripped id's own `widgetColSpans` entry on the active page, since
  `stripWidgetIdsFromPages` only ever clears a _surviving_ row-mate's stale span.

  **Remove-and-re-add of the same id in one payload is a "replace", not a removal.** The
  `reAddedWidgetIds` set (`removedWidgetIds ∩ addedWidgets` ids) is computed once up front and
  consulted at all **four** steps that would otherwise disagree: the pre-strip skips those ids (so
  the row survives); `removeWidgetIds` is handed `idsToPreStrip` — removals MINUS re-adds — so a
  re-added id is never even a removal candidate; the layout block's `validRowIds` exclusion skips
  them (so a row naming the id isn't dropped as a phantom); and the insert loop OVERWRITES rather
  than skips an already-present entry with such an id (so the definition updates on top of the
  preserved placement). Before this was unified the two branches disagreed: a replace bulk
  supplying `widgetRows` preserved placement but discarded the new title/config, while one omitting
  `widgetRows` genuinely deleted-then-reinserted the widget, losing its placement/filters/spans.

  **The replace path value-compares before installing.** The insert loop's overwrite branch used to
  assign the incoming widget with no comparison at all — the one add/update channel in this file that
  did not (`addWidget`'s idempotency guard and the `updatedWidgets` loop's per-field comparisons both
  do). Since the widget is already present, an at-least-once SSE re-delivery of the same
  remove-and-re-add bulk installed a fresh, value-identical object, flipped `widgetsChanged` and
  pushed a **phantom undo entry**. `widgetsValueEqual` compares every own top-level key by `===`
  except `config`, which goes through the shared `shallowRecordEqual` core (the config bag is rebuilt
  by `coerceWidgetConfig`/`normalizeConfigChartSeries` on every add, so it is never reference-equal
  even when unchanged). It is shallow by design, matching that core's own contract: a re-delivery's
  nested values are re-created by `JSON.parse` and so compare unequal, which conservatively treats
  the widget as changed. A genuinely NEW insert has nothing to compare against and always installs.

  The `removeWidgetIds` exclusion is **explicit** rather than inferred from the surviving row.
  Handing the full `removedWidgetIds` in and relying on `stillReferenced` to classify the re-added
  id as live worked only for a PLACED widget: one in `doc.widgets` but on no page's rows has no row
  to survive, so it read as genuinely removed and `dropWidgetScopedFilters` took its
  `widget`/`interactive`/`cross-filter` filters away moments before the insert loop re-added it — a
  replace of an unplaced widget silently losing its scoped filters. For the placed case the two
  candidate lists are equivalent, since the surviving row already vetoed the removal.

  **Layout replacement is scoped to the `activePageId` page and skipped independently of the
  deltas.** When `activePageId` names a page that no longer exists (deleted mid-turn), only the
  page-scoped layout replacement is skipped; `addedWidgets`/`updatedWidgets` are page-independent
  by design and are still applied, rather than the whole mutation no-opping.

  **Partial layout payloads.** `widgetRows`/`widgetColSpans` are optional, and both presence
  decisions run off ONE predicate per field (`rowsProvided`/`spansProvided`), so a present-but-junk
  value counts as ABSENT everywhere and can neither be read nor flip a branch. Both absent ⇒ the
  whole layout block is skipped. `widgetRows` only ⇒ the rows install and the page's **existing**
  spans merge forward, as `setWidgetLayout` does. `widgetColSpans` only ⇒ the spans reconcile
  against the page's **existing** rows and merge onto its existing map. Defaulting an absent field
  to `[]`/`{}` would wipe the page on a mere field omission — an absent `widgetRows` coerced to
  `[]` un-places every widget AND orphans the very spans the bulk carries.

  **Replace vs merge for the span map.** The wire spans REPLACE the page's map only when the
  producer shipped rows AND spans together (then they genuinely are the intended full map for the
  new placement); **every other combination MERGES** (incoming keys win, untouched keys survive).
  Keying the decision on `rowsProvided` alone made a rows-only bulk coerce the absent spans to `{}`
  and replace the whole map with nothing, so `applyBulkUpdate { widgetRows: [['w2','w1']] }` WIPED
  the widths `setWidgetLayout { rows: [['w2','w1']] }` kept — two mutations expressing the same
  reorder disagreeing on every width. Merging also protects a concurrent client drag-resize of a
  widget the bulk never named.

  On the **merge** branch only (`spansProvided && !rowsProvided`), each row containing an incoming
  entry runs through `rebalanceRowSpans` with the incoming keys as anchors, because a merged row
  can sum past `GRID_COLS` even though every individual span is in range. It is deliberately NOT
  applied on the replace branch: every span there came from the one payload, so there is no
  pre-existing width to protect and no non-arbitrary anchor, and an internally-inconsistent full
  snapshot keeps the documented drop-to-flex resolution. `oldRows` for `enforceLayoutColSpans`
  follows the same rule — normally `[]` so the 2→1 collapse never fires (a producer shipping rows
  AND spans meant the singleton spans it sent), but a rows-ONLY bulk is semantically a
  `setWidgetLayout`, so it passes the page's real previous rows.

  **Row sanitization** mirrors `setWidgetLayout`'s, widened for this handler's own inserts:
  `validRowIds` is `state.widgets` **union** this bulk's `addedWidgets` entries that
  `isInsertableAddedWidget` accepts (rows may legitimately reference a widget inserted later in the
  same handler), minus `removedWidgetIds` (minus `reAddedWidgetIds`). `dedupeLayoutRows` then
  applies, and span keys are `isSafePatchKey`-filtered and clamped.

  That admission step **PREDICTS the insert loop's verdict**, and any condition it fails to mirror
  produces a row naming a widget the loop then skips — the "page renders a widget that does not
  exist" state `validRowIds` exists to prevent, which survives `serializeDoc` and is healed only by
  `normalizePersistedPages` on the NEXT load. `isInsertableAddedWidget` is therefore the ONE
  acceptance test both blocks call (record-ness, string `id`, `isSafePatchKey`, string
  `kind`/`title`) rather than two hand-kept lists. Both instances of the disagreement were real: a
  numeric `addedWidgets[].id` (`isSafePatchKey` alone screens the denylist, not the type), and then
  the later-added `kind`/`title` string checks, which the insert loop applied and the admission
  step never learned about.

  `reAddedWidgetIds` deliberately uses a LOOSER screen than `isInsertableAddedWidget`, because it
  answers a different question — "does this payload intend to keep this id alive?", not "will the
  insert loop install it?". A replace whose new definition is junk is skipped by the insert loop,
  and membership in that set is what leaves the OLD widget (entry, row, filters, spans) intact
  instead of letting the removal half of a rejected replace delete the user's widget.

  **Unplaced added widgets get a fallback placement.** After the layout portion runs, the handler
  collects every id still referenced across all pages' post-removal rows and appends a
  single-widget row to the active page for each newly-inserted widget not among them — scoped to
  the same `pageExists` guard, so a widget added while its target page was deleted mid-turn stays
  unplaced rather than the handler guessing a page. Previously an adds-only batch inserted the
  widget but never placed it: it existed and rendered nowhere until some later unrelated mutation
  happened to place it. A widget the producer explicitly laid out is never placed twice.

  **`updatedWidgets` entries are applied field-by-field**, not as a blind overwrite. `title` and
  `sourceId` each require a string and are assigned only when they differ from the existing value;
  `config` is `isPlainRecord`-gated, shallow-merged, and compared via `shallowRecordEqual`. A
  field-less entry (`{ widgetId }`), a non-record `config`, or a value-identical one leaves that
  widget's reference untouched — a re-delivered bulk envelope must not churn the doc. The target is
  looked up via `Object.hasOwn`, not a truthy bracket read, so a `widgetId` of `'constructor'` is a
  clean "target not found" skip rather than resolving up the prototype chain.

- **`renameAIThread`** takes a producer-supplied `args.updatedAt` rather than calling `new Date()`
  inside the reducer — the one place a naive implementation would break purity. The sole producer
  stamps it once so the server-computed and client-applied results agree byte-for-byte. Its
  explicit `args.threadId` (falling back to the active thread for legacy payloads) is the same
  targeting pattern as `addWidget.pageId`, so a rename can't land on the wrong thread if the user
  switches threads while the model is running. `name`/`updatedAt` must be strings — the chat
  panel's thread selector renders both directly with no fallback. It no-ops when `doc.ai` or a
  resolvable target thread is absent.

`mutationLabel(mutation)` produces a compact label (`addWidget:chart:widget-123`,
`removeFilter:filter-9`) via the same dispatch table's `label` function, used for the AI
recent-mutation log (client undo/redo history + MCP's `get_recent_changes`).

### `parseStateMutation.ts` — the runtime validation boundary

`parseStateMutation(value: unknown): ParseStateMutationResult` is the single place a value
_claiming_ to be a `StateMutation` is validated before it is handed to `applyMutation`. It exists
because the reducer's handlers destructure `mutation.args` trusting the compile-time
`StateMutation` shape, which TypeScript cannot enforce on a value that crossed a wire boundary.

There is exactly **one** such boundary in the whole system: the client's SSE `state-mutation`
handler (`StudioBackendAdapter` → `applyStateMutation`). Every mutation that reaches
`applyMutation` server-side is constructed by the server itself and never deserialized from client
input, so it does not go through here — which is why the reducer carries the defense-in-depth
guards documented above.

It returns `{ ok: true; mutation }` or `{ ok: false; error }` with a descriptive string naming the
offending field, so a dropped event has a loggable reason where the reducer's dispatch would
silently no-op. It is a **pure gate**: no validator rewrites its input. `validateWidget` used to be
the one exception, normalizing `widget.config` in place via `stripForeignFamilyKeys`; it no longer
does (below).

- **Structure.** `value` must be a plain object; `value.type` must be a string that is an **own**
  key of the validator table; `value.args` must be a plain object. Per-variant checks live in a
  `MUTATION_ARG_VALIDATORS` table typed with the **same mapped-type exhaustiveness trick** as
  `MUTATION_HANDLERS`, so a new variant without a validator is a compile error, not a silently
  unvalidated gap. `PARSEABLE_MUTATION_TYPES` is exported alongside `MUTATION_TYPES` purely for
  the table-sync test.

- **`isSafeId`.** Every id the reducer uses as a `Record` key rejects the three denylist members
  and is length-capped. `hasUnsafeOwnKeys` is the parallel own-key scan for
  `config`/`changes`/`widgetColSpans` payloads.

- **`validateWidget`** — used for both `addWidget.args.widget` and each `addedWidgets` entry, so a
  full-widget payload is checked identically regardless of which mutation carries it. `id` safe,
  `kind`/`title` strings, `subtitle`/`sourceId` optional strings, `titleMode`/`subtitleMode`
  optional `'auto'|'manual'`, `config` a plain record with no unsafe own key (checked even for a
  custom kind, where `validateConfigKeysForKind` imposes no restriction).

  It then runs the kind-level `validateConfigKeysForKind` from `configKeyValidation.ts` always, and
  for a chart widget additionally membership-checks an explicit `config.chartType`. An explicit
  `chartType` that is not a real `StudioChartType` is fatal — there are no custom chart types. An
  ABSENT one is legal and resolves to `'bar'` downstream.

  Foreign-family keys are **preserved — neither rejected nor stripped.** This validator used to
  rewrite `widget.config` in place through `stripForeignFamilyKeys`, which made the wire boundary
  the ONE place such a key was deleted: `deserializeState` preserves them and so does
  `applyMutation`'s config merge, so three boundaries disagreed about one `addWidget` payload.
  Round-tripping a stored widget through `addWidget`/`applyBulkUpdate.addedWidgets` — duplicating
  it, or moving it across dashboards — therefore silently destroyed exactly the keys
  [key retention](#key-retention-across-charttype-switches) exists to keep. All three boundaries
  now preserve, which is the semantics the other two, and the feature itself, already had. (Latent
  rather than live: the only current producer, `buildWidgetFromArgs` in the AI middleware, rejects a
  foreign-family key before the strip could have fired.) A useful side effect is that the validator
  no longer touches its input at all, so a config that crosses it keeps its object identity and the
  reducer's reference-equality no-op contract is unaffected.

  Only the FAMILY distinction is soft. "Not a chart key at all" stays fatal — the kind-level check
  rejects any key outside the union of every chart family.

- **`validateFilter`** — the filter object's own keys are screened with `hasUnsafeOwnKeys`
  (mirrored on load), `id` must be a safe id, `scope` a valid `StudioFilterScope` (own-key-screened
  too, via `validateFilterScope`), `field` a string, `operator` and a present `operator2` members
  of the closed union via `isStudioFilterOperator`, and a present `dependsOn` a real `string[]`.

  The sibling closed-union leaf fields — `filterMode`, `conjunction`, `rankDirection`,
  `dateRangePreset` — are deliberately left unchecked, and the asymmetry is the point: unlike
  `operator`, the evaluator degrades SAFELY for each (a junk `filterMode` falls through to
  condition mode, a junk `conjunction` behaves as `'and'`, a junk `rankDirection` as `'top'`, and
  `dateRangePreset` is a display-only annotation the evaluator never branches on), so none can
  produce the active-chip-that-filters-nothing failure, and the boundary tolerates them for
  forward compatibility.

- **`updateWidget.args.changes`** is checked field-by-field, unlike the `config`/`unsetConfigKeys`
  channels whose interiors stay unchecked leaves: `changes` is a wholesale merge onto the widget
  itself. An own `id` key is rejected outright; `title`/`subtitle`/`sourceId`/`kind` must be
  strings when present; `titleMode`/`subtitleMode` `'auto'|'manual'`; `changes.config` a plain,
  own-key-screened record.

- **Config-key validation is STATELESS**, and statelessness means "resolved only from the incoming
  config's own `chartType`, never from a stored widget" — it does NOT mean "skipped when
  `chartType` is omitted". `validateWidget` only ever sees full-widget CREATE payloads, where
  there is no existing widget to omit a discriminant relative to, so an omitted `chartType` is
  simply the `'bar'` case. The genuinely stateless gap is the config-PATCH channels
  (`updateWidget.args.config`, `.changes.config`, `updatedWidgets[].config`), which carry no
  `kind`/`chartType` of their own and cannot be family-validated here; they get a narrower
  membership-only check (a present `chartType` must be a real `StudioChartType`), and the full
  check is covered in-process by the controller and by the middleware. That membership predicate,
  `hasInvalidChartTypeInConfig`, is EXPORTED and reused by the reducer on the same three channels
  (via `stripInvalidChartType`), so the wire boundary and the reducer cannot come to disagree
  about which chart types exist.

- **Depth of interpretation.** Validation is deliberately shallow at the leaves: it checks what
  other code keys or iterates on (ids; `string[]`/`string[][]` layouts via real `Array.isArray`
  element checks, so the string `"abc"` can never masquerade as `['a','b','c']`;
  `Record<string, number>` col-spans; `scope.kind` against the five kinds and their required id
  fields; filter `field`/`operator`) but leaves the per-kind widget `config` interior and filter
  `value`/`value2` UNINTERPRETED — deep-validating those would drift on every config change for
  no safety gain. Unknown extra keys inside `args` are tolerated for forward compatibility.

  `setWidgetColSpan.args.rowWidgetIds` gets a per-entry `isSafeId` check beyond the ordinary
  `string[]` shape test, backstopping any producer that still supplies it.

- **Size caps.** Everything above validates SHAPE; this validates SIZE. Uninterpreted must not
  mean unbounded: everything past this boundary — the reducer's per-entry loops, the client's
  render tree, `serializeState`'s full-doc `JSON.stringify` on autosave, `migrateState`'s
  `structuredClone` — assumes a bounded, dashboard-sized document, and an unbounded payload hangs
  or OOMs a consumer long before any shape check would have rejected it.

  Four module-level constants: `MAX_ARRAY_LENGTH = 500`, `MAX_STRING_LENGTH = 10_000`,
  `MAX_DEPTH = 32`, `MAX_RECORD_KEYS = MAX_ARRAY_LENGTH` (a wide-but-shallow record is the same
  payload by another shape). Breadth caps are enforced inside the shared leaf predicates
  (`isString`, `isOptionalString`, `isSafeId`, `isStringArray`, `isStringMatrix`,
  `isFiniteNumberRecord`), so every field routed through one is capped with no per-field
  bookkeeping; `addedWidgets`/`updatedWidgets`, validated by an explicit per-entry loop, carry
  their own length checks with field-naming error messages.

  **`isBoundedValue(value)`** adds the depth bound, and is deliberately shape-AGNOSTIC: it makes
  no claim about what a leaf MEANS, only that a consumer can `JSON.stringify`/`structuredClone`/
  render it without blowing a stack or a memory budget. It runs on the whole `widget` record, the
  whole `filter`, and the whole `filter.scope` — not merely the named leaves — because those three
  are installed **verbatim** by the reducer while unknown extra keys are tolerated by policy, so
  an unnamed key is the one place arbitrary payload can still cross. Roughly 40 KB of nesting
  under an unnamed key was enough to make every subsequent autosave throw
  `RangeError: Maximum call stack size exceeded` while the dashboard still looked fine, and to
  make the doc unloadable at the next migration.

  `updateWidget.changes` and `updatedWidgets` need no whole-record bound, because the reducer's
  `MERGEABLE_WIDGET_CHANGE_KEYS` allow-list drops extras before installation. That asymmetry is
  pinned by a test so it reads as deliberate.

  Every rejection reports through the shared `unboundedValueError(path)` string, so a new call
  site cannot invent a divergent message. The caps are deliberately generous — far past anything a
  real dashboard or AI tool call approaches. They are a denial-of-service backstop, not a business
  rule.

### `widgetTypeGuards.ts` — runtime narrowing and closed-union lists

Two responsibilities in one file, because both exist for the same underlying reason: a union needs
a runtime helper only where TypeScript can't narrow it unaided, or where a closed union has no
runtime representation to check against.

- **`isWidgetOfKind(widget, kind)`** — MANDATORY at any cross-kind call site, for the reason given
  under [the OPEN widget union](#studiowidget--the-widget-kind-union-open). It performs the same
  runtime check as a bare `===` but ASSERTS the precise `StudioWidgetOf<K>` result type.
  Single-kind components should instead type their prop directly as `StudioWidgetOf<'chart'>` —
  no guard needed.
- **`resolveChartType(config)`** — `config.chartType ?? 'bar'`, the one place the runtime default
  is spelled out.
- **`isChartConfigOfType(config, type)`** — narrows a value still typed as the _flat_
  `StudioChartConfig` (whose keys are all present, so a bare `===` does not narrow it to a family).
  NOT needed against the closed `StudioChartWidgetConfig`, which narrows natively.

Four closed unions publish a runtime membership list plus a predicate, and all four follow one
pattern: `as const satisfies readonly Union[]` (which checks element validity), plus a separate
`AssertAll…Listed` error-tuple lock that fail-closes **completeness** (which `satisfies` alone
cannot), plus a runtime list-length pin in the tests.

| List                          | Predicate                    | Members | Gates                                                            |
| :---------------------------- | :--------------------------- | ------: | :--------------------------------------------------------------- |
| `STUDIO_CHART_TYPES`          | `isStudioChartType`          |      16 | Every `addWidget`/`add_widget` boundary                          |
| `STUDIO_FILTER_OPERATORS`     | `isStudioFilterOperator`     |      17 | `validateFilter`, `addFilter`, the load-boundary screen          |
| `STUDIO_EXPRESSION_OPERATORS` | `isStudioExpressionOperator` |      22 | `isValidExpressionNode` at the persisted-doc load boundary       |
| `STUDIO_RELATIONSHIP_TYPES`   | `isStudioRelationshipType`   |       3 | `isRelationshipSafe` at the load boundary, `screenRelationships` |

**The fourth was the last one holding a runtime list with no compile lock.** `statePersistence.ts`
carried a bare `new Set(['many-to-one', 'one-to-one', 'many-to-many'])` — no `satisfies`, no
completeness assertion — so a FOURTH `StudioRelationship['type']` would have compiled cleanly while
`isRelationshipSafe` silently DROPPED every persisted relationship using it at load. It now follows
the same three-part pattern as its siblings, from the same file.

**The list-LENGTH pins are runtime tests, and they close what the compile lock cannot.** Completeness
itself has no runtime representation — a TypeScript union does not exist at runtime — which is why
the `AssertAll…Listed` locks exist. But a lock passes when a union member is deleted by accident and
the list is shortened to match, so `widgetTypeGuards.test.ts` pins each list's exact length
(16 / 17 / 22 / 3). That also makes the "closed N-member union" claims in this document falsifiable
rather than decorative — the claim that `StudioExpressionOperator` had 23 members stood here for
several rounds while the type, the runtime list, the client's `ExpressionNodeEditor` option table and
the evaluator's `switch` all agreed on 22.

**All four lists get near-miss rejection coverage**, not only membership. Each predicate is
`list.includes(value)`, so asserting `includes(x) === true` for every `x` drawn from that same list
is a tautology that cannot fail and would keep passing if the list lost half its entries — the
length pin and the compile lock are what hold the list. What the tests actually exercise is the
rejection side: the plausible typos a hand-edited or foreign persisted doc carries
(`'greaterThanOrEquals'`, `'donut-chart'`, `'bar100'`, `'not_equal'`, `'many_to_one'`, `''`),
non-string values, and that nothing resolves up the prototype chain (`'toString'`, `'constructor'`,
`'__proto__'`). Only `STUDIO_EXPRESSION_OPERATORS` had that coverage; the other three now share it,
so the closed unions are held to one standard rather than only the newest one. Each list is also
pinned for duplicate-free membership.

Publishing the list, not just the type, is the whole point. Each of these was at some stage
type-only, which forced its consumers to hand-maintain a parallel copy: the AI middleware's
`VALID_FILTER_OPERATORS` record, and `ExpressionNodeEditor`'s 22-entry option table alongside the
evaluator's arity/kind tables. A hand-copy is exactly the per-package drift this package exists to
eliminate — an operator added here but missed in a copy makes the editor and the load boundary
disagree about which operators exist, and an expression the editor cannot offer silently
evaluates to `null` after a reload.

**"Published" means re-exported from `index.ts`, and all four now are.**
`STUDIO_RELATIONSHIP_TYPES`/`isStudioRelationshipType` were the last pair still reachable only by
a deep import — the argument above applies to all four equally, and there is no reason a consumer
branching on `StudioRelationship['type']` should be the one forced back to a hand-copy.
`widgetTypeGuards.test.ts` pins all four pairs against the PUBLIC entry point and asserts each is
the SAME binding as the source module's, so a dropped re-export fails rather than silently
regressing.

`isStudioFilterOperator` and `isStudioExpressionOperator` are `unknown`-typed (not `string`-typed
like `isStudioChartType`) since they must also reject a non-string value.

Unlike an unrecognized widget kind — a legitimate "custom kind, no restriction" case — there are
no custom chart types, so an unrecognized `chartType` is a hard error at validation boundaries,
not a permissive pass-through.

#### The widget-field tuples

The same "publish the list, lock it, derive from it" pattern is applied to `StudioWidgetOf`'s FIELD
NAMES, which five sites were re-enumerating by hand: the reducer's `MERGEABLE_WIDGET_CHANGE_KEYS`
allow-list, its `unsetFields` denylist and its optional-scalar screen, the wire boundary's
`updateWidget.changes` per-field checks, and the load boundary's optional-scalar screen. None of the
five was locked, so adding a field to `StudioWidgetOf` compiled cleanly while `updateWidget`
silently no-opped on it forever (`MERGEABLE_WIDGET_CHANGE_KEYS.has(key)` is `false`) and neither
boundary screened it.

Three partition tuples are now the single source those five derive from, split by **value shape**
because that is what the screening sites branch on: `WIDGET_STRING_FIELDS`
(`kind`/`title`/`subtitle`/`sourceId`), `WIDGET_TITLE_MODE_FIELDS` (`titleMode`/`subtitleMode`), and
`WIDGET_OTHER_FIELDS` (`id`/`config`). `STUDIO_WIDGET_FIELDS` composes all three, and
`AssertAllWidgetFieldsListed` locks the composition against `keyof StudioWidgetOf` — a new field must
land in exactly one partition or the build fails. `OPTIONAL_STUDIO_WIDGET_FIELDS` is locked the same
way against the derived `OptionalWidgetField`, by `AssertAllOptionalWidgetFieldsListed`, so making a
field optional (or required) forces the list to follow.

Two further lists are **derived rather than re-listed**, and so cannot drift from either source:
`REQUIRED_STUDIO_WIDGET_FIELDS` is `STUDIO_WIDGET_FIELDS` minus the optional set (exactly the
reducer's `unsetFields` denylist — a widget must never be left without one), and
`OPTIONAL_WIDGET_STRING_FIELDS` is `WIDGET_STRING_FIELDS` ∩ the optional set (the fields both the
write boundary's `screenOptionalWidgetScalars` and the load boundary strip on a non-string value,
rather than dropping the whole widget). The tests pin the derivations, since a derivation bug would
silently un-screen a field with nothing to compile against.

### `configKeyValidation.ts` — write-side config-key guards, two levels deep

`StudioWidgetConfigForKind<K>`/`StudioChartConfigOfType<T>` only constrain code that READS
`widget.config` after narrowing. Neither `StudioController.updateWidgetConfig` nor an AI tool call
is type-checked against a specific widget at runtime, so a wrong-kind or wrong-chart-type key can
still be WRITTEN over those boundaries. This file closes that gap with two parallel layers, one
per union.

- **`getAllowedConfigKeys(kind)` / `validateConfigKeysForKind(kind, config)`** — the widget-KIND
  layer. Returns `null` (no restriction) for a custom kind; otherwise a `Set` of the shared config
  keys plus that kind's own. Each kind's key list is hand-maintained — a default widget instance
  under-reports the real allow-list, since a factory only seeds the couple of keys it needs, and
  TS interfaces don't exist at runtime — but locked to the real interface by a per-list
  `AssertKeysCovered` compile-time check plus a `satisfies readonly (keyof Interface)[]` clause,
  so an interface key added or removed without updating its list fails to compile rather than
  silently under-validating.

- **`getAllowedChartConfigKeys(chartType)` / `validateChartConfigKeysForType(chartType, config)`**
  — the CHART-TYPE layer, one level finer. Because `StudioChartType` is closed, this is TOTAL and
  never returns `null`; there is no "custom chart type, anything goes" case.
  `CHART_TYPE_CONFIG_KEYS` maps each of the 16 literals to its family's key tuple (families
  sharing an interface share one tuple), and `getAllowedChartConfigKeys` unions in
  `SHARED_CONFIG_KEYS`. The kind-level `chart` entry the sibling layer consumes is DERIVED as the
  union of all ten family tuples, so the two levels can't drift, and that union is itself
  `AssertKeysCovered`-locked against the recomposed flat `StudioChartConfig`.

Both use `Object.hasOwn` for their table lookups, which means a caller holding an untrusted
chart-type string does not need to pre-gate it with `isStudioChartType`: an unrecognized type — or
one naming an `Object.prototype` member — returns an **empty `Set`**, so every key is flagged.
That falls out of the guard itself and is the intended fail-closed behavior; a bare bracket lookup
would instead resolve a function up the prototype chain and pass it to `new Set(...)`, throwing
`is not iterable`.

Both validators are shallow, key-PRESENCE-only checks, matching the rest of this package's
write-side validation style, and are consumed at three boundaries: the wire boundary's
`validateWidget`, the AI middleware's in-process tool-call boundary, and the client's
`StudioController.updateWidgetConfig` (fail-closed at the first two, warn-and-strip in the UI
controller — see those packages' own `ARCHITECTURE.md`).

**`stripForeignFamilyKeys(config, chartType)`** returns a copy retaining only the keys the chart
type allows. It is **used by no trust boundary in this package**, deliberately: `validateWidget`
used to call it, and that made the wire boundary the one place a foreign-family key was deleted
while `deserializeState` and `applyMutation`'s config merge both preserved it — silently destroying
exactly what [key retention](#key-retention-across-charttype-switches) exists to keep. All three
boundaries now preserve. It stays exported for the opposite intent: a host or tool that genuinely
wants a config REDUCED to one family (a "reset to this chart type's keys" affordance, an export that
should not carry dormant keys) gets one implementation to call rather than hand-rolling one that
drifts from `getAllowedChartConfigKeys` — whose `Object.hasOwn` fail-closed guard it inherits.

### `statePersistence.ts` — the persistence boundary

The serialization layer between the live `StudioState` and on-disk JSON. Only the `doc` partition
round-trips. `CURRENT_SCHEMA_VERSION` is re-exported here; its source of truth is `stateTypes.ts`.

`SerializedStudioState`/`SerializedStudioSnapshot`/`SerializedStudioSession` describe the on-disk
shapes. A `SerializedStudioSnapshot` still carries a `mode` for backward compatibility, but since
`mode` moved into the non-undoable `session`, every snapshot in a saved session carries the same
mode and `restoreSession` no longer varies it across undo/redo history.

#### `serializeDoc` / `serializeState`

**`serializeDoc(doc)`** is the doc-only inner logic, shared by `serializeState` and by
`StudioController`'s undo/redo snapshotting. It **spreads** every `doc` field — so a newly-added
`StudioDoc` field is carried automatically, with no hand-picked field list to forget it from —
then makes exactly two adjustments:

1. It strips `cross-filter`- AND `interactive`-scoped filters. Both are session-scoped, but with
   DIFFERENT undo semantics: cross-filters are undoable and time-travel with the doc, so
   `StudioController` does NOT carry them across undo/redo, while interactive entries ARE carried
   by `carryTransientDocState`. Either way neither belongs on disk. This is the one place those
   entries — which live in `doc.filters` so the reducer can manipulate them — are dropped.
2. It omits the empties-are-undefined fields (`relationships`/`expressionFields`/`filterPresets`/`ai`
   all collapse to `undefined` when empty), so every optional collection is symmetric on the wire.

**`serializeState(state)`** reads exclusively from `state.doc` and delegates, so session state,
runtime data sources, and the session-scoped filters are all excluded by construction.

#### `deserializeState`

`deserializeState(serialized, dataSources, shellOverrides?)` rebuilds the full partitioned state.
It is a public export a host may call directly on `JSON.parse(localStorage.getItem(k))`, so it is
**TOTAL over a malformed `SerializedStudioState`** — the ARGUMENT ITSELF (coerced to `{}` when it
is not a record), its top-level containers (each absent/malformed one coerced to its empty default
up front: record containers to `{}`, `filters` to `[]`), and their nested entries. Totality means
"repairs corruption instead of crashing", not "loads anything".

The argument coercion closes the case the documented contract makes most likely and the code
handled least: `JSON.parse(localStorage.getItem(k))` is `null` for a missing key. The version read
already anticipated that with `?.schemaVersion`, but the container reads immediately below then
threw `Cannot read properties of null`. Every field is now read off the normalised `raw`, not off
`serialized` — including `ai`/`relationships`/`expressionFields`/`filterPresets`, which used to be
read off the raw argument even though their siblings were not.

**The one deliberate exception:** it THROWS when `serialized.schemaVersion` is a number GREATER
than `CURRENT_SCHEMA_VERSION`. Everything else it meets is _within-version_ corruption it can
repair per-entry; a doc from a NEWER Studio is different in kind. This build cannot know what its
unknown fields MEAN, so "repairing" it means reading only the fields this version knows,
discarding every newer one, and stamping the current `schemaVersion` back on — the host's next
save writes that downgraded doc, migrations never re-run against it, and the newer data is gone
permanently. `migrateState` has always refused a newer version, but the guard lived only there and
this function bypasses it. Only a NUMBER above the current version is rejected: an absent version
is a legacy pre-versioning doc (v0), and any other non-number is junk the repair convention
ignores. Both are `migrateState`'s business.

Past that gate the persisted fields become `doc` (stamping the current `schemaVersion`). The
per-ENTRY screens themselves live in `docScreening.ts` so the factory can apply the identical ones
(see [the four trust boundaries](#the-four-trust-boundaries)); what stays here is the ORDER they run
in, the two options only this boundary passes (`stripSessionScopes` and the anchor probes), and the
three things that cannot move without an import cycle. The screens, in the order they run:

- **`widgets`** — the record's own KEYS are screened against `isSafeKey` and non-record entries
  dropped before anything maps over them. Then per surviving entry:
  - The widget OBJECT's own top-level keys are screened with `hasUnsafeOwnKeys` and the whole
    widget dropped on a hit. Distinct from the record-KEY screen: `{ "w-a": { "__proto__": … } }`
    has a safe key but an unsafe own key on the value.
  - A missing or non-string `kind`/`title` drops the whole widget.
  - **`widget.id` is reconciled with its record KEY**, preserving the widget rather than dropping
    it. The KEY is the source of truth — every reducer lookup keys off it, and both the wire
    boundary and the reducer reject a `changes.id` precisely to keep the two in sync — but a
    hand-edited doc where the desync ALREADY exists (`{ "w-a": { "id": "w-b" } }`) loaded verbatim
    and then silently no-op'd every subsequent edit of that widget, since each passes back
    `widget.id`, which no `Object.hasOwn` guard then matches.
  - A non-record `config` is coerced to `{}` before any other normalization.
  - `titleMode`/`subtitleMode` outside `'auto'|'manual'`, and a non-string `subtitle`/`sourceId`,
    have just that key deleted.
  - Legacy leaf shapes are normalized — `config.columns` via `normalizeGridColumn`,
    `config.ySeries` via `normalizeChartSeries` — rebuilding the config only when
    `Array.isArray(x) && x.length > 0`. The non-empty guard keeps the factory-default `[]`
    reference-stable, and the real array check leaves a hand-corrupted `columns: "junk"` to
    `migrateState`'s named-field validation rather than crashing on `.map`.
- **`pages`** — run through `normalizePersistedPages` (below), then the
  ["at least one page"](#at-least-one-page-always-exists) synthesis.
- **`dashboard`** — unsafe own keys stripped (keeping the rest); `activePageId` reconciled to the
  first surviving page key when it is not a string or names no page; `title` and `id` coerced to
  the factory's `'Untitled Dashboard'`/`'dashboard-1'`. `migrateState` only checks that `dashboard`
  is a record, so a persisted `dashboard: {}` loaded with `id === undefined` — a type violation the
  rest of the system reads as a string (it keys saved-view and telemetry records and is
  interpolated into ids) and which `serializeDoc` then re-persisted forever.
- **`filters`** — a pipeline whose order matters:
  1. Drop any entry that is not a record with a record `scope`, or that carries an unsafe own key.
  2. Drop a non-string `id`, then **de-dup by `id`, first occurrence wins**. The dedup must run
     BEFORE the rank pass: `hasConflictingRankFilter` self-excludes the entry whose id it is
     checking, so two filters sharing an id never registered as conflicting and BOTH survived it.
  3. Drop `cross-filter`/`interactive` entries, symmetric with `serializeDoc`'s strip. An orphaned
     cross-filter naming a widget the doc doesn't contain would permanently filter its page, since
     the reducer's cleanup for such filters only fires on widget _removal_.
  4. Drop a `page`-scope filter with an explicit `pageId`, or a `dashboard-date-range` filter,
     naming a page that no longer exists — the page-anchor mirror of the widget-anchor check,
     needed because `removePage`'s cleanup only fires for a LIVE removal, never for a doc that
     already lacks the page. A legacy pageId-less `page` filter is left alone.
  5. Re-check rank uniqueness via the shared `dedupeRankFilters` — the same predicate,
     `page`/`widget` gate and array-order tie-break the reducer and the factory use.
  6. **Once at the end**, cascade every drop above into the survivors' `dependsOn` via the shared
     `pruneDependsOn`. This was the LARGEST un-pruned filter-removal site; applying the prune once
     against the final surviving id set covers all six drops uniformly.

  `isValidFilterScope` is this file's boolean wrapper around `parseStateMutation.ts`'s
  `validateFilterScope`. Reusing the wire predicate rather than duplicating it is why the load
  boundary inherits its own-key screen, its `pageId` string check, and its size bound transitively.

- **`ai`** — validated at three levels. The container is kept only when it is a record whose
  `threads` is an array (`renameAIThread` guards only a _nullish_ `threads`, so `threads: 'junk'`
  would throw `.map is not a function` and round-trip indefinitely). Each thread entry must be a
  record (`renameAIThread` reads `t.id` unguarded, so a `null` entry throws on the first rename).
  Then per thread:
  - **`id` is identity data, so it is SCREENED, not repaired** — a non-empty-string `id` is
    required and the thread is dropped otherwise. `renameAIThread`'s `t.id === threadId` never
    coerces, so a numeric id round-tripped forever as permanent dead weight in the thread selector:
    unselectable and unrenamable.
  - Threads are **de-duped by `id`**, first occurrence wins, mirroring the `filters` dedup — two
    threads sharing an id desync that same lookup from whichever copy the selector rendered.
  - `messages`/`name` are **repaired in place, not screened**: a non-array `messages` degrades to
    `[]` and a non-record message entry is dropped while the rest of the history is kept; a
    non-string `name` falls back to `'Untitled Thread'`. `activeThread?.messages ?? []` guards only
    a nullish value, `<ChatBox>` reads `m.role`/`m.content` unguarded, and a non-string `name`
    crashes as an invalid React child.
  - A dangling `activeThreadId` is reconciled to **`undefined`**, deliberately unlike
    `activePageId`'s first-entry fallback: a page must always render, so `''` is worse than a
    guess, whereas `activeThreadId?: string` already encodes "no thread selected" as a handled
    state. The rebuilt object `delete`s the key rather than writing an explicit `undefined`, so the
    serialized shape stays identical to a doc that never had one.

  A single `aiChanged` flag tracks every drop, repair, and reconciliation across all three levels,
  so a well-formed `ai` returns by reference with no churn.

- **`relationships` / `expressionFields` / `filterPresets`** — coerced to `[]` when present but not
  an array (`?? []` only defaults an ABSENT value, so `relationships: "junk"` would install
  verbatim and break client code iterating it). The shared `screenRecordArray` helper behind the
  first two takes a per-entry **required-leaf** predicate, because record-ness alone was never the
  property it claimed to guarantee:
  - **`isExpressionFieldSafe`** requires a string `id`/`sourceId`/`label`, an optional boolean
    `isMeasure`, and an `expression` validated **all the way down** by `isValidExpressionNode`.
    Record-ness was insufficient on three counts. An entry with no `expression` loaded
    `success: true` and the first widget referencing it threw
    `Cannot use 'in' operator to search for 'joinSourceId' in undefined`, taking down the pipeline
    with no self-heal. `StudioExpression` is a recursive tree with unbounded nesting (a stack
    overflow in the unbounded consumer walkers), so validation is depth-bounded at
    `MAX_EXPRESSION_DEPTH = 32` — the package's uniform bound for untrusted JSON, generous next to
    the expression builder's ~4-level deepest template. And `StudioExpressionOperator` is a closed
    union whose unknown members **fail open**: every evaluator walker falls through to `default:`
    and the whole computed column silently evaluates to `null`. `isMeasure` earns the same
    treatment — a truthy junk value (`isMeasure: 'no'`) loads a calculated column as a measure and
    reports a wrong number everywhere it appears.

    `isValidExpressionNode` tests the function branch FIRST, because `operator` is the only key
    that introduces recursion: any node carrying it must be a well-formed function node (known
    operator, ARRAY `inputs`, every input valid) regardless of which member a consumer's guard
    precedence would resolve it to. The remaining three branches follow the order
    `evaluateExpression` discriminates them in, so a node this screen accepts is the same member
    the evaluator resolves it to.

  - **`isRelationshipSafe`** requires `id` and all four endpoint ids/fields to be strings, and
    `type` to be a member of the closed `StudioRelationship['type']` union — via the shared
    `isStudioRelationshipType`/`STUDIO_RELATIONSHIP_TYPES` pair, which replaced the bare local
    `new Set([...])` that had no compile lock behind it (see
    [the closed-union lists](#widgettypeguardsts--runtime-narrowing-and-closed-union-lists)). An
    unknown `type` FAILS OPEN into the `many-to-one` branch of every join builder and silently
    produces wrong joined rows — the same fail-open class the filter `operator` check closes one
    level up. The `id` check is the one both siblings already made and this predicate omitted:
    `StudioController.updateRelationship(id, patch)`/`removeRelationship(id)` key off `rel.id` and
    `RelationshipPanel`'s delete button is `removeRelationship(rel.id)`, so an entry with no `id`
    loaded, rendered in the data drawer, and was permanently unremovable and unupdatable.

    The three `junction*` fields are deliberately NOT screened for `type: 'many-to-many'`, even
    though they are documented as required for it: `dataSourceGraph.ts`'s join builders guard
    every read (`if (!rel.junctionSourceId || !rel.junctionSourceField || !rel.junctionTargetField) { continue; }`),
    so an incomplete entry is SKIPPED, not dereferenced. There is no unguarded read to protect,
    and dropping the whole relationship would lose an entry the data drawer can still show and
    repair.

  Each predicate receives an already-record, already-own-key-screened entry, so it only checks the
  leaves consumers dereference unguarded; the rest stay optional/defaulted/display-only and follow
  the fallback-over-drop convention. `screenFilterPresets` coerces a preset's `name` (rendered
  verbatim as a Chip `label`), requires the preset's OWN `id` to be a string, and screens each
  preset INNER filter for a string `id` alongside `field`/`operator`/`operator2`. Both `id` checks
  exist for the same reason: `applyFilterPreset`/`removeFilterPreset`/rename locate a preset with
  `p.id === presetId` and the inner id-remap does `idMap.set(f.id, fresh)`, with the drawer keying
  its rows off both — a strict compare that never coerces, so a non-string id yields a preset (or a
  preset row) that can never be matched, applied or removed.

Finally, `session` is reset to `{ mode: 'edit', shell: default ⊕ shellOverrides }`, and
`runtime.dataSources` is the host-injected argument. The load-boundary normalizers run across kinds
by design, so they read through the flat cross-kind `StudioWidgetConfig` patch type.

#### `normalizePersistedPages(pages, widgets)`

Defined in `applyMutation.ts`, imported here. A defensive load-time layout sweep, **not a schema
migration** — the doc shape is unchanged, so it never bumps `CURRENT_SCHEMA_VERSION`. Every LIVE
mutation path maintains the layout invariants, but `deserializeState` previously installed a
persisted `pages` map verbatim, so a corrupted or hand-edited doc's phantom row ids, duplicate
ids, or out-of-range/orphaned spans rendered blank cards and wrong widths until some later layout
mutation happened to prune them.

It is TOTAL over a corrupted doc, not merely defensive for well-formed junk: a prototype-hazard
page KEY, a page object with an unsafe own key, or a non-record page value is dropped; a non-array
`widgetRows` is coerced to `[]`; non-array rows and non-string ids inside a row are filtered out
before the membership check; a non-record `widgetColSpans` is treated as absent.

Per surviving page it filters rows against `widgets`, runs `dedupeLayoutRows`, and rebuilds
`widgetColSpans` keeping only safe keys still present in the sanitized rows, each clamped to
`MIN_SPAN`–`GRID_COLS`. It also:

- **Reconciles each page's own `id` with its record KEY**, re-stamping rather than dropping — the
  page analogue of the widget id↔key reconciliation, for the identical reason (every reducer path
  targets a page by record key, so a `{ "p-a": { "id": "p-b" } }` doc silently no-ops any
  affordance carrying `page.id` forward).
- **Coerces a missing or non-string `page.title`** to `'Untitled Page'`. `findMissingRequiredField`
  does not validate it, and `addPage`/`renamePage` already require a string, so junk can only
  arrive via a directly-loaded doc — where every consumer renders it as text with no fallback and
  crashes React on the first render of the page picker.

The rebuild uses `Object.fromEntries` over surviving entries, never bracket assignment. It returns
the SAME `pages` object (and the same page objects) when nothing needed fixing.

#### `migrateState(state)`

Runs the `migrations` registry sequentially from the stored `schemaVersion` up to
`CURRENT_SCHEMA_VERSION`, on a `structuredClone` deep copy taken ONCE and shared by BOTH paths —
the migration loop and the already-current fast path — so the function offers a SINGLE isolation
guarantee: **the returned state never aliases the caller's object.**

Sharing one clone across both paths is the point. Cloning only on the migration path left the
overwhelmingly common fast path (`CURRENT_SCHEMA_VERSION` is 1) returning the caller's own object
by reference, and since `deserializeState` is reference-stable by design the live doc then aliased
the caller's persisted sub-objects — a host that mutated its own persisted object thereby mutated
live state and every undo snapshot sharing them. Two entry paths with different isolation
guarantees is exactly the trap the next migration walks into, since a migration may (and this
registry's own examples encourage it to) mutate nested state in place.

It is fail-closed at every step:

- **Source version.** Absent ⇒ legacy v0. An integer ⇒ the source version. Anything else — `NaN`,
  a fractional `0.5`, a non-number — is rejected with a named `"schemaVersion"` error rather than
  silently passed through un-migrated. (`typeof NaN === 'number'`, and `NaN === CURRENT` /
  `NaN > CURRENT` are both false while the loop's `version < CURRENT` guard never runs, so a
  `schemaVersion: NaN` doc would otherwise return `success: true` with no migration applied.)
- **A newer version** is refused, checked BEFORE the clone so a doc this build can never
  understand costs nothing to reject.
- **The clone** is wrapped in `try`/`catch` returning a failed `MigrationResult`, so a caller who
  mistakenly passes a live object carrying a non-cloneable value (a function on an attached
  adapter) gets this function's ordinary `{ success: false, errors }` shape rather than an
  uncaught `DataCloneError`.
- **A gap in the registry** — a version step with no registered migration — is a HARD failure,
  never a silent version bump shipping un-transformed state under a newer number. Every step in
  `0 … CURRENT_SCHEMA_VERSION − 1` needs an explicit entry (an identity migration when no
  transform is required).
- **`findMissingRequiredField`** validates the post-migration (and already-current) result, so a
  doc that would CRASH a downstream no-optional-chaining read is rejected by name here rather than
  crashing later.
- **The `schemaVersion` post-condition.** After the loop, the migrated state must actually report
  `CURRENT_SCHEMA_VERSION`. This enforces the registry's own contract clause — "the function must
  return a new object with `schemaVersion` set to N+1" — which was the ONE clause with no check
  behind it while every step above was fail-closed. A future migration that forgot the stamp would
  otherwise return `{ success: true, toVersion: N+1 }` carrying `schemaVersion: N`, and a caller
  persisting `migrateState(...).state` DIRECTLY — both reference hosts
  (`examples/x-studio-dev-server/src/routes/mcp.ts`, `examples/x-studio-composed/src/App.tsx`) do —
  would write the under-stamped doc back to disk and re-run that migration on every subsequent
  load, forever. Latent today (the only entry is the well-behaved `0 → 1` identity, and a doc going
  through `deserializeState` is re-stamped there anyway), but self-healing on one of two paths is
  not the same as enforced, and a version number that lies about the shape it describes is exactly
  what the rest of this function refuses to produce.

  The registry is exported as `MIGRATION_REGISTRY_FOR_TESTS` (from `statePersistence.ts` only —
  deliberately not from `index.ts`) so the tests can register a misbehaving migration. Every
  guarantee in this list is about what a REGISTERED migration may do wrong, and all of them are
  unreachable from outside while the single registered entry is well-behaved — which is precisely
  how this post-condition came to be missing in the first place.

**The `0 → 1` identity migration is deliberate, and `CURRENT_SCHEMA_VERSION` deliberately stays at 1.** v0 is a PRE-RELEASE version: `@mui/x-studio` has never shipped a released state format, so no
persisted doc anywhere is at v0. In particular the reshape `StudioFilterScope`'s
`dashboard-date-range` doc comment refers to (`{ isDashboardDateRange, filterSourceId }` →
`{ kind, sourceId, pageId }`) happened entirely inside the unreleased window, before this package
existed — bumping to v2 for a shape no persisted doc can contain would only add a migration step
that can never fire, plus a fixture test asserting a transform of data that does not exist. The
moment the format DOES ship, the registry's stated policy applies in full.

**What `findMissingRequiredField` hard-fails on, and what it deliberately doesn't**, is the same
graceful-repair-over-hard-fail line drawn everywhere else in this file. It hard-fails on the four
top-level containers and, one level down, on a non-record `pages[*]` value or `filters[*]` entry —
the two nested shapes a no-optional-chaining read (`normalizePersistedPages`' per-page access,
`serializeDoc`/the reducer's `f.scope.kind`) would crash on _before_ the load boundary could act.
It does NOT hard-fail on a shape a load-boundary handler already repairs per-entry BEFORE any such
read runs: a non-array `pages[*].widgetRows` (coerced to `[]`), a malformed `filters[*].scope`
(dropped per-entry), a non-record widget or `widget.config` (dropped/coerced). Sinking the WHOLE
dashboard over one repairable per-entry defect is strictly worse than loading everything else with
just that entry repaired.

`REGISTERED_MIGRATION_VERSIONS` is exported so a completeness test can pin that every version step
has an entry. The `migrations` registry doc comment is the authoritative "how to add a migration"
reference, including the naming policy: never suffix a field with a version number — migrate the
stored shape to the clean target name instead.

## Consumers

- **`@mui/x-studio`** — `src/models/index.ts` re-exports this package wholesale, alongside the
  package's own React-dependent `customWidgetTypes.ts` and UI-only `featureFlags.ts`.
  `StudioController.applyExternalMutation` calls `applyMutation` directly; its undo/redo
  snapshotting calls `serializeDoc`; `carryTransientDocState` carries interactive filters forward
  across undo/redo. `canvasGridConstants.ts` and `StudioController` both **import** `GRID_COLS`/
  `MIN_SPAN` from here, and `internals/rankFilterScope.ts` re-exports `resolveRankFilterPageId`/
  `hasConflictingRankFilter` rather than hand-syncing a copy — the dependency arrow runs
  `x-studio` → `x-studio-schema`, never the reverse. `utils/fieldCapabilities` re-exports
  `FieldCapability`.
- **`@mui/x-studio-ai-middleware`** — `src/models/studioTypes.ts` thinly re-exports the
  state/widget/data types plus the server-local `StudioCustomWidgetDef`; `src/widgetFactory.ts`
  re-exports `createDefaultWidget` through it (a shim preserving a pre-existing import path);
  `src/models/aiTypes.ts` re-exports the shared AI-protocol types alongside its server-only
  additions. `src/executeToolOnState.ts` is the sole producer of the `pageId`/`threadId`-targeted
  and `updatedAt`-stamped mutations, and calls `createDefaultStudioState`/`applyMutation` to thread
  turn state; its `STUDIO_AI_TOOLS` and MCP metadata all derive from `STUDIO_AI_TOOL_REGISTRY`;
  `src/mcp/dataTools.ts` imports `truncateToPeriod`/`detectAnomaliesIQR` directly.

Application code should import from `@mui/x-studio`'s or `@mui/x-studio-ai-middleware`'s public
surface (or their internal `models` barrels) rather than from `@mui/x-studio-schema` directly —
this package is an implementation detail the two happen to share, not a place app code is expected
to import from.

## Testing conventions

`vitest.config.node.mts` runs the suite in a plain Node environment (no DOM), reflecting that
nothing here touches React or the browser. Nine test files, one per runtime module:

- **`applyMutation.test.ts`** — one or more `it` per mutation kind plus a top-level purity check,
  covering idempotency, explicit-`pageId`/`threadId` targeting vs. the active fallback, the span
  clamp/overflow/rebalance branches, layout dedup, per-handler cleanup and `activePageId`
  reassignment, the `updateWidget` ordering contract, the `applyBulkUpdate`
  delta/partial-layout/replace matrix, and reference-equality no-op regressions throughout.
- **`parseStateMutation.test.ts`** — one valid payload per variant, each round-tripped through
  `JSON.parse(JSON.stringify(...))` and then applied through `applyMutation`; malformed top-level
  and per-variant shapes; the size caps at their boundary; id-hygiene regressions asserting
  `Object.prototype` stays unpolluted; a `PARSEABLE_MUTATION_TYPES`/`MUTATION_TYPES` table-sync pin.
- **`statePersistence.test.ts`** — round-trips reading only from `doc`; the symmetric
  cross-filter/interactive strip on serialize and load; the empties-are-omitted normalization;
  every load-boundary screen and reconciliation (id↔key, `activePageId`, `activeThreadId`, filter
  dedup, rank dedup, expression-tree validation); `migrateState`'s
  fast-path/newer-version/registry-gap/clone-failure behavior; a `REGISTERED_MIGRATION_VERSIONS`
  completeness pin.
- **`factories.test.ts`** — one assertion per built-in kind's default config (hand-transcribed in a
  header comment, since `BUILTIN_WIDGET_DEFAULTS` is file-private — update them if the table
  changes); the custom-kind fallback; fresh-array-per-call; id uniqueness across a tight loop and
  across interleaved factories; `normalizeChartSeries` precedence and reference stability; the
  per-partition merge semantics and the four post-merge reconciliations (default-page fallback,
  `activePageId` — including its numeric-coercion heal, `schemaVersion` stamping with a
  serialize→deserialize round trip proving the doc stays loadable, and rank-filter uniqueness with
  its per-page and non-rank-eligible negative cases), plus the `screenDoc` pass over `overrides.doc`
  (including the two load-boundary behaviours it deliberately does not apply).
- **`configKeyValidation.test.ts`** — both layers per kind and per chart type, the custom-kind
  `null` case, the total-over-`StudioChartType` behavior, and the fail-closed
  prototype-chain-`chartType` regressions.
- **`widgetTypeGuards.test.ts`** — each of the four closed-union lists against its predicate, with
  near-miss rejections, non-string rejections, prototype-chain rejections and a duplicate-free pin
  for every one; the exact list-LENGTH pins (16 / 17 / 22 / 3); and the derived widget-field lists
  (`STUDIO_WIDGET_FIELDS`'s partitioning, `REQUIRED_STUDIO_WIDGET_FIELDS`,
  `OPTIONAL_WIDGET_STRING_FIELDS`). Completeness cannot be asserted at runtime (a TypeScript union has no
  runtime representation), which is why the compile-time locks exist; the length pins are what catch
  the one case a lock cannot — a union member deleted by accident with the list shortened to match.
- **`internalGuards.test.ts`** — `isPlainRecord`'s full contract: object literals, `JSON.parse`
  output, and `Object.create(null)` accepted; `null`/arrays/primitives rejected; and
  `Date`/`RegExp`/`Map`/`Set`/class instances rejected, every one of which the pre-prototype-clause
  check accepted.
- **`anomalyDetection.test.ts`** — `detectAnomaliesIQR` edge cases (too few points, degenerate IQR,
  negative/positive outliers). `median` is pinned indirectly, since it is file-private.
- **`temporalUtils.test.ts`** — per-granularity bucketing, the canonical-ISO fast path, the
  offset-carrying and numeric-timestamp fallbacks, unparseable input, the anchored-offset-guard
  pair, and `isoWeek`'s year-boundary cases.

## Extension points

- **New persisted (doc) field** — add it to `StudioDoc` (`stateTypes.ts`). `serializeDoc` spreads
  it automatically; `deserializeState` needs a line only if it must default when omitted; the
  round-trip test catches a missing persistence path. A widget-config field goes on
  `widgetTypes.ts` instead. A field that must **not** persist or be undoable goes on
  `StudioSession`/`StudioRuntime`.
- **New built-in widget kind** — add the string to `BuiltinStudioWidgetKind` (`baseTypes.ts`), a
  per-kind config interface in `widgetTypes.ts`, fold it into `StudioWidgetConfig`'s `extends`
  list and `StudioWidgetConfigByKind`, add a key tuple + `AssertKeysCovered` entry to
  `BUILTIN_OWN_CONFIG_KEYS`, and add a `BUILTIN_WIDGET_DEFAULTS` entry. The `Record<…>` typings
  make a missing entry a compile error in each place.
- **New chart type** — add the literal to `StudioChartType`, a family interface (or extend an
  existing family), an entry in `StudioChartConfigByType`, the family into
  `StudioChartWidgetConfig` and `StudioChartConfig`'s `extends` list, an entry in
  `STUDIO_CHART_TYPES`, and a key tuple + `AssertKeysCovered` entry in `CHART_TYPE_CONFIG_KEYS`
  (plus the derived `CHART_CONFIG_KEYS` union) — all fail-closed at compile time.
  `@mui/x-studio`'s `chartTypeDefs.tsx` also needs an entry, compile-enforced the same way;
  `@mui/x-studio-ai-middleware`'s `widgetConfigMeta.ts` needs a docs line, but that one is a plain
  array with only a comment reminder — nothing fails to compile if it's forgotten.
- **New expression operator** — add the literal to `StudioExpressionOperator`
  (`expressionTypes.ts`) and an entry to `STUDIO_EXPRESSION_OPERATORS` (`widgetTypeGuards.ts`);
  the `AssertAllExpressionOperatorsListed` lock fails the build until you do. The client's editor
  and evaluator read the exported list, so nothing else needs a hand-copy.
- **New AI mutation kind** — add the variant to `StateMutation` (`mutationTypes.ts`), an entry to
  `MUTATION_HANDLERS` (co-locating `apply` and `label`), and an entry to
  `MUTATION_ARG_VALIDATORS`. All three mapped types make a missing entry a compile error.
- **New AI tool** — add an entry to `STUDIO_AI_TOOL_REGISTRY` with its facts. The name widens
  `StudioAIToolName` automatically, and every derived server-side artifact picks it up.
- **Schema migration** — increment `CURRENT_SCHEMA_VERSION` (`stateTypes.ts`), add a `migrations`
  entry keyed by the **previous** version, and add a v(N) fixture test. A registry gap is a hard
  `migrateState` failure, so every version step needs an entry.
