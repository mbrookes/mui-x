# EBL-03 / EBL-04 — Deals by Stage funnel: implemented

> Status: **implemented.** EBL-03 → Option B (generator fix); EBL-04 → #1 (conversion bar)
> and #3 (time-in-stage heatmap). See the "Implemented" note at the bottom for details.

## 1. Current state (what's actually happening)

**Widget:** `widget-chart6-deals-by-stage` on page 6 (CRM Pipeline), config in
`examples/x-studio-shared/src/config/salesDashboard.ts`:

```ts
config: { chartType: 'funnel', xField: 'stage', yField: 'id',
          yAggregation: 'count', chartSortBy: 'category' }
```

**Data:** `examples/x-studio-shared/src/crmData/generator.ts`. Each deal is assigned **exactly one**
stage via an _independent_ weighted random pick:

```ts
const DEAL_STAGES = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
];
const DEAL_STAGE_WEIGHTS = [0.2, 0.2, 0.2, 0.15, 0.15, 0.1];
```

Deal fields available today: `id, customerId, primaryContactId, title, stage, value, probability,
openedDate, closeDate`. There is **no stage-entry timestamp, no transition/event history, and no
`owner` field.** Customer `segment` and `country` _are_ reachable via the existing cross-DB
expression fields `expr-deal-segment` / `expr-deal-country`.

**Render:** `packages/x-studio/src/components/widgets/StudioChartWidget/StudioChartWidget.tsx`
(funnel branch ~L936) aggregates a per-stage **snapshot count** (`stageMap`), orders by the field's
`orderedValues`, and hands `[{label,value}]` to `StudioFunnelChart`
(`.../StudioFunnelChart.tsx`). That component computes:

```ts
const maxValue = stages[0].value; // = Prospecting count
retentionPct = (stage.value / maxValue) * 100; // "% of total"
dropOffPct = ((prev - stage.value) / prev) * 100; // "▼ -x%" between stages
```

### Why "Qualification = 105%"

The funnel does **not** track deals that _passed through_ a stage — it shows how many deals are
_sitting in_ each stage right now. Prospecting and Qualification share the same weight (0.20), so on a
given seed Qualification can randomly sample **more** deals than Prospecting. Because
`chartSortBy:'category'` pins Prospecting first, `maxValue` = Prospecting, and a larger Qualification
bucket yields `retentionPct > 100` (and the bar overflows its track since `widthPct > 1`).

**So the bug is non-monotonic snapshot data, not a missing percentage.** Both percentage types BI
teams want — overall retention ("% of total") and step-over-step drop-off ("▼ -x%") — are _already_
displayed. A funnel is only meaningful when each stage ⊇ the next; independent buckets violate that.

---

## 2. Best-practice recap (funnel semantics)

- **Overall conversion / retention** = `stageN / topOfFunnel`. Monotonically non-increasing **by
  construction** only if `stageN` counts _deals that reached at least stage N_.
- **Step (stage) conversion** = `stageN / stage(N-1)` — the rate the chart should headline for
  diagnosing leak points; drop-off = `1 − step`.
- **Never > 100%:** guaranteed iff the series is monotonic. Achieve that by counting "reached stage X"
  (cumulative), not "currently in stage X".
- **Closed Lost is a terminal exit, not a sequential step.** The linear conversion sequence is
  `Prospecting → Qualification → Proposal → Negotiation → Closed Won`. Do **not** roll up across the
  full `orderedValues` (per BL-173 Closed Lost sorts last) — "at-or-beyond Closed Won" would wrongly
  swallow Closed Lost. Keep BL-173's order for **display only**; **exclude Closed Lost from the % math**
  and report it as a separate exit total. Without stage history you cannot attribute _where_ a lost
  deal leaked — state that as a known limitation.

---

## 3. EBL-03 — recommendation (percentage calculation & display)

Two ways to make the series monotonic:

### Option A — display-time roll-up (no generator change)

Transform the snapshot into cumulative "deals at-or-beyond stage X": count deals whose stage index ≥ X
along the _sequential_ path (Prospecting…Closed Won), excluding Closed Lost. Guarantees ≤100% with
zero data work, but it **fabricates** passed-through numbers by _assuming_ every current deal traversed
all earlier stages — which is exactly the "should we roll up the totals?" question, answered as "only
as a presentation guard, because the underlying data isn't a real funnel."

### Option B — generator fix (recommended default)

