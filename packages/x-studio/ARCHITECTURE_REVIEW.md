# x-studio Architecture / Tech-Debt Review

Fresh adversarial review of `packages/x-studio` (client package only). Every finding below was
verified against the current source, not inferred from comments or prior review docs. Baseline
at review time: `tsc -p tsconfig.json` clean, `vitest --project "x-studio" --run` green
(119 files, 2015 tests).

Areas read: `src/store/` (controller, docTransforms), `src/internals/` (pipeline, caches,
filter scoping, query descriptor, chart registry, aggregators, expression evaluator),
`src/context/` (selectors, provider), `src/components/` (canvas, widget card, all seven
widget kinds, compose-drawer panels, chat panel, expression dialog).

Things checked and deliberately NOT reported as defects: the undo/redo transient-doc-state
carry and `activePageId` fallback in `StudioController.carryTransientDocState` (correct,
including the dangling-page fallback); `useAdapterRows`' cancellation and stuck-`isLoading`
handling (correct); the render-phase hover reset in `StudioChartWidget` (sanctioned React
pattern); markdown rendering of AI/user text (`markdown-to-jsx` with
`disableParsingRawHTML: true` plus a protocol allow-list URL sanitizer — no XSS);
the SSE `state-mutation` path (validated via `parseStateMutation` before
`applyExternalMutation`); the expression evaluator's AST-walking design (no eval-like
patterns anywhere in the package).

---

## Tier 1: Correctness & Security

### 1.1 Voice input silently clobbers composer text on any user-initiated stop

`src/components/StudioChatPanel/useChatVoiceInput.ts:59-68`

The "sync once more when voice ends" effect fires on **every** `isListening` true→false
transition, not only browser-initiated auto-ends, and it rebuilds the composer from the
(never-reset) `transcript` + `voiceBaseTextRef`:

- **Typing while listening:** `handleComposerValueChange` (lines 70-81) sets the typed value,
  calls `stopVoice()`, and clears `voiceBaseTextRef`. The effect then runs with the stale
  `transcript` (`useSpeechRecognition.stop()` finalises but does not reset it —
  `useSpeechRecognition.ts:14-15,106-108`) and overwrites the user's typed text with the
  transcript alone.
- **Clicking the mic off:** `handleToggleVoice` (lines 35-46) clears `voiceBaseTextRef`
  _before_ the effect runs, so pre-voice base text is dropped: composer `"Hi"` → speak
  `"there"` → composer `"Hi there"` → mic off → composer becomes `"there"`.

Fix: delete the second effect (the `[isListening, transcript]` effect at lines 49-57 already
keeps the value in sync while listening), or gate it on a "browser auto-ended" flag set by
`useSpeechRecognition` rather than on any stop; also `resetTranscript()` on user-initiated
stops.

### 1.2 Grid widget ignores the user-configured column order

`src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:148-188` builds the DataGrid
`columns` array from `allFieldIds` = **data-source field order** (+ expression fields);
`widget.config.columns` is consumed only for _visibility_ (`visibleFields` at 116-121 →
`columnVisibilityModel` at 268-273). Nothing passes an order to the grid — `initialState`
(line 501) contains only sorting, and there is no `orderedFields` / `setColumnIndex` usage.

Meanwhile `GridSetupPanel.tsx:353-376` (`handleColumnDrop`, `moveColumn`) offers drag-and-drop
**and** keyboard reordering of `config.columns`, committing the new order to the doc. The user
reorders columns, the state updates and persists, and the rendered grid never changes.

Fix: derive column order from `config.columns` (configured columns first, in order, then the
remaining fields), or feed `initialState.columns.orderedFields` /
`apiRef.current.setColumnIndex` from `config.columns`.

### 1.3 Grid height field rejects keyboard entry (controlled input gated on `>= 200`)

`src/components/StudioComposeDrawer/FormatPanel.tsx:239-246`

```tsx
value={config?.gridHeight ?? 400}
onChange={(event) => {
  const parsed = parseInt(event.target.value, 10);
  if (!Number.isNaN(parsed) && parsed >= 200) {
    controller.updateWidgetConfig(widgetId, { gridHeight: parsed });
  }
}}
```

