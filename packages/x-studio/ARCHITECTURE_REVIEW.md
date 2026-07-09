# x-studio Architecture Review — Iteration 3 (2026-07-09)

Fresh, adversarial review of `packages/x-studio/src` at commit `065c115` (branch
`claude/branch-identification-y0rapm`), performed from scratch without relying on prior
review history or `ARCHITECTURE.md` claims. Every Tier 1 finding was **empirically
verified** — either by executing the actual package source via `tsx` (repro results
quoted inline) or by direct code-path tracing where the defect is pure geometry/wiring.
Line numbers refer to the reviewed commit.

## Summary

**Baseline:** `tsc -p tsconfig.json` is clean and the full unit suite passes
(134 files, 2204 tests) at the reviewed commit. None of the findings below are caught
by it — several sit exactly in the blind spots of existing tests (e.g. the controller
test for unknown-id `updateWidget` exercises only the one branch that doesn't crash;
the filter-widget test asserts `not_in` reaches the controller but never tests row
semantics).

**Verdict: a fix round is needed.** The headline items are silent-wrong-data bugs
(multi-select _Exclude_ filters inverting dashboard-wide data; OR filter conditions
silently becoming AND — and eight operators silently dropped — on adapter-backed
sources; numeric-string measures rendering all-zero charts; temporal line charts
pairing sorted dates with unsorted values; KPI trend windows inverted for "until X"
filters), one data-loss bug (persisted AI chat history destroyed by an unrelated
Ctrl+Z), one crash regression introduced by the same-day no-op/transform fix in
`StudioController`, and several broken render paths (multi-measure line/area charts
always empty; forecast overlay shifted one period late; Gantt bars on a different
x-scale than their axis; same-row rightward drag landing in the wrong slot). Tier 2
collects real but narrower defects. The undo/redo core semantics, the AI-mutation wire
validation, CSV-injection and markdown-XSS hardening, locale bundles,
prototype-pollution defenses, and the persistence boundary all checked out sound (see
"Notes on documented tradeoffs").

---

## Tier 1 — Correctness & Security

### 1.1 Multi-select filter widget "Exclude" mode is inverted — keeps ONLY the excluded values

- **Where:** `src/internals/filterUtils.ts:117-124` (selection-mode branch of
  `compileRowTest`) vs `src/components/widgets/StudioFilterWidget/StudioFilterWidget.tsx:253-266`
  (emits `operator: 'not_in'` with `filterMode: 'selection'`).
- **What:** the selection-mode compile path never consults `operator` — it always
  builds the inclusion test `selectedSet.has(String(row[field] ?? ''))`. The
  multi-select Exclude toggle (`MultiSelectControl.tsx:170-195`) flips the operator to
  `not_in`, but the compiled row test is byte-identical to `in`.
- **Verified repro:** rows `[Books, Games, Toys]`, selection filter
  `{ operator: 'not_in', value: ['Books'] }` → `applyFilters` returns `['Books']`.
  Expected `['Games', 'Toys']`.
- **Impact:** every widget on the page filters **to exactly the values the user asked
  to exclude** — silent, dashboard-wide wrong data. `StudioFilterWidget.test.tsx:103-107`
  only asserts `not_in` reaches the controller; nothing tests row semantics.
- **Fix shape:** negate the selection test when `operator === 'not_in'`.

### 1.2 Persisted AI chat history is destroyed by an unrelated undo

- **Where:** `src/store/StudioController.ts:237-282` (`carryTransientDocState`) +
  `src/components/StudioChatPanel/useChatThreads.ts:96-113` (non-undoable `doc.ai`
  write-backs).
- **What:** chat-thread state lives in `doc.ai` (it **is persisted** by `serializeDoc`)
  but is written with `{ undoable: false }` — deliberately outside the authored-edit
  timeline. `carryTransientDocState` carries interactive filters, the two cross-filter
  toggles, and `activePageId` across undo/redo doc swaps — but **not `doc.ai`**, so an
  undo swaps in a doc snapshotted _before_ the conversation existed. Because ChatBox is
  fully controlled, the conversation visibly disappears too.
- **Verified repro:** (1) `addPage(...)` pushes an undo snapshot without `ai`;
  (2) a chat write-back sets `doc.ai` non-undoably; (3) `undo()` → `doc.ai` is gone;
  (4) any new edit clears the redo stack → chat history **permanently lost**.
- **Impact:** Ctrl+Z on a dashboard edit silently deletes the user's persisted chat
  threads; one further edit makes the loss unrecoverable. This is exactly the
  transient-doc-state staleness class the earlier carry fix addressed for interactive
  filters — `doc.ai` was never added to the carry set.
- **Fix shape:** overlay `currentDoc.ai` onto the incoming doc in
  `carryTransientDocState` (same pattern as the cross-filter toggles), preserving the
  identity-preservation contract.

### 1.3 `updateWidget` / `updateWidgetConfig` throw `TypeError` on an unknown widget id (regression from the same-day no-op/transform fix)

- **Where:** `src/store/StudioController.ts:935-947` (`updateWidget` transform) and
  `:1037-1047` (`updateWidgetConfig` transform), interacting with `commitMutations`'
  post-transform no-op check at `:452-461`.
- **What:** commit `df6c2b7` deliberately moved the no-op check to _after_ `transform`
  runs, so `transform` now executes even when the reducer no-ops — including the
  unknown-widget-id no-op. The `addWidget`/`insertWidgetAt`/`moveWidget` transforms
  were given `Object.hasOwn` guards in that same commit, but the two title-inference
  transforms were not: they dereference `next.doc.widgets[widgetId]` unguarded and pass
  `undefined` into `applyInferredTitles` → `inferWidgetTitles` reads `.sourceId` of
  `undefined`.
- **Verified repro:** `controller.updateWidget('does-not-exist', { sourceId: 'foo' })`
  and `controller.updateWidgetConfig('does-not-exist', { xField: 'a' })` both throw
  `TypeError: Cannot read properties of undefined (reading 'sourceId')`.