Generate a **coherent decreasing funnel** plus the journey data the visuals need. Higher leverage: the
same change makes the funnel honestly monotonic _and_ unlocks every EBL-04 option. For a demo whose job
is to look correct, this is the real fix. Concretely, give each deal a **stage-reached depth** so
counts decrease by construction, and (for EBL-04) per-stage entry/exit dates.

**Recommended default: B**, with A available as a zero-data-change safety net if we want the funnel to
_never_ exceed 100% regardless of source data.

### Display recommendation (applies to either option)

- Headline **step conversion** between adjacent stages (already rendered as "▼ -x%"); keep "% of total"
  as the secondary metric.
- Distinguish **"in stage now" vs "passed through"** explicitly: the funnel shows _passed-through_
  (cumulative) counts; keep the existing **donut** `widget-chart6-value-by-stage` / grid for the
  _current-snapshot_ breakdown. Optionally add a tooltip line "currently in stage: N".
- Render Closed Lost outside the funnel (a side stat / separate bar), not as a funnel step.

**Data we have vs need:** Option A needs nothing new. Option B needs a generated **stage-reached
depth** per deal (and, to label "in stage now", keep the current single `stage`). Time-in-stage and
where-lost (EBL-04) additionally need **per-stage entry/exit timestamps** or a transition event log.

---

## 4. EBL-04 — alternative / additional visualisations

Package note: `FunnelChart`, **`SankeyChart`**, and `Heatmap` are all exported from
`@mui/x-charts-pro` (premium merely re-exports pro's). **x-studio already depends on
`@mui/x-charts-pro`**, so none of these needs a new dependency — the constraint is _data_, not the
chart library. (x-studio's current funnel/heatmap are custom config-driven components, not the native
pro charts.)

| #   | Visualisation                                                                                   | Needs                                                                                                                                              | Renderable today?                                                                  | Effort                            | Insight                                                                |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| 1   | **Conversion-rate / drop-off bar** (one bar per stage transition = step conversion %)           | cumulative "reached stage" counts only                                                                                                             | **Yes** — plain `bar` widget once counts are monotonic                             | **Low**                           | Pinpoints the single worst leak step at a glance                       |
| 2   | **Waterfall of stage-to-stage drop-off** (running total falling by the deals lost at each step) | same cumulative counts; no native waterfall in x-charts → fake via stacked `bar` with a transparent base series                                    | Mostly — needs a small stacked-bar/offset helper                                   | **Medium**                        | Shows _magnitude_ of loss per step, not just a rate                    |
| 3   | **Time-in-stage heatmap** (stage × segment, colour = avg days in stage)                         | **new data**: per-stage durations + a category axis; `segment` exists via `expr-deal-segment`, **`owner` does NOT exist** (would need a new field) | Heatmap widget exists (`StudioHeatmapChart`), but the duration/owner data does not | **Medium-High** (mostly data-gen) | "Does one segment/owner stall in a stage?" — velocity, not just volume |
| 4   | **Sankey of stage transitions** (flows incl. where deals exit to Closed Lost)                   | **new data**: per-deal transition history (from→to events)                                                                                         | Chart available in pro; data is not                                                | **High**                          | The most complete "where do deals go / leak" picture                   |

**Recommendation: #1 (conversion-rate / drop-off bar) as the primary EBL-04 addition** — it directly
answers "where is a deal lost?", is renderable today, and rides on the _same_ monotonic counts EBL-03
Option B already produces (near-zero marginal cost). Add **#3 (time-in-stage heatmap)** as the
stretch/"creative" follow-up once stage-duration data exists, since it answers the _velocity_ question
("does one category perform better?") that volume charts can't.

> Caveat to surface: `owner` is referenced in the task as a heatmap axis but **does not exist** on
> deals today. Segment is the available, zero-new-field category axis; owner needs a generated field.

---

## 5. What I'd implement if approved

### EBL-03 (recommend Option B)

- **Generator** (`crmData/generator.ts`): when creating a deal, instead of one independent weighted
  `stage`, draw a **furthest-reached depth** `d` along `Prospecting…Closed Won` from a decreasing
  distribution, set `stage` = that depth's label, and (for the win/lost split) let some deals exit to
  Closed Lost from an intermediate depth. Optionally add `stageReached` (numeric depth) so the
  funnel/aggregation can count "deals with depth ≥ X" → monotonic by construction.
- **Funnel aggregation** (`StudioChartWidget.tsx` funnel branch / a small helper): support a
  cumulative "reached stage" mode and **exclude Closed Lost** from the linear sequence; pass current
  snapshot count through for the tooltip.
- **`StudioFunnelChart.tsx`**: clamp `widthPct ≤ 1`; headline step-conversion; render Closed Lost as a
  separate exit stat. (Clamping alone also neutralises the overflow if Option A is chosen instead.)
- _Zero-data alternative (Option A):_ implement only the cumulative aggregation + clamp; no generator
  change.

### EBL-04 (recommend #1 now, #3 later)

- **#1 bar:** add a `widget-chart6-stage-conversion` bar widget driven by the cumulative counts (step
  conversion % per transition). No new fields beyond EBL-03 Option B.
