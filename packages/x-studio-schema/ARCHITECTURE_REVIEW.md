# Architecture / tech-debt review — `@mui/x-studio-schema`

Independent review of `packages/x-studio-schema/src/` (all 26 files read in full — 19 source
modules + 7 test suites), fresh pass over the post-migration tree: the `StudioWidget` per-kind
discriminated union, the `StudioChartConfig` per-chart-family discriminated union, the two-level
write-side key validators, the reducer/parser pair, persistence, factories, and the temporal/
anomaly helpers were each re-derived from current code rather than carried over from the previous
review (whose Tier 1 findings — `unsetFields` on required fields, `__proto__` patch keys,
fail-open migrations, silent migration gaps, `removePage` cross-page deletion, temporal offset
divergence, `addWidget` re-delivery, bulk-update span hygiene, `migrateState` caller mutation —
are all verifiably fixed in the current tree, with pinning tests). Line numbers refer to the
current working tree. Cross-package claims (setup-panel write paths, chart aggregation reads,
controller guards, the SSE trust boundary, AI-middleware tool execution, `GRID_COLS` /
`FieldCapability` re-exports) were verified against `packages/x-studio` /
`packages/x-studio-ai-middleware` source, not taken from comments or `ARCHITECTURE.md`.

**Partition/invariant sanity-check:** the core invariants hold up under direct inspection.
(1) _Lifetime partition_: mutation handlers are typed against `StudioDoc` only
(`applyMutation.ts:263-266`), the full-state wrapper provably leaves `session`/`runtime`
referentially identical (`applyMutation.test.ts:1497-1558`), `serializeState` reads exclusively
from `state.doc` (`statePersistence.ts:337-339`), and `deserializeState` resets session and
re-injects runtime. (2) _Single reducer / single trust boundary_: every wire-sourced mutation
reaches `applyMutation` through exactly one validated path
(`studioBackendAdapter.ts:395` → `applyStateMutation.ts:36` → `parseStateMutation`), the
controller's user-driven methods delegate to the same reducer via `commitMutation`, and the
server threads state through `applyMutation` in `executeToolOnState.ts` — no second
implementation of any mutation's effect exists. (3) _Table sync_: `MUTATION_HANDLERS` and
`MUTATION_ARG_VALIDATORS` are both exhaustively mapped over `StateMutation` and runtime-pinned
equal (`parseStateMutation.test.ts:188-191`). (4) _Consolidation claims_: `GRID_COLS`/`MIN_SPAN`
are genuinely re-exported by `x-studio` (`canvasGridConstants.ts:7`), as is `FieldCapability`
(`utils/fieldCapabilities.ts:1-9`). (5) _Kind narrowing_: every bare `widget.kind === '…'` site
in `x-studio` either reads only kind-agnostic fields or deliberately widens to the flat
`StudioWidgetConfig` with an explanatory comment (`generateInsight.ts:624-627`,
`widgetUtils.tsx:104-167`, `StudioWidgetCard.tsx:426-427`) — no site reads a kind-specific
config key through an unnarrowed union. The problems found are below; the most significant is a
functional regression the chart-family migration introduced (1.1).

---

## Tier 1: Correctness & Security

### 1.1 Pie/donut family omits `chartSortBy`/`chartSortDirection`/`xGroupBy`, which the pie data pipeline honors and the setup panel writes — the new write-side guard now silently discards user sort/group-by edits on pie and donut charts

- `packages/x-studio-schema/src/widgetTypes.ts:550-591` (`StudioPieFamilyChartConfig` extends
  only `StudioChartConfigBase`, not `StudioChartSortConfig`, and has no `xGroupBy`)
- `packages/x-studio-schema/src/configKeyValidation.ts:228-245` (`PIE_FAMILY_CHART_KEYS`
  faithfully mirrors the interface, so the allow-list inherits the omission)
- Verified read path: `packages/x-studio/src/components/widgets/StudioChartWidget/useChartWidgetData.ts:42-45`
  reads `config.chartSortBy`/`chartSortDirection`/`xGroupBy` from the flat config for **every**
  chart type, and builds the `chartData` that `renderPieDonut` consumes through
  `aggregateByField(rows, xField, yField, xGroupBy, yAggregation, sortBy, sortDirection, …)`
  (`packages/x-studio/src/internals/aggregators.ts:252-319`); `StudioPieChart.tsx:325-331`
  renders slices in exactly that label order (unless `pieMaxSlices` regroups).