- **Impact:** violates the controller's own documented guard-and-continue convention
  (every sibling method no-ops on unknown ids; the reducer's `Object.hasOwn` guards
  exist specifically to make bad ids safe). Reachable by (a) host/custom-widget code
  following the documented integration guidance (`src/models/customWidgetTypes.ts:28`
  tells setup-panel authors to call `controller.updateWidgetConfig(widgetId, …)`) with
  a stale id, and (b) a stale-id race with an AI `removeWidget` SSE mutation (which
  leaves the selection dangling — see 2.2). Existing coverage misses it precisely:
  `StudioController.test.ts:901` tests `updateWidget('nope', { title: 'x' })` — the one
  variant where `isExplicitTitleChange` suppresses the transform.
- **Fix shape:** guard both transforms with `Object.hasOwn(next.doc.widgets, widgetId)`
  and add a test for the non-title-change branch.

### 1.4 OR filter conditions silently become AND on adapter-backed sources

- **Where:** `src/server/createBatchingAdapter.ts:945-978` (`flattenFilterNode`).
- **What:** a leaf filter with a second condition (`op2`/`value2`) is emitted as two
  separate predicates (`:968-976`) with **no check of `node.conjunction`**; the data
  middleware ANDs every predicate (`x-studio-data-middleware/src/router/queryBuilder.ts:124`).
  The client evaluator honors OR (`filterUtils.ts:135`) and the filters drawer lets
  users pick OR (`filterDrawerUtils.ts:278`).
- **Concrete failure:** page filter "x < 5 **OR** x > 100" on an adapter source →
  server receives `x < 5 AND x > 100` → 0 rows, with **no client-side recovery**
  (`useWidgetRows.ts:319-325`: page/widget filters are enforced only server-side on
  the adapter path). The identical filter works on in-memory sources.
- **Related (latent):** the group branch (`:946`) flattens children ignoring
  `logic: 'or'`; the comment (`:941-943`) claims OR groups are "skipped server-side…
  safe/conservative" but the code neither skips nor preserves them. Currently
  unreachable (`queryDescriptor.ts:43-47` only builds `logic: 'and'` groups), but the
  comment is wrong and the type invites a future producer to hit it.

### 1.5 Eight filter operators silently dropped on adapter-backed sources — filter has no effect

- **Where:** `src/server/createBatchingAdapter.ts:924-951` (`OPERATOR_MAP` /
  `mapOperator`).
- **What:** `OPERATOR_MAP` maps only 9 of the 17 `StudioFilterOperator`s
  (`x-studio-schema/src/baseTypes.ts:68-85`). `not_in`, `does_not_contain`,
  `starts_with`, `not_starts_with`, `ends_with`, `not_ends_with`, `is_empty`,
  `is_not_empty` → `mapOperator` returns `null` → the predicate is dropped **before
  the request is sent**, and nothing re-applies page/widget filters client-side on the
  adapter path.
- **Impact:** a "status starts with…" or "notes is empty" filter silently shows all
  rows on a db-tier source while behaving correctly on an in-memory source. Silent,
  user-visible wrong data with no warning. Either extend the wire protocol/queryBuilder
  or fall back to client-side enforcement for unmappable predicates.

### 1.6 Numeric-string measures render all-zero charts

- **Where:** `src/internals/aggregators.ts:257-267` vs `:281` (same pattern at
  `:399-412` vs `:449`); root cause `src/internals/aggregate.ts:39-47`
  (`coerceAggregateValue` returns `null` for **all** strings).
- **What:** the "non-numeric measure → fall back to count" pre-detect uses
  `Number.isNaN(Number(v))`, so a numeric _string_ (`"12"`) passes as numeric — but
  accumulation routes through `coerceAggregateValue`, which rejects every string.
  All values are skipped and `finalizeCell(...) ?? 0` renders 0.
- **Verified repro:**
  `aggregateByField([{cat:'A',amount:'10'},{cat:'A',amount:'5'},{cat:'B',amount:'7'}], 'cat','amount')`
  → `{labels:["A","B"],values:[0,0]}`. `aggregateByTwoFields` has no pre-detect at all
  → all-null cells.
- **Impact:** any CSV/JSON-fed source whose numbers arrive as strings shows flat-zero
  charts — silent wrong data, no error. Either coerce numeric strings in
  `coerceAggregateValue` or make the pre-detect and the accumulator agree on what
  counts as numeric.

### 1.7 Temporal line/area x-axis pairs internally-sorted dates with unsorted series values

- **Where:** `src/internals/temporalUtils.ts:407-423` (`getTemporalAxisData` sorts
  labels ascending internally) +
  `src/components/widgets/StudioChartWidget/chartWidgetHelpers.ts:315-331`
  (`createLineXAxisConfig` uses the sorted dates as axis `data` while callers pass
  series `data` aligned to the **original** label order).
- **Verified repro:** labels `['2024-03','2024-02','2024-01']`, values `[30,20,10]` →
  axis dates come back `[Jan, Feb, Mar]`, so Jan is plotted with March's value 30 and
  Mar with 10.
- **Impact:** every temporal line/area chart whose labels are not already ascending —
  `chartSortDirection: 'desc'`, `chartSortBy: 'value'`, or a rank widget filter
  (`applyRankToAggregated` returns value-ranked order) — plots values against the
  wrong dates. Silent wrong data.

### 1.8 Multi-measure line/area charts always render an empty box

- **Where:** `src/components/widgets/StudioChartWidget/chartTypeDefs.tsx:293-295`
  (`renderLineArea` guards `!chartData → EmptyChartBox`) vs
  `useChartWidgetData.ts:376-378` (returns `chartData = null` whenever
  `isMultiSeries`).
- **What:** a line/area chart with 2+ y-fields — explicitly allowed by the setup panel
  (`ChartSetupPanel.tsx:148-156` includes line/area/area-stacked/area-100 in
  `supportsMultipleSeries`) — hits the `!chartData` guard and renders the empty
  placeholder. `StudioLineAreaChart` has a complete multi-Y implementation
  (`:292-414`) that is dead code via the widget path; `renderBar` handles exactly this
  case with an explicit `hasMultiY` check _before_ the guard
  (`chartTypeDefs.tsx:179-188`). Git history shows the pre-registry if-chain had the
  same hole — faithfully preserved, long broken.