The input is fully controlled. Typing "6" after select-all yields `parsed = 6 < 200`, the
update is dropped, and React snaps the DOM back to the old value — every intermediate
keystroke below 200 is discarded, so the field is effectively spinner-only. Fix: keep a local
string state (or clamp on blur) instead of gating the state write on validity.

### 1.4 Client chart aggregation ignores the documented per-series `yAggregation`

`StudioChartSeries.yAggregation` is a public, documented config key
(`packages/x-studio-schema/src/widgetTypes.ts:85-86`, "Aggregation function applied to this
series. @default 'sum'"), and the server push-down honours it per series
(`src/internals/chartTypeRegistry.ts:100-110`), as does the blended-series client path
(`aggregators.ts` `aggregateBlendedSeries` → per-series `s.yAggregation`, line 492).

But the plain (non-blended) client render path never passes any aggregation:

- `src/components/widgets/StudioChartWidget/useChartWidgetData.ts:342-377` (`multiYData`)
  calls `aggregateMultipleSeries(rows, xField, activeYFields, xGroupBy, sortBy, sortDir,
orderedValues)` — the trailing `yAggregation` parameter (`aggregators.ts:397`) is never
  supplied, so every non-blended multi-series chart renders **sum**, whatever the config says.
  `aggregateMultipleSeries` also only accepts one fn for all series, so per-series fns cannot
  be honoured even if passed.
- `useChartWidgetData.ts:210-246` (`seriesFieldData`, split-by charts) likewise never passes
  the `yAggregation` parameter of `aggregateByTwoFields` (`aggregators.ts:336`), so split-by
  charts always sum even when `config.yAggregation` is set.

Failure scenario: an AI `update_widget` (or host code) sets
`ySeries: [{ fieldId: 'price', yAggregation: 'avg' }, …]` on a line chart. On an
adapter-backed source the server pre-aggregates per category with `avg` and the client's sum
over one row per category preserves it → chart shows averages. On an in-memory source the
client sums raw rows → same widget, same doc, different numbers. (The setup panel itself never
authors per-series fns — its helper text hard-codes "sum" — which is why this survives manual
testing.)

Fix: thread per-series aggregation through `aggregateMultipleSeries` (per-field fn map) and
pass `config.yAggregation` to `aggregateByTwoFields`; or remove `yAggregation` from
`StudioChartSeries` and stop honouring it in `buildXYAggSpecs` so client and server agree on
"multi-series is always sum".

### 1.5 Duplicate same-alias aggregation specs when `yField` and `ySeries[0]` name the same field

`src/internals/chartTypeRegistry.ts:88-111` (`buildXYAggSpecs`) pushes an AggSpec for
`config.yField` (fn = `config.yAggregation ?? 'sum'`) **and** one per `config.ySeries` entry
(fn = `s.yAggregation ?? 'sum'`), each aliased to the raw field id, with no dedup — and
`buildAggregations` (`src/internals/queryDescriptor.ts:126-146`) forwards the list verbatim.

The setup panel routinely creates the overlapping state: picking a measure field writes
_both_ keys — `ChartSetupPanel.tsx:692-697`
(`{ ySeries: [{ fieldId }], yField: fieldId, … }`). With default fns the result is a
harmless-but-wasteful duplicate `sum` spec. The conflict case is real, though: switch that
chart to `gauge` (stored config deliberately retains `ySeries` across type switches — see
`StudioController.updateWidgetConfig`'s chart-type-guard comment) and set the gauge
aggregation to `avg` (`GaugeConfigSection.tsx:48-52`). The descriptor now contains
`[{field: 'revenue', fn: 'avg', alias: 'revenue'}, {field: 'revenue', fn: 'sum', alias:
'revenue'}]` — two aggregations with the same SQL alias; which one the widget displays on an
adapter source depends on how the backend resolves the duplicate column alias.

Fix: de-duplicate by alias in `buildXYAggSpecs` (skip the `yField` spec when the same field id
appears in `ySeries`), preferring the more specific per-series fn — or the `config.yAggregation`
fn for the `yField`-authored entry, but pick one deterministic winner.

### 1.6 Measure expressions count null/non-numeric rows as 0 (unreachable NaN guard)

`src/utils/expressionEvaluator.ts:360-367` and `:426-435`

```ts
const values = rows.flatMap((r) => {
  const v = toNumber(r[expr.id]);
  return Number.isNaN(v) ? [] : [v];
});
```

`toNumber` (lines 63-69) maps `null`/`undefined`/unparseable to `0` and never returns `NaN`,
so the `Number.isNaN(v)` skip is unreachable — the clearly intended "skip non-numeric rows"
behaviour never happens. Every null row enters the aggregate as `0`, skewing `avg`
(denominator inflated), `min` (always ≤ 0 with any null present), and `count`.

This directly contradicts the KPI widget's own physical-field path:
`kpiUtils.ts:225-248` (`computeAggregate`) explicitly filters null/undefined "so they don't
inflate the denominator for avg". Concrete divergence: a KPI showing `avg(price)` on the raw
field vs. a KPI on a measure expression field wrapping the same `price` yield different
numbers on any dataset with nulls (`evaluateMeasure` is consumed by
`StudioKpiWidget.tsx:120,442` and the data drawer).

Fix: test `r[expr.id]` for null/non-numeric _before_ coercing (mirror `computeAggregate`),
in both the field-expression branch and the conditional-operator row loop.

### 1.7 Date-range reconciliation effect commits an undoable doc mutation (undo trap, redo wipe)

`src/components/StudioCanvas/StudioDateRangeBar.tsx:97-112`

The "expand stale single-source filters" effect calls
`controller.setDashboardDateRangeAll(...)` whenever an active preset doesn't cover every
source. That controller method (`StudioController.ts:1224-1241`) commits through
`commitDocPatch` with default options — i.e. **undoable** and redo-clearing.

Failure scenario: a persisted dashboard has a date-range preset; the host later injects a
second source with date fields. On mount the effect silently pushes an undo entry. Worse,
undo can never cross it: Ctrl+Z reverts the coverage filters → the effect sees uncovered
sources → re-applies → pushes a fresh undo entry **and clears the redo stack**
(`commitState`, `StudioController.ts:145-157`). The user loses their redo history and is
stuck bouncing on this system mutation.

Fix: commit this reconciliation non-undoably (an `{ undoable: false }` option threaded through
`setDashboardDateRangeAll`, matching the convention used for interactive filters and
cross-filter toggles), since it is system-initiated normalization, not an authored edit.

### 1.8 CSV formula injection in pivot export

`src/components/widgets/StudioPivotWidget/pivotUtils.ts:125-150` (`pivotToCsv`)

Row/column labels come straight from user data and are emitted via `JSON.stringify(...)`,
which quotes/escapes for CSV but does not neutralize spreadsheet formula injection: a label
value like `=HYPERLINK("http://evil","click")` or `+cmd|' /C calc'!A0` opens as a live
formula in Excel/Sheets. Numeric cells are safe (`formatCell` emits numbers only); the label
column and header row are the exposure. Standard fix: prefix cells starting with
`=`, `+`, `-`, `@` (or tab/CR) with `'` before quoting, in a shared CSV-escape helper (the
grid export in `internals/widgetUtils.tsx` should use the same helper).

---

## Tier 2: Design smells

### 2.1 The same aggregate-reduction is implemented five times, with divergent null semantics

- `src/components/widgets/StudioKpiWidget/kpiUtils.ts:225` — `computeAggregate` (skips
  null/undefined, coerces booleans, supports `count_distinct`)
- `src/components/widgets/StudioMapWidget/StudioMapWidget.tsx:84-100` — `aggregateValues`
  (caller does `parseFloat` filtering)
- `src/components/widgets/StudioPivotWidget/pivotUtils.ts:14-46` — `addToAgg`/`resolveAgg`
- `src/utils/expressionEvaluator.ts:442-462` — `aggregate` (nulls become 0, see 1.6)
- `src/internals/aggregators.ts` — `CellAcc`/`finalizeCell`

Five hand-rolled sum/avg/min/max/count reducers with subtly different null/boolean/NaN
handling is exactly how 1.6-style divergences appear. Extract one shared
`aggregate(values, fn)` + one shared "numeric coercion + skip" policy in `internals/` and
route all five call sites through it.

### 2.2 Expression editor bypasses the locale system entirely

`src/components/StudioExpressionFieldDialog/ExpressionNodeEditor.tsx:36-64`
(`OPERATOR_OPTIONS` labels), `:110` (`AGGREGATION_OPTIONS`), `:434-438` (input labels
"Condition"/"Then"/"Else"/"Unit …"), `:467` ("Add input");
`StudioExpressionFieldDialog.tsx:242` ("Output type:").

The package has a comprehensive `localeText` system (2112-line default + fr/es/de/ptBR
locales) and the dialog already imports `useStudioLocaleText` for its other strings. The
`AGGREGATION_OPTIONS` case is also duplication: `aggFnSum`/`aggFnAverage`/`aggFnMin`/
`aggFnMax`/`aggFnCount` keys already exist and are used by every other panel.

### 2.3 `StudioRequestCache.invalidateSource` does not cover in-flight requests

`src/internals/StudioRequestCache.ts:138-151` clears cached entries and bumps the generation
so an in-flight result is not _written back_ — but it leaves the promise in `this.inflight`.
A widget whose effect re-runs after invalidation (`useAdapterRows.ts:104-114` — e.g.
`upsertDataSource` changed the `dataSource` identity) misses the cache, finds the stale
in-flight promise via `getInflight`, joins it, and renders pre-invalidation rows with no
follow-up fetch scheduled (loading state cleared, nothing pending). The documented tradeoff
covers callers _already awaiting_; callers arriving _after_ invalidation should not join.
Fix: drop (or generation-tag) the source's in-flight keys in `invalidateSource` so
post-invalidation callers start a fresh request.

### 2.4 `handleRemoveSeries` misses the BL-186 fieldless-count re-lock

`src/components/StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx:249-255` vs
`:257-269`. `handleSeriesFieldChange` forces `yAggregation: 'count'` whenever the resulting
series list has no field (the documented BL-186 invariant); `handleRemoveSeries` performs the
same "series list changed" transition without the re-lock. Removing the last field-bearing
series (e.g. `[{fieldId:'a'}, {fieldId:''}]` → remove index 0) leaves a fieldless chart with
a stale `sum` — the exact blank-chart state BL-186 exists to prevent. Extract the shared
"commit ySeries + derive yField/yAggregation" helper both handlers call.

### 2.5 Cross-filter selector inconsistency on the `disabled` flag

`src/context/selectors.ts:399-408` (`makeSelectActiveCrossFilter`) excludes `f.disabled`
entries; `:557-575` (`makeSelectWidgetActiveCrossFilter`, used by `StudioWidgetCard` for the
removable cross-filter chip) omits the `!f.disabled` clause. No production path currently
sets `disabled` on a cross-filter, so this is latent — but the two selectors answer the same
question and should share the predicate.

### 2.6 Copy-pasted control blocks across setup panels

- Legend position/alignment: `FormatPanel.tsx:251-309` (map) vs `:310-369` (heatmap) —
  near-identical ~60-line blocks differing only in the config-key prefix.
- Sort-direction toggle: `ChartSetupPanel.tsx:512-540` vs `HeatmapAxesSection.tsx:124-154` —
  identical asc/desc `ToggleButtonGroup`, differing only in `chartSortDirection` vs
  `heatSortDirection`.
- KPI aggregation-options derivation: `KpiSetupPanel.tsx:109-117` (render) duplicated inside
  the field `onChange` at `:255-263`, already drifting (`||` vs `??`).

Each wants a small shared component/helper so the pairs cannot drift.

### 2.7 God components

`StudioWidgetCard.tsx` (725 lines: ~10 selector subscriptions, drag wiring, export dispatch
for four widget kinds, anomaly state, AI-insight routing, dialogs, card shell) and
`StudioKpiWidget.tsx` (920 lines) both carry `react-doctor-disable` size waivers. The KPI file
is at least hook-decomposed; the widget card mixes unrelated concerns (export logic in
particular belongs beside each widget kind, mirroring the `setupPanel` pattern).

### 2.8 `/widget` endpoint response applied to state without validation

`src/components/StudioChatPanel/createWidgetFromDescription.ts:91-102` spreads
`data.config as StudioWidget['config']` from server JSON straight into a widget and commits
it. The sibling SSE `state-mutation` path validates through `parseStateMutation` before
`applyExternalMutation`; this path should get the same treatment (at minimum
`validateConfigKeysForKind`/`validateChartConfigKeysForType`, which `updateWidgetConfig`
applies but `addWidget` does not).

### 2.9 Chat adapter assumes strict single-flight streaming

`src/components/StudioChatPanel/studioBackendAdapter.ts:166,432,443,459-460` — `activeReader`
is a single factory-closure variable shared by all `sendMessage` calls. The panel explicitly
supports switching threads mid-stream (the `StreamThreadPin` machinery), so overlapping
streams are reachable; when they overlap, the first stream's `finally { activeReader = null }`
nulls the second stream's reader and `stop()` becomes a no-op for the live stream. Track
readers per request (e.g. a `Map` keyed by an id, or capture the reader in the request scope).

### 2.10 "Retry" appends a duplicate turn instead of regenerating

`src/components/StudioChatPanel/StudioMessageActions.tsx:49-58` — the assistant-message retry
button re-sends the preceding user message via `sendMessage`, which appends a new user turn +
new answer; nothing truncates or replaces the failed answer, so the thread accumulates
duplicate questions. If regeneration-in-place isn't supported by the headless layer, the
action should at least be labeled as "ask again" semantics deliberately.

---

## Tier 3: Minor / cosmetic

### 3.1 Corrupted comments: "e.g." mangled to "event.g."

`src/components/StudioComposeDrawer/MapSetupPanel.tsx:51` and `:71` — an automated
`e` → `event` parameter rename ran over comment text ("event.g. a joined country field").

### 3.2 Hardcoded-English stragglers in otherwise-localized surfaces

- `src/components/widgets/StudioKpiWidget/KpiTrend.tsx:135` — literal `vs. {periodShort}`.
- `src/components/widgets/StudioKpiWidget/kpiUtils.ts:338-360` — hardcoded `MONTH_ABBR`
  English month names in `formatPeriodShort`, while sibling `formatDateRangeLong` correctly
  uses `toLocaleDateString`.
- `src/components/StudioWidgetCard/StudioWidgetCard.tsx:624-627` — untitled-widget fallback
  renders `'KPI'` / capitalized raw kind string.
- `src/components/widgets/StudioPivotWidget/pivotUtils.ts:131,147` — CSV `'Total'` header;
  `src/components/StudioComposeDrawer/GridConditionalFormatSection.tsx:126` — `'value'`
  placeholder.

### 3.3 Stale comment: preset id described as `Date.now()`-based

`src/store/docTransforms.ts:192-195` says the preset id is "a `Date.now()`-based side effect
the controller owns"; the controller (`StudioController.ts:1377-1381`) now mints ids via the
collision-resistant `createPresetId` and explicitly contrasts it with the old
`preset-${Date.now()}` scheme.

### 3.4 Gauge min/max inputs accept unvalidated values

`src/components/StudioComposeDrawer/ChartSetupPanel/GaugeConfigSection.tsx:63-84` writes raw
`Number(evt.target.value)` for `gaugeMin`/`gaugeMax` with no NaN guard, no bounds, and no
`min < max` check — unlike sibling sections (Funnel/Scatter/PieArcLabels all clamp).
`gaugeMin > gaugeMax` is storable.

### 3.5 Conditional-format value input: `Number('')` → 0 and visible `NaN`

`src/components/StudioComposeDrawer/GridConditionalFormatSection.tsx:123-137` — clearing a
numeric rule value stores `0` (silent semantic change); a partially typed non-number stores
`NaN`, which the value display (`String(rule.value)`) renders literally.

### 3.6 KPI panel repairs an invalid aggregation in the UI but not in the doc

`src/components/StudioComposeDrawer/KpiSetupPanel.tsx:119-121` — when the stored
`kpiAggregation` is invalid for the field type, the Select _displays_ a valid fallback but the
doc keeps the invalid value; the KPI renderer reads the doc, so panel and widget can disagree
until the user touches the field. Normalize on read in the renderer or write back on detect.

### 3.7 Widget-drag body flag leaks if the card unmounts (or leaves edit mode) mid-drag

`src/components/StudioWidgetCard/StudioWidgetCard.tsx:356-374` sets
`document.body.dataset.studioDraggingWidgetId` and inline card opacity in `onDragStart`,
cleared only in `onDrop`. `useStudioDraggable`'s effect cleanup
(`StudioCanvas/useStudioDraggable.ts:50-88`) deregisters the draggable on unmount or
`canDrag` flip but does not run the `onDrop` cleanup, so the body flag (and any global CSS
keyed on it) can stick. Clear the flag in the effect cleanup too.

---

**Totals: Tier 1 — 8 · Tier 2 — 10 · Tier 3 — 7**