- Verified write path: `packages/x-studio/src/components/StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx:474-539`
  shows the Sort controls for every non-scatter/heatmap/sankey/gauge/gantt chart — **including
  pie and donut** — and `:447-472` shows the Group-by select for any non-sankey chart with a
  date/datetime x-field (again including pie/donut). Both call
  `controller.updateWidgetConfig(widgetId, { chartSortBy: … })` etc.
- Verified guard: `packages/x-studio/src/store/StudioController.ts:936-961` resolves the
  effective chart type (`'pie'`), calls `validateChartConfigKeysForType`, and **strips** the
  offending key (dev-only `console.warn`, silent in production).

The family interfaces claim to "group the keys each chart sub-shape actually reads (verified
against `chartTypeDefs.tsx` and `chartTypeRegistry.ts`)" (`widgetTypes.ts:196-199`) — but the
sort/group-by keys are read one layer _above_ the per-family renderers, in the shared
`useChartWidgetData` aggregation that feeds `renderPieDonut` its `chartData`. That read site was
missed, so the migration assigned the sort keys to the bar/line/mixed families only (plus
`chartSortBy` to funnel). The pie/donut sort and date-group-by features shipped and still render
correctly for configs that already carry the keys — only _new writes_ are now blocked.

**Failure scenario:** a user builds a donut of revenue by region, opens the compose drawer's
Sort control, and picks "Value" / descending. The controller's chart-type guard classifies
`chartSortBy` as invalid for `'pie'`, strips it, and commits an empty config patch: the select
snaps back to "Category" and nothing persists — silently, in production. Same for the Group-by
select on a pie sliced by a date field (`xGroupBy` stripped). The AI path degrades identically:
`update_widget` with `config: { chartSortBy: 'value' }` on a pie returns
`config carries key(s) not valid for chartType 'pie'` to the model
(`executeToolOnState.ts:343-364`), and an `addWidget` carrying `chartType: 'pie', chartSortBy`
is rejected outright at the SSE boundary (`parseStateMutation.ts:168-176`).

**Fix:** extend `StudioPieFamilyChartConfig` with `StudioChartSortConfig` and `xGroupBy?` — the
`AssertKeysCovered` lock then forces `PIE_FAMILY_CHART_KEYS` to follow, and all four guard
layers (parser, controller, middleware, MCP) inherit the fix automatically. While there, decide
funnel's story: the panel also shows the sort-_direction_ toggle and Group-by for funnel, but
`buildFunnelStages` reads neither (`chartTypeDefs.tsx:520-541`), so for funnel the schema
matches the renderer and it's the _panel_ offering dead controls — either exclude funnel from
those two controls in `ChartSetupPanel.tsx`, or add + honor the keys.

### 1.2 `updateWidget.args.changes` is an unvalidated wholesale widget merge on the wire — a payload can overwrite `id` (desyncing it from its `widgets` map key) or set `title`/`kind`/`config` to arbitrarily-typed garbage

- `packages/x-studio-schema/src/parseStateMutation.ts:274-281` (validator: `isRecord` +
  `hasUnsafeOwnKeys` only — no per-field checks)
- `packages/x-studio-schema/src/applyMutation.ts:392-404` (reducer merges every defined key of
  `changes` onto the widget verbatim)
- `packages/x-studio-schema/src/mutationTypes.ts:75` (compile-time type
  `Partial<Omit<StudioWidget, 'id'>>` — the `'id'` exclusion has **no runtime counterpart**)

The reducer is scrupulous about the _other_ three channels: `config` values are
delete-on-`undefined` with pollution-safe keys, `unsetFields` has a runtime denylist protecting
`id`/`kind`/`title`/`config` (with a test pinning it, `applyMutation.test.ts:552-573`), and
`unsetConfigKeys` only deletes. But the `changes` merge only skips unsafe keys and
`undefined` values — it happily writes `changes.id`, and it writes `changes.title`/`kind`/
`config` without any type check. The parser — whose header states its purpose is that "a
malformed payload can reach a handler and corrupt state" and which validates `setWidgetLayout.rows`'s
shape for exactly that reason — checks none of these.