### 1.9 Forecast overlay is shifted one period late and drops the first prediction

- **Where:** `src/internals/forecastUtils.ts:231-254`.
- **What:** `forecastSeries = [...Array(n).fill(null), values[n-1],
...forecastValues.slice(1)]` places the connection point at index **n** (the first
  _future_ label) instead of `n-1`, and discards `forecastValues[0]`.
- **Verified repro:** labels `['2024-01'..'2024-04']`, values `[10,20,30,40]`,
  periods 2 → `forecastSeries = [null,null,null,null,40,60]`: May renders the April
  _actual_ (40) instead of the prediction (50), June renders 60, and with
  `connectNulls: false` the dashed line never connects to the historical series
  (contradicting the code's own comment). Confidence bands shift identically.
  Correct: `[...Array(n-1).fill(null), values[n-1], ...forecastValues]`.

### 1.10 Gantt bars are positioned on a different x-scale than the axis/gridlines

- **Where:** `src/components/widgets/StudioChartWidget/StudioGanttChart.tsx:141-183`
  (ticks as % of `width − LABEL_W`) vs `:250-253` (bars as
  `left: calc(140px + leftPct%)` of the **full** container width).
- **What:** pure geometry mismatch — bars drift right of their gridlines
  proportionally to date; an item starting near `maxMs` lands at `140px + ~100%`,
  past the right edge (silently clipped by `overflow: hidden`). Bar widths are
  over-scaled by the same factor.

### 1.11 KPI `extractDateRange` inverts single-sided "until X" date filters → wrong trend/sparkline windows

- **Where:** `src/components/widgets/StudioKpiWidget/kpiUtils.ts:117-129`.
- **What:** any single-sided date condition falls through to
  `if (v1) { return { start: v1, end: new Date() } }` without consulting the operator.
  For `operator: 'less_than_or_equal', value: '2024-06-30'` ("until 2024-06-30") the
  derived "current period" becomes `[2024-06-30 → today]` — exactly the region the
  filter **excludes**.
- **Verified:** `until 2024-06-30` → `{ start: 2024-06-30, end: today }`.
- **Impact:** `computeFilterBasedTrend` (`StudioKpiWidget.tsx:233-242`) derives the
  previous-period window from the inverted range, so the KPI headline (rows ≤
  2024-06-30) is compared against a nonsense window; `useKpiSparkline` also auto-picks
  granularity from it. Contrast `internals/widgetUtils.tsx:282-287`, which handles the
  same operators correctly for display ("until X").

### 1.12 Same-row rightward drag-and-drop lands the widget one slot too far right

- **Where:** `src/components/StudioCanvas/StudioCanvas.tsx:210-217` (`handleDrop`,
  `DRAG_TYPE_CANVAS_WIDGET` branch).
- **What:** the handler first removes the dragged widget from the rows
  (`rows = currentRows.map(r => r.filter(id => id !== widgetId))`) and then splices at
  the gap's **pre-removal** `colIndex`. For a rightward move within the same row, the
  removal shifts everything after the widget left by one, so the insertion index is
  one too far. Row `[a, b, c]`, drag `a` onto the gap between `b` and `c`
  (colIndex 2, which `isAdjacentToDraggingWidget` does **not** disable) → filter
  `[b, c]`, `splice(2, 0, 'a')` → `[b, c, a]`; expected `[b, a, c]`. The drop lands
  somewhere other than the blue drop indicator. Leftward moves are unaffected
  (removal index > insertion index); the existing drop tests only move widgets in from
  a _different_ row.

---

## Tier 2 — Design smells & narrower defects

### State management / controller

- **2.1 Date-range doc transforms violate their own identity contract → phantom undo
  entries.** `src/store/docTransforms.ts:81-190` (`setDashboardDateRange`,
  `setDashboardDateRangeAll`, `setWidgetDateRange`) always return
  `{ ...doc, filters: <fresh array> }` even when nothing changed, against the module
  contract at `:15-18` ("…or the SAME `doc` reference for a logical no-op") that the
  sibling preset transforms carefully implement. **Verified:** clearing a nonexistent
  dashboard range → `canUndo() === true`; re-applying the identical preset → two
  deep-equal undo entries and a cleared redo stack (MUI `Select` fires `onChange` even
  when re-picking the current item); `setWidgetDateRange(w, null, …)` with no filter →
  phantom entry.
- **2.2 AI-driven `removeWidget` and any `removePage` leave
  `session.shell.selectedWidgetId` dangling.** `applyExternalMutation`
  (`StudioController.ts:383-385`) has no selection-reset transform, and `removePage`
  (`:1546-1553`) claims "no client-only effect" — wrong, since removing a page removes
  its widgets. **Verified:** both paths leave the removed widget's id selected
  (user-driven `removeWidget` correctly nulls it). Consequence:
  `StudioComposeDrawer.tsx:113-118` renders `WidgetConfigView` for any truthy id, which
  returns `null` for a missing widget — the compose drawer shows **blank content**
  instead of the add-widget view. The dangling id is also the enabling condition for
  crash 1.3.
- **2.3 Per-keystroke undoable commits in setup panels.**
  `GridConditionalFormatSection.tsx:199-203`: the string-value `TextField` calls
  `controller.updateWidgetConfig` on every keystroke — each an undoable commit plus a
  mutation-log line (log cap 20) plus a full pipeline recompute; typing "Overdue" costs
  7 undo entries and Ctrl+Z then un-types one character at a time. The file's own
  header documents why the _numeric_ input was converted to buffered commit-on-blur —
  the string branch was missed. Same class: `AnnotationsEditorSection.tsx:157-166`
  (label field), `FilterSetupPanel.tsx` slider min/max/step,
  `ScatterConfigSection.tsx:70-95` (radii; also `Number(v) || 4` snaps a cleared input
  to the default), `PieArcLabelsSection.tsx` min-angle, `FunnelConfigSection.tsx` gap,
  `ColorInput.tsx` (native color-picker drag commits continuously).
- **2.4 KPI setup panel's aggregation "repair" effect is undoable and fights the undo
  stack.** `KpiSetupPanel.tsx:151-155` repairs an invalid stored `kpiAggregation` via a
  plain (undoable, logged) `updateWidgetConfig` fired from merely _rendering_ the
  panel: opening the panel can push an unauthored undo entry, and undoing past the
  repair re-commits it and **clears the redo stack**, so undo can never get past that
  point while the panel is mounted. `StudioDateRangeBar.tsx:112-122` documents the
  correct `{ undoable: false }` pattern for exactly this hazard.
- **2.5 Gauge cross-source field pick commits two separate undo steps.**
  `GaugeConfigSection.tsx:88-93` calls `updateWidgetConfig({ yField })` then
  `updateWidget({ sourceId })` — one Ctrl+Z lands on a torn
  `{ old sourceId, new yField }` state the UI never produced. Every sibling panel
  (`ChartSetupPanel.tsx:437-444`, `KpiSetupPanel.tsx:306-313`,
  `FilterSetupPanel.tsx:108-118`, `MapSetupPanel.tsx:157-160`) folds this into a single
  commit; Gauge was missed.
- **2.6 Rank-filter guard asymmetry.** `updateFilter`
  (`StudioController.ts:1174-1214`) enforces one-rank-per-page via
  `hasConflictingRankFilter`; `addFilter` (`:1136-1149`) and the reducer's `addFilter`
  (idempotence only, `applyMutation.ts:945-961`) don't — an AI `add_page_filter` or
  host call can create a second rank filter on the same page, the invariant the update
  path rejects with a dev warning.
- **2.7 Layout-write validation asymmetry.** The public `setWidgetLayout`
  (`StudioController.ts:762-804`) throws on unknown AND omitted ids; the reducer
  handler (`applyMutation.ts:706-753`) silently drops unknown ids and silently
  _orphans_ widgets omitted from `rows` (they stay in `doc.widgets` but vanish from
  every row). `insertWidgetAt`, `commitWidgetMove`, and `duplicateWidget` feed
  caller-computed geometry straight to the reducer with no orphan check — a canvas
  geometry bug (cf. 1.12) silently disappears widgets. A dev-mode orphan warning at the
  reducer or `commitWidgetMove` level would surface such bugs.

### Filters / expressions

- **2.8 Cyclic expression-field references crash with unbounded recursion.**
  `src/utils/expressionEvaluator.ts:132-143`: a field ref not present in the row is
  resolved by recursively evaluating the referenced expression field with **no
  visited set**. **Verified:** two fields referencing each other →
  `RangeError: Maximum call stack size exceeded`. Cycle validation exists
  (`detectCycles`) but is enforced only in the expression dialog's save button —
  `addExpressionField`/`updateExpressionField` (`StudioController.ts:638/649`) and
  `loadSerializedState` accept anything, so a persisted doc or host call can introduce
  a cycle that hard-crashes `enrichRowsWithExpressions` (no catch) during widget
  render.
- **2.9 Date-field `equals`/`not_equals` filters bypass all date normalization.**
  `filterUtils.ts:148-154`: gt/lt/between route both sides through `toComparable`
  (resolving `RelativeDateValue` objects and normalizing Date/ISO/timestamp), but
  equals compiles to raw `row[field] == filterVal`. Reachable from the filters drawer:
  "On" (equals) + relative mode stores a `{ relative: true, … }` object that never
  equals anything → the filter silently hides all rows; for `datetime` fields the
  picker commits `'YYYY-MM-DD'` which never loose-equals a value carrying a time
  component.
- **2.10 Temporal cross-filter click emits a value that matches no rows.**
  `StudioChartWidget.tsx:408` converts a non-grouped temporal axis click via
  `label.toISOString()` (`'2024-01-15T00:00:00.000Z'`) while `date`-typed fields are
  ingestion-normalized to `'YYYY-MM-DD'` (`temporalUtils.ts:156`) and `equals` is a
  loose `==` — every downstream widget filters to zero rows, and the source chart's
  own-selection highlight never matches (`:562-587`). Works for `datetime` fields and
  grouped axes (`between` + `periodKeyToDateRange`).

### Adapter / AI-chat plumbing

- **2.11 `count_distinct` silently downgraded to `count` on adapter sources.**
  `createBatchingAdapter.ts:780` and `:873` map `fn === 'count_distinct'` to plain
  `count` — a KPI/chart configured "distinct count of customer" on a db-tier source
  displays total row count, with no comment or warning.
- **2.12 AI chat data summaries use the wrong aggregation and ignore Top-N rank
  filters.** `generateInsight.ts:406-415` calls `aggregateByTwoFields` without the
  aggregation argument (defaults to sum; the header at `:419` hardcodes "(sum of …)")
  and `:428-436` calls `aggregateMultipleSeries` without the per-series
  `yAggregationByField` the live chart passes (`useChartWidgetData.ts:292-302,
426-435`); rank/Top-N is never applied. The pageSnapshot sent with every chat
  message can describe _sums over all categories_ for a chart showing _averages over
  the top 5_ — the model confidently reasons about numbers that don't match the
  visible chart.
- **2.13 `Math.min(...values)`/`Math.max(...values)` spread crash on large filtered
  datasets.** `generateInsight.ts:183-184` (`numericStats`) receives **all** filtered
  rows (`:687, :313, :473`); spreading >~65k–125k elements throws `RangeError`. This
  runs synchronously inside `sendMessage`'s pageSnapshot build
  (`studioBackendAdapter.ts:209-224`), so on a 100k+-row source every chat send fails.
  `richContext.ts` caps at 2,000 sampled rows; `generateInsight` has no cap — and the
  in-repo aggregators deliberately avoid this exact pattern (`aggregateNumbers` uses
  `reduce` for this reason).
- **2.14 Duplicate widgetIds in one batch → wrong rows cached under the new cacheKey
  for 30s.** `createBatchingAdapter.ts:236-237, 300-307`: batch entries are keyed by
  `widgetId` and routed with `results.find(r => r.id === d.widgetId)`; two getRows
  calls for the same widget with different descriptors inside the 50ms window (e.g. a
  page filter changed twice, both cache misses) both receive the first result, and
  `StudioRequestCache.addInflight` caches the stale rows under the **new**
  descriptor's cacheKey with a fresh 30s TTL (`StudioRequestCache.ts:159-165`).
- **2.15 Switching chat threads mid-stream silently truncates the streaming
  response.** `useChatThreads.ts` StreamThreadPin pins writes made _before_ the
  switch, but on switch the controlled `messages` prop resyncs ChatBox's store to the
  new thread and the in-flight stream's `updateMessage(id, …)` no-ops (assistant
  message id no longer exists); the fetch isn't aborted either, so remaining tokens
  are dropped. The pin machinery protects less than its comments suggest.
