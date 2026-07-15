# @mui/x-studio — Clean-slate architecture & correctness review

**Tier1: 0 / Tier2: 2 / Tier3: 3**

Scope: data pipeline (`StudioPipeline`, `useWidgetRows`, `chartSupport`/`grainResolution`,
`aggregators`), server query adapters (`createBatchingAdapter`, `createSimpleAdapter`,
`queryDescriptor`, `filterUtils` partition/pushdown), filter scoping (`filterScoping`), KPI/date
math (`StudioKpiWidget`, `kpiUtils`, `filterUtils` presets), and `StudioController` mutation/undo
guards. Read from current source; not from prior-iteration notes.

Headline: this package has been through 12 prior fix passes and it shows. The wire-path partition
(`partitionFilterNode`/`isLeafServerTranslatable`/`toPredicatesFor`), the cross-filter/rank
aggregation-stripping, the L4 grain-anchor filter re-application, the undo/redo transient-carry
machinery, and the controller no-op guards are all internally consistent and defensively tested.
The remaining findings are two **narrow timezone correctness bugs in KPI trend date math** — the
one date-space convention the package has NOT fully unified: bare `date` values are handled in
LOCAL calendar space everywhere, but `datetime` values are pinned to UTC in two spots that then
feed local-space math.

---

## Tier 1 — security / data-loss / correctness reachable via public API

None found. The areas most likely to harbor them were checked and are sound (see "Verified sound").

---

## Tier 2 — robustness / correctness (narrow)

### T2-1 — KPI fixed-period trend over a `datetime` field misclassifies boundary rows for non-UTC viewers

**Files:** `packages/x-studio/src/components/widgets/StudioKpiWidget/kpiUtils.ts:78-87` (`toDayKey`)
vs `:98-117` (`filterRowsByDateRange`); reached from `StudioKpiWidget.tsx:940-955`
(`computeFixedPeriodTrend`).

`filterRowsByDateRange` reduces the **window bounds** to a calendar day with `toLocalYmd(start)` /
`toLocalYmd(end)` (LOCAL Y/M/D — lines 104-105), but reduces each **row value** with `toDayKey`,
whose string branch (`:79-84`) returns the leading 10 chars of the value. For a normalized
`datetime` cell (`'YYYY-MM-DDTHH:MM:SSZ'`, canonicalized to UTC on ingestion) those 10 chars are the
**UTC** calendar day, not the local one. So the two sides of the `key >= startKey && key <= endKey`
comparison are in different calendar spaces.

Failure scenario: a KPI with a `datetime` date field, `kpiTrend` + `kpiTrendFixedPeriod` set, viewer
at e.g. UTC+3. A row stamped `2026-07-15T22:30:00Z` is locally Jul 16, but `toDayKey` returns
`2026-07-15`; if the fixed-period window starts Jul 16 (local) the row is wrongly excluded from the
current period (and symmetrically a `…T01:00Z` row for a UTC-5 viewer is wrongly included). Only
rows within a few hours of UTC midnight are affected, so the headline (all-time, unwindowed) is fine
but the **trend delta** comes out slightly wrong for essentially every non-UTC viewer with a
datetime KPI trend. Note the sibling sparkline path (`getBucketKey`, `kpiUtils.ts:387-414`) buckets
in LOCAL space (`date.getFullYear()`/`getMonth()`/`getDate()`), so the sparkline and the trend even
disagree with each other on which day a near-midnight datetime row belongs to.