**Failure scenario:** the SSE payload
`{ type: 'updateWidget', args: { widgetId: 'w1', changes: { id: 'w2' } } }` passes
`parseStateMutation` and produces `state.widgets.w1` whose `.id` is `'w2'`. Every id-keyed
invariant now splits: cross-filters emitted by the widget carry `sourceWidgetId: 'w2'`
(read from `widget.id`), but `removeWidget('w1')` — keyed by the map key — prunes filters for
`'w1'` only, leaving a permanent orphaned cross-filter with no clearing affordance; span lookups
and layout rows likewise disagree about which id the widget answers to. Similarly,
`changes: { config: "garbage" }` (a string passes — only `args.config` is `isRecord`-checked,
not `changes.config`) persists through `serializeDoc` a widget whose config is a string, and
`changes: { title: 42 }` a numeric title — both violating `StudioWidget` forever. None of these
is producible by the in-process callers or by `executeToolOnState` (its `update_widget` builds
`changes` from `String(...)` coercions only, verified at `executeToolOnState.ts:366-372`) — this
is precisely the malformed-server / compromised-transport class the parser exists to stop.

**Fix:** in the `updateWidget` validator, reject `changes` carrying an own `id` key, require
`changes.title`/`changes.subtitle`/`changes.sourceId`/`changes.kind` to be strings when present
and `changes.config` to be a record when present (reusing `hasUnsafeOwnKeys` on it); mirror the
`id` exclusion in the reducer's merge loop (`key !== 'id'`) as the defense-in-depth copy for
server-built mutations, matching the pattern `unsetFields` already follows.

## Tier 2: Design smells / maintainability risks

### 2.1 `STUDIO_CHART_TYPES`'s completeness is NOT compile-enforced, contrary to its own comment (and `ARCHITECTURE.md`)

- `packages/x-studio-schema/src/widgetTypeGuards.ts:76-99`

The comment claims "dropping one here fails this `satisfies`". It does not: the annotation
`readonly StudioChartType[]` and the clause
`satisfies readonly (keyof StudioChartConfigByType)[]` both only check that every _element_ is a
valid chart type — a 15-entry list missing `'gauge'` type-checks clean. Every _other_ per-type
artifact is genuinely fail-closed (`CHART_TYPE_CONFIG_KEYS` and `x-studio`'s `CHART_TYPE_DEFS` /
`chartTypeRegistry` are `Record<StudioChartType, …>`; `StudioChartConfigByType` has the
`AssertChartTypesCovered` error-tuple lock), so when a new chart type is added, this list is the
one artifact the compiler will _not_ force to follow — and it gates everything:
`isStudioChartType` returning `false` makes `parseStateMutation` reject every `addWidget` for
the new type ("must be one of the known chart types", `parseStateMutation.ts:168-171`) and makes
the middleware hard-error every `add_widget`/`update_widget`
(`executeToolOnState.ts:142-145`). There is also no runtime test pinning the list's length
(`widgetTypeGuards.ts` has no test file).