- **2.16 `privateMode` does not gate `pageSnapshot`/`dashboardState` client-side.**
  `studioBackendAdapter.ts:207-224, 276-286` sends real sampled row values and the
  full dashboard state unconditionally; only `richContext` is gated (`:229-231`).
  Enforcement rests entirely on the middleware honoring the flag, while the config doc
  (`:60-68`) promises the data is not sent — a defense-in-depth gap (and wasted
  bandwidth) even though the server is the host's own.

### KPI / grid / map

- **2.17 KPI filter-based trend leaks other pages' filters and disabled date
  filters.** `StudioKpiWidget.tsx:267-279` partitions the raw `selectFilters` array
  with no `pageId` or `disabled` checks — unlike `internals/filterScoping.ts:42-47`
  (`selectFiltersForWidget`), the scoping authority used for the headline rows. On a
  multi-page dashboard the previous-period value is computed with another page's
  filters applied while the current headline is not; `findDateFilter`
  (`kpiUtils.ts:141-161`) can also pick a disabled date filter or one whose `sourceId`
  doesn't match the widget's source as the trend's "current range".
- **2.18 KPI "previous calendar period" overlaps the current period for 15–90-day
  ranges.** `kpiUtils.ts:184-215` reuses `autoGranularity` (built for sparkline
  bucketing). **Verified:** current range Mar 1–31 2026 (30 days → `week`) → previous
  period Feb 22 → Mar 24 2026, overlapping the current window by 24 days; the delta
  degenerates toward self-comparison.
