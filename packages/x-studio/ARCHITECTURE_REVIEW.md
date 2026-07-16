# x-studio architecture & correctness review

Tiers: 0/1/1

Fresh clean-slate review of `packages/x-studio/src/**`, concentrating on the data
pipeline (L2/L3/L4), filter scoping, KPI/date-range logic, aggregation, and undo/redo
state-carry. The package has had 13 rounds of hardening and it shows: the store,
`resolvedRowsCache`/`rcfaCache` invalidation, `grainResolution` fan-out joins,
`filterScoping`, and the KPI local-calendar-day unification are all correct and
internally consistent. Files read in full include `StudioController.ts` (undo/redo,
`carryTransientDocState`, `isTransientOnlyDocDiff`), `StudioPipeline.ts`,
`filterUtils.ts`, `filterScoping.ts`, `useWidgetRows.ts`, `chartSupport.ts`,
`grainResolution.ts`, `resolvedRowsCache.ts`, `aggregators.ts`, `useChartWidgetData.ts`,
`useBlendedSeriesRows.ts`, `useChartRows.ts`, `kpiUtils.ts`, `StudioKpiWidget.tsx`,
`StudioMapWidget.tsx`, `pivotUtils.ts`/`StudioPivotWidget.tsx`, `gridGrouping.ts`,
`selectors.ts`, and `docTransforms.ts`.

No Tier‑1 (data‑loss / security / row‑dropping / scope‑leak / dangling‑undo) defects
were found. The two findings below are a genuine but narrow calendar‑arithmetic
inconsistency (Tier 2) and a low‑confidence heuristic note (Tier 3).

---

## Tier 2 — robustness / consistency

### 2.1 `computePreviousPeriodRange` week branch uses instant subtraction, day‑shifting the previous window across a DST boundary

`packages/x-studio/src/components/widgets/StudioKpiWidget/kpiUtils.ts:357-363`

```js
if (granularity === 'week') {
  const ms = 7 * 24 * 60 * 60 * 1000;
  return {
    start: new Date(start.getTime() - ms),
    end: new Date(end.getTime() - ms),
  };
}
```

**What's wrong.** Every other branch of this function computes the previous window with
_calendar_ arithmetic that is timezone/DST‑safe: `year-over-year` uses `setFullYear`,
the `previous-calendar-period` month/quarter/year branches use the
`new Date(year, month, day, …)` constructor, and the default `previous-period` branch
was explicitly hardened to use `setDate` plus a `Math.round((endDay - startDay)/MS_PER_DAY)`
that absorbs the ±1h DST wobble (see the long comment at `kpiUtils.ts:373-390`). The
`previous-calendar-period` **week** sub‑branch is the lone exception: it subtracts a raw
`7 * 24 * 60 * 60 * 1000` ms from `start`/`end`, which are LOCAL‑midnight `Date`s produced
by `extractDateRange` (`kpiUtils.ts:154-171`).

**Concrete failure.** For a viewer in a DST timezone, when the 7‑day span crosses a
"spring‑forward" transition the span is only 167 wall‑clock hours, so
`start.getTime() - 168h` lands at `23:00` on the _previous_ calendar day. Downstream both
the fixed‑period path (`filterRowsByDateRange` via `toLocalYmd`) and the filter‑based path
(`computeFilterBasedTrend` serializing `prevRange.start/end` via `toLocalYmd`,
`StudioKpiWidget.tsx:332-334`) reduce these instants to `YYYY-MM-DD`, so `prevStart`
serializes one day too early. The "previous week" comparison then includes/excludes a
boundary day incorrectly — exactly the class of day‑shift the rest of this file goes out
of its way to prevent. Reachable whenever `config.kpiTrendComparison === 'previous-calendar-period'`
and the current date‑filter range is ≤10 days (`comparisonGranularity` → `'week'`,
`kpiUtils.ts:309-321`). Impact is low frequency (DST transitions only) but it is a real
row‑misclassification, and the week branch has no test coverage (`kpiUtils.test.ts` covers
month/quarter/year previous‑calendar‑period but not week).