**Fix:** derive the literal element types (`as const`) and add the same error-tuple assertion the
file's siblings use: `type AssertAllChartTypesListed = Exclude<StudioChartType,
(typeof STUDIO_CHART_TYPES)[number]> extends never ? true : […]`. Correct the comment and the
matching `ARCHITECTURE.md` claim.

### 2.2 `applyBulkUpdate` is the one handler that skips the reducer's own prototype-hygiene conventions on id-keyed writes

- `packages/x-studio-schema/src/applyMutation.ts:798-801` (`nextWidgets[widget.id] = widget` —
  bare bracket assignment) and `:802-806` (`const existing = nextWidgets[update.widgetId]` —
  truthy prototype-chain lookup, not `Object.hasOwn`)

Every other handler religiously uses `Object.hasOwn` for existence checks and `isSafePatchKey`
for rebuilt-record keys, and the `UNSAFE_KEYS` comment (`applyMutation.ts:53-62`) frames those
guards as "the defense-in-depth copy for mutations the server constructs WITHOUT the parser".
`applyBulkUpdate`'s widget-delta loops are the exception. Both live paths are currently shielded
— the wire path because `parseStateMutation` `isSafeId`-checks `addedWidgets[].id` and
`updatedWidgets[].widgetId`, and the server path because `executeToolOnState` mints added-widget
ids itself via `createWidgetId()` and gates updates on `liveWidgetIds` membership
(own-keys only, `executeToolOnState.ts:723, 790-795`) — so this is not currently exploitable.
But the shield lives two modules away: a future server tool that accepts a caller-supplied
widget id into `applyBulkUpdate` would find `nextWidgets['__proto__'] = widget` silently
re-prototyping the record (the widget vanishes from `Object.hasOwn` lookups) and
`nextWidgets['constructor']` resolving to `Object` as a truthy "existing widget".

**Fix:** apply `isSafePatchKey(widget.id)` / `Object.hasOwn(nextWidgets, update.widgetId)` in
the two loops, matching the file's own documented convention.

### 2.3 The `changes.config` wholesale-replace channel is a live lost-update footgun — and the middleware's `set_widget_forecast` trips it

- `packages/x-studio-schema/src/applyMutation.ts:386-404` (`changes.config` replaces the widget's
  config wholesale, documented as "matches the historical client dispatch order")
- `packages/x-studio-ai-middleware/src/executeToolOnState.ts:969-972` (verified producer:
  `changes: { config: { ...widget.config, forecast } }`)

`updateWidget` offers two config channels with opposite merge semantics: `args.config` is a
key-by-key patch merged onto the _receiver's live_ config, while `changes.config` replaces the
whole bag with the _producer's snapshot_. The `applyBulkUpdate` redesign (documented at
`mutationTypes.ts:136-151`) exists precisely to kill snapshot-replacement lost updates — yet
`set_widget_forecast` sends the server's turn-time config snapshot through `changes.config`, so
any config key the user edits client-side while the agentic turn is running (a title-font tweak,
a sort change) is reverted the moment the forecast mutation applies. (`update_widget` has a
milder variant: it sends the _merged_ snapshot through the `args.config` patch channel, which
overwrites concurrently-edited keys with snapshot values but at least preserves concurrently-
added keys.)

**Fix:** change `set_widget_forecast` to send `config: { forecast: … }` as a patch; then either
deprecate `changes.config` (no remaining producer needs wholesale replace — the sanctioned clear
affordance is `unsetConfigKeys`) or document it as reserved for full-replace semantics that no
SSE producer should use.

### 2.4 Retention-across-chartType-switch vs. the stateless full-widget wire check: any future producer that round-trips a _stored_ widget through `addWidget` will be rejected

- `packages/x-studio-schema/src/parseStateMutation.ts:158-176` (chart-family check on full
  widgets), `packages/x-studio-schema/src/widgetTypes.ts:715-722` (the retention invariant),
  pinned by `statePersistence.test.ts:419-450`

The retention invariant is real and correctly implemented everywhere today: the reducer's merge
semantics never strip cross-type keys, no schema migration strips them, `serializeDoc`
round-trips them byte-for-byte, and both write-side guards deliberately validate only the
incoming _patch_, never the stored config (`StudioController.ts:925-935`,
`executeToolOnState.ts:348-359` — both verified to resolve the effective type from the patch's
own `chartType` first, falling back to the widget's current type). But this means a _stored_
chart config legitimately fails `validateChartConfigKeysForType` for its own `chartType` — e.g.
a gauge retaining a bar-era `xField`. `validateWidget` applies exactly that check to every full
widget crossing the SSE boundary (`addWidget`, `applyBulkUpdate.addedWidgets`). Today no
producer round-trips a stored widget through those variants (verified: both middleware paths
build added widgets fresh via `buildWidgetFromArgs`), so nothing breaks — but the first
"duplicate this widget via the AI", "move widget across dashboards", or "recreate from
`get_dashboard_state` output" feature that ships a stored widget verbatim through `addWidget`
will have valid, user-authored dashboards rejected at the client boundary with
"config carries key(s) not valid for a '…' chart".

**Fix:** document the constraint at `validateWidget` ("full-widget variants may only carry
freshly-built configs; a round-tripped stored config must be stripped to its effective family's
keys first"), and/or provide a `stripForeignFamilyKeys(config)` helper in
`configKeyValidation.ts` so a future producer has a sanctioned way to do it.

## Tier 3: Minor / cosmetic

### 3.1 `serializeDoc`'s comment misstates how cross-filters interact with undo

- `packages/x-studio-schema/src/statePersistence.ts:310-317` vs
  `packages/x-studio/src/store/StudioController.ts:215-216` and
  `packages/x-studio-schema/src/stateTypes.ts:170-176`

The comment says cross-filter _and_ interactive entries are "carried forward across undo/redo by
`StudioController.carryTransientDocState` rather than being part of the undoable history".
Verified against the controller: `carryTransientDocState` carries **interactive entries only**;
cross-filters are deliberately NOT carried because they are undoable by design ("they
time-travel") — which is also what `stateTypes.ts` says. The stripping _behavior_ (both scopes
stripped at persistence) is correct and test-pinned; only the rationale sentence is wrong.
**Fix:** reword to "cross-filters are undoable but session-scoped; interactive entries are
carried across undo/redo — both are stripped at the persistence boundary."

### 3.2 The deprecated `seriesType` alias survives on the type and is normalized only at the load boundary

- `packages/x-studio-schema/src/widgetTypes.ts:76-84`, `factories.ts:149-157`,
  `statePersistence.ts:383`

`deserializeState` now normalizes persisted `ySeries` (fixing the old review's 2.3), but a live
widget written with `seriesType` via `updateWidget`/AI keeps the alias until the next reload, so
readers still must call `normalizeChartSeries` defensively (verified they do:
`StudioMixedChart.tsx:67,108`). The alias is a permanent tax on every future consumer.
**Fix:** normalize in the reducer's `updateWidget`/`addWidget` config paths too, or schedule a
migration + type removal.

### 3.3 "Zero runtime dependencies" is true, but the `@mui/x-chat-headless` _type_ dependency is undeclared for one consumer

- `packages/x-studio-schema/src/chatTypes.ts:8`, `package.json:19-21` (devDependency only)

The import is type-only (no runtime cost), but the package ships raw TS source
(`main: ./src/index.ts`), so consumers type-check it. `x-studio-ai-middleware` declares
`@mui/x-chat-headless`; `x-studio` does **not** (it declares `@mui/x-chat` — verified in its
`package.json:33-56`) and resolves the types only via pnpm workspace transitivity. Harmless
while unpublished; would break a strict-`node_modules` consumer. **Fix:** declare it as a real
(or peer) dependency of the schema package, or inline a minimal structural `ChatMessage`.

### 3.4 `chartTypeRegistry`'s sankey descriptor honors a `yAggregation` the sankey family cannot carry

- `packages/x-studio/src/internals/chartTypeRegistry.ts:219-226` vs
  `packages/x-studio-schema/src/widgetTypes.ts:521-548` (no `yAggregation` on sankey — correct
  per the renderer, which always sums via `aggregateSankey`)

A sankey widget retaining `yAggregation: 'avg'` from a previous chart type gets **avg**
pre-aggregation on the DB push-down path but **sum** on the client in-memory path — the same
widget shows different numbers depending on data-source mode. The schema's family assignment is
right (sankey sums by design); the leftover read is in the consumer. **Fix:** drop the
`yAggregation` read in `sankeyDescriptor.buildAggregationSpecs` (hardcode `'sum'`).

### 3.5 Stripped-to-empty config patches still commit a fresh widget object

- `packages/x-studio-schema/src/applyMutation.ts:367-383`

An `updateWidget` whose `config` is `{}` (e.g. the controller guard stripped every key — the 1.1
scenario) still rebuilds `config` and the widget, so the "same reference on no-op" contract is
technically kept only for unknown ids: an effect-free patch pushes an undo entry and a
`updateWidget:` log line. **Fix:** short-circuit when the config loop made no change (mirror the
`changedConfig` flag the `unsetConfigKeys` branch already uses).