- **2.19 Grid CSV export diverges from the displayed grid.**
  `widgetExport.ts:45-57` + `widgetUtils.tsx:499-541` never run
  `enrichWithCrossSourceFields` (which `useWidgetRows.ts:423-494` applies for
  display), so a cross-source column renders on screen but exports as an empty column.
  Also, in `cross-highlight` mode the display shows all baseline rows
  (dimmed/highlighted, `StudioGridWidget.tsx:244-247`) while the export hard-filters to
  the highlighted subset (`StudioPipeline.ts:151-162`) — possibly intended, but
  undocumented and inconsistent with the display rationale.
- **2.20 Map geography loader race and no error recovery.**
  `StudioMapWidget.tsx:385-398`: `loader().then(setGeography)` has no staleness guard
  (fast world → usa → world toggling can land the USA topology under a world
  projection), and a rejected loader leaves the widget permanently blank with
  `loadedGeoRef` already marked loaded — no retry, no error state.
- **2.21 Map alias merging vs cross-filter emission mismatch.**
  `StudioMapWidget.tsx:209-216` merges mixed encodings (`'US'`, `'USA'`,
  `'United States'`) into one region for display, but clicking emits
  `equals <first raw variant>` (`:402-427`) — downstream widgets filter to a subset of
  what the clicked region visibly aggregates. An `in` filter over all raw variants
  would match the display.
- **2.22 `countryUtils` cannot resolve countries its own Europe map renders.**
  **Verified:** `MLT`, `MDA`, `MCO`, `LIE`, `SMR` → `null` (alpha-3 gaps in
  `countryUtils.ts:12-196`); `'Malta'`, `'Andorra'`, `'Kosovo'` → `null` (name gaps in
  `:199-394`) — despite `EUROPEAN_ALPHA2_CODES` (`:826-874`) including `MT, LI, MC,
SM, VA, XK`. `:195` also contains a dead 4-char key `MDV_` (unreachable through the
  `^[A-Z]{3}$` gate; `MDV` exists at `:114`) — a typo standing where a missing code
  should be.

### Charts (secondary)

- **2.23 `allSeriesNames` aggregates with 'sum' while the rendered series honour the
  configured aggregation.** `useChartWidgetData.ts:333-345` omits the 9th
  (aggregation) argument that `:290-304` and `:516-530` pass — with a rank filter and
  avg/min/max/count, the color-stability baseline can rank a different top-N set than
  the rendered data, defeating the mechanism it exists for.
- **2.24 bar-100 ghost tooltips mix raw and percent-normalized values.**
  `StudioBarChart.tsx:306-321`, `:449-466`: series data is percent-normalized but the
  cross-filter formatter receives raw filtered aggregates formatted with
  `formatPercentValue` — "30.0% / 75.0%" where 30 is a raw value.
- **2.25 Grouped-ring pie ignores `yAggregation` and `xGroupBy`.**
  `StudioPieChart.tsx:149,161`: `aggregateByField(catRows, sliceField, ringYField)`
  omits the aggregation argument → always sum; ring categories use raw x values,
  never period-grouped.
- **2.26 Gauge/chart `count` push-down double-aggregates on adapter sources.**
  `chartTypeRegistry.ts:379-396` routes gauge through `xyDescriptor` (emits a `count`
  agg spec); the server returns one pre-aggregated row and `renderGauge`
  (`chartTypeDefs.tsx:640-645`) re-runs `computeAggregate(rows, …, 'count')` → **1**.
  This is the exact hazard the KPI descriptor was special-cased for
  (`chartTypeRegistry.ts:256-268`).
- **2.27 Non-ISO date ingestion has local-timezone day drift.**
  `temporalUtils.ts:149-158`: `'1/15/2024'` or a host-injected local-midnight `Date`
  parses in local time, then `toISOString().slice(0,10)` yields `'2024-01-14'` for
  UTC+ viewers. Canonical ISO inputs are unaffected.
- **2.28 Forecast label extension doesn't understand week/quarter period keys.**
  `forecastUtils.ts:100`: with `xGroupBy: 'week'`/`'quarter'`, labels
  `'2024-W03'`/`'2024-Q1'` fail both extension patterns → forecast labels become
  `'+1','+2'`, degrading the axis to a point scale with garbage tail labels. Related:
  forecasting over desc/value-sorted labels regresses over scrambled order (same root
  as 1.7), and a 2-point forecast with confidence bands produces `NaN`
  (`forecastUtils.ts:60`, `0/0`).