**Fix.** Use calendar arithmetic like the sibling branches:

```js
if (granularity === 'week') {
  return {
    start: new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7),
    end: new Date(end.getFullYear(), end.getMonth(), end.getDate() - 7),
  };
}
```

This shifts by 7 whole calendar days regardless of DST, matching the default
`previous-period` branch's policy. Add a week‑granularity test alongside the existing
month/quarter/year cases.

---

## Tier 3 — minor / low confidence

### 3.1 Numeric‑vs‑count pre‑detection keys off the first non‑null value only

`packages/x-studio/src/internals/aggregators.ts:269-280` (and the mirrored blocks at
`:349-360`, `:437-447`)

The `aggregateByField` / `aggregateByTwoFields` / `aggregateMultipleSeries` "is this
field numeric?" pre‑detection inspects only the **first** non‑null row value and, if it
is `NaN`, downgrades the _entire_ field to a `count` aggregation. A field whose first
non‑null cell is a non‑numeric sentinel (e.g. `"N/A"`, `"—"`) but whose remaining cells
are genuine numbers would therefore render a configured `sum`/`avg` chart as row counts.
This is a shared, long‑standing heuristic applied identically across all three aggregators
(and consistent with the per‑value `coerceAggregateValue` null‑skip policy used inside the
row loop), so it is most likely deliberate rather than a regression — flagged only as a
robustness note. If tightened, sampling a handful of values (or checking "any non‑null value
is numeric") before falling back to `count` would be more forgiving without a full scan.

---

## Areas checked and found correct (no action)

- **Undo/redo state‑carry** (`StudioController.ts:213-354`, `2313-2354`):
  `carryTransientDocState` correctly overlays interactive filters (pruned to surviving
  widgets), cross‑filter toggles, `activePageId` (with the missing‑page fallback), and
  `doc.ai`; `normalizeSessionAfterDocSwap` nulls dangling `selectedWidgetId`;
  `isTransientOnlyDocDiff` prevents dead redo‑clearing undo entries. No dangling
  references survive a swap.
- **L4 fan‑out grain resolution** (`grainResolution.ts`): the M:1 and M:N‑junction
  branches re‑apply anchor‑scoped and remote‑endpoint‑scoped filters before the expansion
  join (findings 1.4/2.3 in‑code), correctly avoiding both anchor‑row "resurrection" and
  row duplication. Effective‑source derivation handles no‑`filterSourceId` expression
  filters.
- **Cache invalidation** (`resolvedRowsCache.ts`, `chartSupport.ts` `rcfaCache`): both
  track foreign read‑source row refs, relationship ref, and relevant expression‑field
  object identity, and record source _absence_ as `null` so a late data load invalidates.
  `filterFingerprint` folds resolved relative‑date days so relative filters self‑heal at
  midnight.
- **Filter scoping** (`filterScoping.ts`) is the single authority all three data paths
  route through; `crossFilterAllPages`, `disabled`, widget‑rank inclusion, and
  cross/interactive `include` modes are handled uniformly.
- **Selectors** (`selectors.ts`) are reference‑stable: the `make…ForSource(s)` and
  partition selectors reuse the prior array/object when bucket content is unchanged, so no
  new‑reference‑every‑render infinite‑loop hazard.
- **Fan‑in dedup** is applied consistently where cross‑source many‑to‑one values fan out:
  grid (`gridGrouping.symmetricAggregate`), map (`StudioMapWidget` `seenFksByRegion`);
  pivot deliberately excludes cross‑source fields at the setup panel, so it needs none.
- **KPI local‑calendar‑day unification** (`kpiUtils.ts` `toDayKey`/`filterRowsByDateRange`/
  `toLocalYmd`) is internally consistent; the L3 UTC end‑of‑day anchoring in `filterUtils`
  is the documented, deliberate separate policy.