The doc comment on `filterRowsByDateRange` ("both the row value and the window bounds are reduced …
exactly as L3 does") is also inaccurate for `datetime`: L3's `toDayComparable` (`filterUtils.ts:117`)
puts BOTH sides through the same UTC `toISOString().slice(0,10)`, so L3 is internally consistent;
this function is not.

**Fix direction:** make both sides use one space. Simplest: derive the bound keys the same way rows
are keyed — for a datetime field reduce `start`/`end` to their UTC day (`toISOString().slice(0,10)`)
rather than `toLocalYmd`; or, conversely, reduce datetime row values to their LOCAL day via
`toLocalYmd(normalizeToDate(raw))` instead of the leading-chars fast path. Pick whichever matches the
convention the fixed-period window itself is built in (`computeFixedPeriodRange` builds LOCAL-anchored
Dates via `setHours`, so the LOCAL choice keeps the window and the rows in one space).

### T2-2 — KPI filter-based previous-period window is day-shifted for `datetime` preset ranges off UTC

**Files:** `packages/x-studio/src/internals/filterUtils.ts:37` (`resolveDateRangePreset`) →
`kpiUtils.ts:153-168` (`extractDateRange`, `between` branch) → `kpiUtils.ts:290-354`
(`computePreviousPeriodRange`, `previous-period` branch).

`resolveDateRangePreset` anchors a `datetime` preset's end bound to **UTC** end-of-day:
`resolvedTo = filter.fieldType === 'datetime' ? \`${to}T23:59:59.999Z\` : to` (`:37`). `extractDateRange`then parses that with`new Date(str)` (`:144`), producing a Date whose **local** calendar day
(`getFullYear()/getMonth()/getDate()`) is the NEXT day for viewers east of UTC. That Date is passed as
`end`into`computePreviousPeriodRange`, whose `previous-period`branch is explicitly documented and
implemented in whole-**local**-day space:`endDay = new Date(end.getFullYear(), end.getMonth(),
end.getDate())`and`inclusiveDayCount = round((endDay - startDay)/MS_PER_DAY) + 1` (`:346-348`).

Failure scenario: KPI with a `datetime` date field and a non-custom date-range preset
(e.g. "last 30 days"), filter-based trend, viewer at UTC+2. The current window's `end` local day is
computed one day late, so `inclusiveDayCount` is one too large and `prevStart`/`prevEnd` shift by a
day — `previousValue` is computed over a wrong (longer, shifted) window and the trend delta is off.
`date` (non-datetime) fields are unaffected because `resolvedTo` stays a bare local-parsed date.

**Fix direction:** the two conventions (UTC-anchored datetime end bound vs. local-space previous-period
math) must agree. Either compute the previous-period day count from the bare `to` date before the
UTC end-of-day suffix is applied, or have `extractDateRange` collapse a datetime `end` to its intended
calendar day in the same space `computePreviousPeriodRange` uses before handing it over.

---

## Tier 3 — minor / doc-drift / cosmetic

### T3-1 — `computeFixedPeriodRange` produces an inclusive **31**-day (not 30) "month" window

**File:** `packages/x-studio/src/components/widgets/StudioKpiWidget/kpiUtils.ts:55-67`.
`start.setDate(start.getDate() - days)` with `days=30`, `start` at 00:00 and `end` at 23:59:59.999,
yields `[today-30 … today]` = 31 calendar days, though the doc comment says "last 30 days" (likewise
91/365 → 91/366-day windows). Harmless for the delta (current and previous windows are both built the
same way and stay equal-length and adjacent), but the window is one day wider than documented.
**Fix:** subtract `days - 1`, or amend the comment.

### T3-2 — `filterRowsByDateRange` doc comment claims parity with L3 that does not hold for `datetime`

**File:** `kpiUtils.ts:89-97`. The "exactly as L3 does" claim is only true for `date` fields; for
`datetime` the row side (UTC) and bound side (local) diverge (see T2-1). Correct the comment when
T2-1 is fixed so the invariant it states is actually the one the code enforces.

### T3-3 — `findDateFilter` relies entirely on upstream scoping for the dashboard-date-range source match

**File:** `kpiUtils.ts:210-230`. `findDateFilter` accepts any `scope.kind === 'dashboard-date-range'`
filter without checking its `sourceId` matches the widget's source. This is currently safe because
every caller passes rows already run through `selectFiltersForWidget` (`filterScoping.ts:88-95`),
whose `dashboard-date-range` case enforces `sv2.sourceId === widgetSourceId`. Not a bug today, but the
function is exported and its contract silently depends on that pre-filtering; a future direct caller
passing a raw `filters` array would latch onto another source's date field. Consider an internal
source guard, or a doc note that the input must be pre-scoped.

---

## Verified sound (checked, not a finding)

- **Wire-path filter partition** (`filterUtils.ts:1252-1567`, `createBatchingAdapter.ts` simple &
  relationship modes): incomplete-condition pruning (`isConditionComplete`/`isFilterComplete`),
  empty-`in` selection-vs-condition inversion (`leafToClientFilterState` preserving `filterMode`),
  OR-group / unmappable-operator / open-ended-`between` client-residual routing, `not_equals` NULL
  and `equals`-on-datetime divergence warnings, `count`/`count_distinct`/`avg`+`xGroupBy`/cross-filter/
  rank aggregation-stripping, and the day-granular date bound translation (`toPredicatesFor` /
  `nextDayIso`) are all consistent between the two adapters and with the in-memory evaluator.
- **`batchEntryId` / `findBatchResult`** — same-widget different-descriptor collision fixed; the
  bare-widgetId fallback is correctly skipped when ambiguous.
- **Filter scoping** (`filterScoping.ts`): page/widget/cross-filter/interactive/dashboard-date-range
  cases, `include` modes, `crossFilterAllPages`, `disabled`, and widget-rank exclusion are consistent
  across the sync, adapter, and non-React pipeline callers (single source of truth genuinely shared).
- **L4 grain resolution** (`grainResolution.ts`, `chartSupport.ts`): anchor- and remote-scoped filter
  re-application before the expansion join (semi-join resurrection fix), incomplete-M:N-junction
  fail-closed guards, and the two-level `rcfaCache` invalidation (relationships ref, relevant expr
  fields, read-source rows, anchor/remote filter fingerprint) are correct.
- **`StudioController`**: undo/redo snapshot `StudioDoc[]` only; `carryTransientDocState` /
  `isTransientOnlyDocDiff` correctly keep interactive filters, cross-filter toggles, `activePageId`,
  and `doc.ai` out of the time-travel timeline while keeping cross-filters undoable; the value-equality
  and identity-preserving no-op guards on every writer prevent dead redo-clearing undo entries;
  `applyExternalMutation` classifies transient-only diffs by result, not by mutation type; session
  selection is normalized after doc swaps; data-source injection/adapter/removal are non-undoable with
  correct same-reference loop guards.
- **KPI cross-source / measure paths**: `computePeriodValue` window-then-anchor ordering, the
  previous-period `widgetFilters` swap (F4), measure formula-fingerprint cache keys, boolean-avg
  percent scaling, and the adapter-source trend suppression are correct.
- **Chart aggregation** (`aggregators.ts`): null-skip coercion policy, non-numeric→count pre-detect,
  rank-by-string/number key coercion, blended-series source disambiguation, and `orderLabels`
  value/category/direction precedence are correct.
- **privateMode trust boundary**: `studioBackendAdapter.ts:237-266` gates `pageSnapshot`,
  `serializableState`, AND `richContext` (field stats) behind `!privateMode` client-side; the text
  widget path mirrors it. No aggregate/field-name/layout leak in private mode.