- **2.29 Single-series line/area ghost baseline misaligned to the filtered axis.**
  `StudioLineAreaChart.tsx:427-429, 441-487`: the axis is built from filtered labels
  but the ghost series is all-labels-ordered with no alignment — when a cross-filter
  removes an entire x bucket, ghost values plot at wrong positions and the tooltip's
  "filtered / total" pairs are wrong. The bar path (`StudioBarChart.tsx:645-670`) and
  the split-by/multi-Y line paths align painstakingly (`alignFilteredToAllLabels`);
  only this path forgot.

---

## Tier 3 — Minor / cosmetic

### Controller / state

- `carryTransientDocState` zero-pages sentinel mismatch — `StudioController.ts:262-264`
  falls back to `Object.keys(pages)[0]` (`undefined` for a pageless doc) while the
  reducer's `removePage` uses `''` (`applyMutation.ts:908-911`); two different
  "no page" sentinels feed `dashboard.activePageId: string`.
- `updateState` (`StudioController.ts:494-505`) has no no-op guard: naming the `doc`
  partition always commits a fresh doc reference (undoable) even when values are
  identical — unlike `commitDocPatch`. Public API, currently only exercised by tests.
- `mutationLog` is not rewound on undo (`StudioController.ts:1708-1729`) — the AI
  "recent changes" log reports mutations whose effects were undone. Arguably correct
  ("recent activity"); worth a comment either way.
- `saveFilterPreset` saves an empty preset when the active page has no page filters
  (`docTransforms.ts:197-209`).

### Panels / drawer / canvas

- Millisecond-resolution ids in `InlineFormulaBar.tsx:132`
  (`expr_formula_${Date.now()}`) and `StudioExpressionFieldDialog.tsx:96`
  (`expr-${Date.now()}`, regenerated on every render of the open dialog) — the
  controller was explicitly migrated off `Date.now()` ids elsewhere; on collision
  `addExpressionField` silently no-ops while `onSaved(fieldId)` selects the other
  field.