- **#3 heatmap (later):** generate per-stage `daysInStage` (and a real `owner` field if owner is the
  desired axis); add a heatmap widget `xField: stage`, `heatYField: expr-deal-segment` (or owner),
  `yField: daysInStage`, `yAggregation: 'avg'`.

**Single biggest data gap:** the deals source has **no stage history and no per-stage timestamps** (and
no `owner`). That one gap is why the funnel is non-monotonic _and_ why time-in-stage / where-lost /
Sankey can't be built today. Closing it (Option B generator work) unblocks EBL-03 and every EBL-04
option at once.

---

## 6. Implemented

**EBL-03 → Option B (generator fix). EBL-04 → #1 (conversion bar) + #3 (time-in-stage heatmap).**

### Data model (`examples/x-studio-shared/src/crmData/generator.ts`)

- Replaced the independent weighted `stage` pick with a **furthest-reached depth** model.
  Each deal draws a depth `d` along `Prospecting → Qualification → Proposal → Negotiation →
Closed Won` from a **decreasing** distribution (`REACH_DEPTH_WEIGHTS`), so counts of
  "reached ≥ k" fall off monotonically **by construction** (the funnel can never exceed 100%).
- New deal fields: **`stageReached`** (numeric depth 0–4, hidden), **`owner`** (fixed roster
  of 6 reps — the heatmap row axis), **`daysInStage`** (days in the current/snapshot stage),
  and a **`stageTimeline`** array (per-stage entry/exit dates + durations). `closeDate` is
  derived from the sum of stage durations so it stays coherent with `openedDate`.
- Win/lost split: depth-4 deals are `Closed Won`; deals that stall earlier either exit to
  `Closed Lost` (terminal, keeps `stageReached`) or stay open in their reached stage. `stage`
  (single field) is kept for "currently in stage" semantics and existing widgets.
- `Closed Lost` is excluded from the sequential sequence but kept last in display
  `orderedValues` (BL-173).

### Funnel aggregation + rendering

- `aggregateFunnelReached()` and `clampWidthPct()` added to
  `packages/x-studio/src/internals/chartAggregation.ts`. The aggregation returns cumulative
  reached counts, snapshot counts, step-conversion fractions, and a separate `Closed Lost`
  exit total.
- New config flags (`packages/x-studio/src/models/widgetTypes.ts`): `funnelReachedField`,
  `funnelStageSequence`, `funnelExitStage`, `funnelConversionBar`. Cumulative mode is opt-in
  (presence of `funnelReachedField`), matching the existing `heatYField`/`sankeyTargetField`
  style, so other funnels are untouched.
- `StudioFunnelChart.tsx`: clamps `widthPct ≤ 1`; headlines step-conversion ("▼ -x%"); keeps
  "% of total" secondary; shows a "currently in stage: N" tooltip; renders `Closed Lost` as a
  separate exit stat (not a funnel step).

### Widgets (`examples/x-studio-shared/src/config/salesDashboard.ts`, page 6)

- `widget-chart6-deals-by-stage` → cumulative reached mode.
- `widget-chart6-stage-conversion` (EBL-04 #1) → step-conversion bar driven by the same counts.
- `widget-chart6-time-in-stage` (EBL-04 #3) → heatmap `stage × owner`, value = avg
  `daysInStage`. **Approximation:** the heatmap reads one row per deal, so `daysInStage` is a
  per-deal scalar (days in the current stage), not a full per-stage matrix — noted in a config
  comment.

### Files touched

`examples/x-studio-shared/src/crmData/generator.ts`,
`examples/x-studio-shared/src/config/salesDashboard.ts`,
`packages/x-studio/src/internals/chartAggregation.ts` (+ `.test.ts`),
`packages/x-studio/src/models/widgetTypes.ts`,
`packages/x-studio/src/components/widgets/StudioChartWidget/StudioChartWidget.tsx`,
`packages/x-studio/src/components/widgets/StudioChartWidget/StudioFunnelChart.tsx`,
`docs/data/studio/widgets/chart/chart.md`.