- KPI source switch leaves stale config behind — `KpiSetupPanel.tsx:260-263` resets
  only `kpiValueField`/`kpiAggregation`; the widget-scoped date-range filter (old
  source's field/`filterSourceId`) and `kpiSparklineField`/`kpiSparklineSourceId`
  survive.
- Grid aggregation maps keyed by bare `fieldId` (`GridSetupPanel.tsx:426, 546-583`)
  — a related-source column sharing a field id with a primary column clobbers its
  aggregation entry.
- Row-capacity unenforced on drop/keyboard paths — `duplicateWidget` respects
  `maxPerRow = GRID_COLS / MIN_SPAN`, but `handleDrop` and `moveWidgetInLayout` can
  produce 5+ widgets per row (each below `MIN_SPAN`).
- `datediff` builder default (`ExpressionNodeEditor.tsx:501-507`) back-fills the unit
  operand with literal `0` → `"0"` is not a valid dayjs unit (silently diffs in ms).
- Operator display fallback without write-back (`PageFilterRow.tsx`/
  `WidgetFilterRow.tsx` show `operators[0]` for an invalid stored operator while the
  pipeline applies the stored one) — display/doc desync; opposite decision from the
  KPI panel's repair (2.4); the two should agree.
- `FormatPanel.tsx:259` — subtitle field displays `effectiveAutoSubtitle` while clean
  but the edit buffer starts from `widget.subtitle`, so the first keystroke visually
  replaces the whole auto subtitle with one character.
- Filters drawer field catalog dedupes by bare id (`StudioFiltersDrawer.tsx:105-119`)
  — first source wins for colliding field ids; a filter on source B's `status` shows
  source A's label/type.
- `evaluateExpression` field lookup hits inherited properties
  (`expressionEvaluator.ts:133`: `context.row['constructor']` returns a function, not
  null). Not a pollution vector (enrichment writes computed own-keys); wrong-value
  edge only.

### Widgets

- Pivot `count` vs KPI `count` divergence — with a `valueField`, pivot skips null
  measures (`COUNT(col)`, `pivotUtils.ts:64-92`) while KPI counts all rows
  (`COUNT(*)`, `kpiUtils.ts:232-234`); the comment at `pivotUtils.ts:70-72` is false
  when `valueField` is set. Same "Count" label, two meanings.
- `computeFixedPeriodRange` off-by-one (`kpiUtils.ts:45-57`): "last 30 days" spans 31
  inclusive days (self-consistent between windows; label-only).
- KPI prev-period boundary uses UTC date strings (`StudioKpiWidget.tsx:283-288`) —
  ±1 day skew at window edges for non-UTC users.
- `useTextWidgetAI` auto-approves every tool-approval request
  (`useTextWidgetAI.ts:212-218`) — mitigated by
  `allowedTools: ['query_data_source', 'summarise_page']`, but blind
  `approved: true` is a defense-in-depth gap; its `refreshSeq` also bypasses the cache
  for all later cache-key changes after one manual refresh.
- `normalizeToAlpha2` accepts any two letters as alpha-2 (`countryUtils.ts:428-430`,
  verified `'ZZ' → 'ZZ'`) — junk codes become invisible phantom regions that still
  suppress the no-data overlay (`StudioMapWidget.tsx:467`).
- `evalConditionalFormat` loose `==` (`StudioGridWidget.tsx:90-95`) — rule value `''`
  matches `0`-valued cells.
- Map `legendZeroMin` with negative data (`StudioMapWidget.tsx:245`) — forcing
  `min = 0` puts negative values below the color-scale domain.
- Filter widget custom `slots.toggleControl` calling `onApply([])` leaves a no-op
  selection filter that still flips ghost/`kpiGrandTotal` indicators
  (`StudioFilterWidget.tsx:287-292`, `useWidgetRows.ts:244-250`).

### Charts

- Bar chart "Other" bucket is hardcoded English (`StudioBarChart.tsx:619, 628,
798-801`) while the pie uses `localeText.chartOtherBucketLabel`; the bar's
  click-block predicate keys on the literal `'Other'`.
- Bar top-N fold silently re-orders the axis value-desc (`StudioBarChart.tsx:616-629`),
  discarding the configured sort when grouping triggers.
- `orderLabels` categoryOrder branch sorts absent labels lexicographically
  (`aggregators.ts:192-206`) — numeric labels degrade (`'10' < '2'`).
- `coerceAggregateValue` passes ±Infinity through (`aggregate.ts:43-45`) — one
  `Infinity` cell poisons its bucket's sum/avg/min/max.
- `fillTemporalLabelGaps` returns ascending labels only when gaps exist
  (`temporalUtils.ts:376-405`) — a desc-sorted bar chart's axis order flips
  data-dependently.
- `isEmptyXValue` drops rows whose x value legitimately equals the "(empty)" label
  string (`chartValues.ts:51-53`).
- Mixed-chart x-annotations: `useTemporalX` excludes only bar types
  (`StudioChartWidget.tsx:513-515`), so temporal labels on a mixed chart convert the
  annotation x to a `Date` that can't resolve on its band x-axis.
- `formatPercentValue` renders `null` (a gap) as `'0%'` (`chartWidgetHelpers.ts:64-66`).
- `useWidgetRows` interactive-filter indicator predicates skip `disabled`
  (`useWidgetRows.ts:244-250`) — harmless today, noted for symmetry with the
  cross-filter predicates.

### Chat / adapter plumbing

- SSE residual-buffer drop and reader hygiene (`sseUtils.ts:66-68, 88-90`): a final
  event without a trailing newline is discarded, `TextDecoder` never gets a final
  flush, and early exit neither cancels nor releases the reader. Low impact (server
  closes after `finish`).
- Mid-stream abort emits no `abort` chunk (`studioBackendAdapter.ts:460-478`) while
  the fetch-phase abort path enqueues one (`:294`) — inconsistent message marking.
- `addToolApprovalResponse` has no error handling (`studioBackendAdapter.ts:495-509`)
  — a failed approval POST is lost with no retry or user feedback.
- Adapter identity churn: `StudioChatPanel.tsx:173-178` memoizes on `aiConfig` object
  identity; an inline prop recreates the adapter every render, and a mid-stream
  recreation orphans the old adapter's `activeReaders`.
- StreamThreadPin pins via a passive effect (`useChatThreads.ts:217-223`) — chunks
  arriving before the effect commits fall back to the live active-thread ref; very
  narrow misroute window.
- Shared loader registry ignores per-adapter options
  (`createBatchingAdapter.ts:353-359`): the first adapter's `fetchFn`/`batchDelayMs`
  win for every later adapter on the same endpoint (custom auth fetch silently
  ignored).
- `pageId: descriptors[0]?.sourceId ?? 'unknown'` (`createBatchingAdapter.ts:236`) —
  a sourceId sent under a `pageId` field; mislabeled server-side telemetry.
- Cross-endpoint enrichment fetches the entire join source unfiltered per batch
  (`createBatchingAdapter.ts:270-296`); also the FK-column push (`:847-851`) runs
  before groupBy/filter enrichments register (`:854, :886`), so a cross-endpoint field
  used _only_ as groupBy/filter misses its FK column (masked because groupBy is
  normally in `select`).
- Open-ended `between` serializes `{from}` as `[from, null]`
  (`createBatchingAdapter.ts:956-964`) — server-side `between from..null` likely
  excludes everything (low exposure; open-ended ranges usually use gte/lte).
- `createWidgetFromDescription.ts:148` accepts an unknown `data.kind` with an
  unrestricted config (`validateConfigKeysForKind` returns `[]` for unknown kinds).
- `pendingMessage.id = Date.now()` (`StudioContent.tsx:141`) — two insight clicks in
  the same millisecond dedupe and the second is dropped.
- Doc drift: `generateInsight.ts:568-571` claims a "forecast → tail slice" sampling
  strategy that doesn't exist; anomaly sampling (`:88-90`) can cut tail anomaly
  indices after promising they're "always present".
- Prompt-injection surface (inherent): widget titles
  (`studioBackendAdapter.ts:221`) and raw row values flow into the model prompt
  unescaped; mitigations are the mutation validation layer and server-side tool
  approval, not client-side neutralization. Worth documenting as a threat-model note.

---

## Notes on documented tradeoffs (checked, found deliberate/correct)

Things this review explicitly attacked and found sound — listed so the next iteration
doesn't re-litigate them.

**Controller / undo-redo core.** Doc-only undo snapshots; `commitState`'s
doc-reference-gated undo push and redo clear; `commitDocPatch`/`mapPreservingIdentity`
no-op guards (verified against each doc writer); `carryTransientDocState` correctly
carries interactive filters (pruned to surviving widgets, replace-not-merge semantics
that dedupe on redo), the cross-filter toggles, and `activePageId` (with an existence
fallback) — the gap is only the missing `ai` carry (1.2);
`normalizeSessionAfterDocSwap` nulls exactly the dangling selection. The
"navigation is non-undoable" policy (undo/redo does not jump pages; redo of `addPage`
keeps the user on their current page) is deliberate and consistent.
`StudioDateRangeBar`'s coverage-expansion effect terminates (fires only while a source
is uncovered) and correctly commits `{ undoable: false }`, self-healing after undo.
`upsertDataSource`/`setDataSourceRows`/`setDataSourceAdapter` correctly never touch the
undo timeline. `duplicateWidget`'s composed `addWidget + setWidgetLayout + addFilter*`
fold is one undo step with collision-safe ids, preserving the managed
`widget-date-range-${id}` convention. `restoreSession` fails closed on malformed
payloads and drops unmigratable history entries instead of aborting the restore.

**Shared reducer (`applyMutation.ts`).** Every id-keyed handler uses `Object.hasOwn`
so untrusted ids (`constructor`, `__proto__`) are clean no-ops; `addWidget` is
idempotent on re-delivery keyed off the flat widget record (deliberate, documented);
`removeWidget`'s row-edit + `removeWidgetIds` cleanup is the single implementation
shared by AI and user paths; reference-equality no-op contracts hold throughout;
`applyMutation` wraps doc mutations into state immutably.

**Persistence boundary.** `serializeDoc` spreads the doc (new fields carried
automatically), strips cross-filter and interactive entries with a documented rationale
for their differing undo semantics; `schemaVersion` round-trips
(default state → serialize → migrate verified); session/runtime never serialized;
`serializeSession` stamps mode once (documented back-compat).

**AI-mutation wire validation.** `applyStateMutation` routes every SSE
`state-mutation` through `parseStateMutation` and drops (never throws) on failure; the
validator table is exhaustive and compile-time-pinned; `__proto__`/`constructor`/
`prototype` are rejected at every key position; the `pageId`-only-`isOptionalString`
apparent gap is closed by the reducer's `Object.hasOwn(state.pages, pageId)` guards.

**CSV injection.** `internals/csvUtils.ts` neutralizes `= + - @ \t \r` with a leading
`'` plus quote-doubling (verified by execution); `buildCsvContent` escapes all text
cells while exempting genuine runtime numbers; pivot CSV escapes headers/labels;
shared `downloadCsv` sanitizes filenames.

**Markdown/XSS.** `renderMarkdown.tsx` sets `disableParsingRawHTML: true` and a
sanitizer allowing only `http/https/mailto`, blocking protocol-relative and
`javascript:` obfuscations (traced through `new URL` normalization); non-AI text
renders as plain `Typography` children; no `dangerouslySetInnerHTML` anywhere in
`src/` (swept).

**Locales.** All four bundles (fr/de/es/ptBR) define all 878 keys of
`DEFAULT_STUDIO_LOCALE_TEXT` with **no extra/stale keys, no type or arity mismatches on
the 63 function-valued entries, and no placeholder-token mismatches** (scripted audit,
executed). Values identical to English (13–33 per bundle) are legitimate cognates
("Filter", "Sankey", month-window labels). Every key is referenced — apparent orphans
(`chatToolLabel*`, `widgetAggPrefix*`) are reached via explicit lookup maps
(`chatToolRenderers.tsx:62-86`, `widgetUtils.tsx:172-177`). The completeness test now
compares against the default text (the correct reference), closing the historical
all-bundles-missing-the-same-key blind spot.

**Aggregation core.** `aggregateNumbers` min/max via `reduce` (no spread overflow);
empty-set sum/avg → 0 documented; `count` vs `count_distinct` semantics; null-skip +
boolean→0/1 coercion genuinely unified across KPI/pivot/map/chart accumulators;
`finalizeAccumulator` null-for-empty-cell (line-chart gaps) vs `aggregateByField`
0-for-all-null-bucket both documented and consistent.

**Temporal core.** `truncateToPeriod`/ISO-week Thursday rule correct;
`periodKeyToDateRange` month/quarter/week boundary math correct; offset-carrying
datetimes fall through to `Date` conversion correctly; `fillTemporalLabelGaps`'s
first+last kind check is a documented perf tradeoff.

**Chart registry.** `CHART_TYPE_DEFS` guard flags exactly reproduce the pre-registry
if-chain (verified against git history), including gauge skipping all guards; the
multi-Y hole in `renderLineArea` (1.8) is a faithful preservation of a pre-existing
bug, not a registry regression. `buildXYAggSpecs` alias de-dup (per-series fn wins) is
deliberate and documented; sankey deliberately never reads `yAggregation`;
`analyzeChartSupport` anchoring and the two-level `rcfaCache` are sound.

**Pipeline scoping.** `selectFiltersForWidget` is the single scoping authority for
sync, adapter, and non-React paths; cross-filters exclude their source widget; page
filters are pageId-scoped; dashboard-date-range filters are source-matched; rank
filters excluded from widget-scoped server descriptors; selection/interactive filters
enforced client-side on both paths; `resolvedRowsCache` invalidation (foreign-row
refs, junction sources, expression-field identity, behavioral filter fingerprint, LRU
cap) is thorough.

**Setup panels done right.** `GridSetupPanel.clearFieldBoundGridConfig` clears exactly
the field-bound keys; the two-layer kind/chart-type config guard in
`updateWidgetConfig` (patch-only by design — stored foreign-family keys deliberately
survive chart-type switches, documented); fieldless-count re-lock on series
remove/change; buffered commit-on-blur inputs (gauge min/max, grid height, expression
literals, annotation value, conditional-format numeric value) all correct — the
finding-2.3 stragglers are the exception, not the rule.

**React integration.** Controller created exactly once; `onStateChange` read through a
layout-effect ref; subscriptions cleaned up; imperative handle memoized;
`useStudioSelector` on `useSyncExternalStore`; no fresh-reference-per-call selectors in
the bare exports (factory selectors document per-instance `useMemo`).
`StudioRequestCache` generation tokens correctly prevent invalidated in-flight requests
from re-caching stale rows (the 2.14 duplicate-id case is a different, batching-level
hole). Batching-adapter error propagation (per-descriptor fan-out, batch rejection,
missing-id errors) is correct, as is the DataLoader length/order invariant.

**StreamThreadPin.** The write-target pin does correctly prevent _pre-switch_ stream
writes from landing in the newly selected thread, and `{ undoable: false }` per-token
write-backs correctly protect the undo history (the gaps are 1.2 — the reverse
direction — and 2.15).

---

## Verification appendix

- Baseline: `node …/typescript/bin/tsc -p tsconfig.json --noEmit` → exit 0;
  `vitest --config vitest.config.jsdom.mts --run` → 134 files / 2204 tests passed.
- Empirical repros were executed with
  `node /home/user/mui-x/node_modules/tsx/dist/cli.mjs <script>` importing the package
  sources directly; scripts live outside the repo (session scratchpad):
  `repro-updatewidget.ts`, `repro-ai-undo.ts`, `repro-daterange.ts`,
  `repro-dangling-selection.ts`, `repro-removepage-selection.ts`, `verify-exclude.ts`,
  `verify-charts.ts`, `locale-audit.ts`, plus subagent scripts
  (`repro-exclude.ts`, `verify-kpi.ts`, `verify-misc.ts`, chart/forecast traces).
