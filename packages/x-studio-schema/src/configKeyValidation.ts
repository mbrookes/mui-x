/**
 * Write-side runtime guard for per-kind widget config keys.
 *
 * The `StudioWidgetConfigForKind<K>` type change (see `widgetTypes.ts`) only
 * helps code that READS `widget.config` after narrowing on `widget.kind`. It
 * does nothing to stop a WRITE of a wrong-kind key: neither
 * `StudioController.updateWidgetConfig` nor the AI's tool-call arguments are
 * type-checked against a specific object at runtime, so a Chart-only key can
 * still be written onto a Grid widget's config over those boundaries. These two
 * functions close that gap by checking, at runtime, that a config's keys belong
 * to the widget's kind.
 *
 * Why a hand-maintained key list per kind (rather than deriving the keys from a
 * representative default instance via `factories.ts`): a default instance only
 * carries the couple of keys the factory seeds (e.g. `grid` defaults to just
 * `{ columns: [] }`), so deriving from it would under-report the allowed set and
 * wrongly flag every other legitimate key as a stray. The interface, not the
 * default, is the real allow-list. TS interfaces don't exist at runtime, so the
 * only faithful representation is an explicit key array — and the `satisfies` +
 * `AssertKeysCovered` guards below make it a COMPILE error if a kind's interface
 * gains or loses a key without this list following, so the lists can't silently
 * drift from the interfaces they mirror.
 */
import type { BuiltinStudioWidgetKind, StudioChartType, StudioWidgetKind } from './baseTypes';
import type {
  StudioBarFamilyChartConfig,
  StudioChartConfig,
  StudioFunnelChartConfig,
  StudioGaugeChartConfig,
  StudioGanttChartConfig,
  StudioHeatmapChartConfig,
  StudioLineAreaFamilyChartConfig,
  StudioMixedChartConfig,
  StudioPieFamilyChartConfig,
  StudioSankeyChartConfig,
  StudioScatterChartConfig,
  StudioFilterWidgetConfig,
  StudioGridConfig,
  StudioKpiConfig,
  StudioMapConfig,
  StudioPivotConfig,
  StudioSharedWidgetConfig,
  StudioTextConfig,
} from './widgetTypes';

/**
 * Compile-time assertion that a readonly key tuple `K` covers EXACTLY the keys
 * of interface `T` — no missing keys (a new interface key without a list entry)
 * and, via the `satisfies` on each list, no stray keys. Resolves to `true` when
 * the tuple is complete; otherwise to a descriptive error tuple naming the
 * uncovered keys, which makes the offending `const _assert: … = true` line fail.
 */
type AssertKeysCovered<T, K extends readonly (keyof T)[]> =
  Exclude<keyof T, K[number]> extends never
    ? true
    : ['config-key list is missing keys:', Exclude<keyof T, K[number]>];

const SHARED_CONFIG_KEYS = [
  'titleFontSize',
  'cardExpandTitle',
  'measures',
  'dimensions',
  'customConfig',
] as const satisfies readonly (keyof StudioSharedWidgetConfig)[];
const SHARED_KEYS_COVERED: AssertKeysCovered<StudioSharedWidgetConfig, typeof SHARED_CONFIG_KEYS> =
  true;
void SHARED_KEYS_COVERED;

const GRID_CONFIG_KEYS = [
  'columns',
  'gridGroupByField',
  'gridAggregations',
  'gridSortField',
  'gridSortDirection',
  'gridHeight',
  'gridConditionalFormats',
  'gridPkField',
  'gridSummaryFields',
  'crossFilterField',
] as const satisfies readonly (keyof StudioGridConfig)[];
const GRID_KEYS_COVERED: AssertKeysCovered<StudioGridConfig, typeof GRID_CONFIG_KEYS> = true;
void GRID_KEYS_COVERED;

// ── Per-chartType config-key layer ──────────────────────────────────────────────
//
// One key tuple + `AssertKeysCovered` compile-lock per CHART FAMILY (the 10
// `StudioChart*Config` interfaces), each tuple listing its family's COMPLETE key
// set INCLUDING the shared `crossFilterMode` (base) and `chartSortBy`/
// `chartSortDirection` (sort) keys it inherits — so `getAllowedChartConfigKeys`
// can return the tuple verbatim with no separate base/sort union. Families sharing
// a config interface (bar/bar-stacked/bar-100 → one tuple; line/area/area-stacked/
// area-100 → one; pie/donut → one) reuse the same tuple in the chartType map below.

const BAR_FAMILY_CHART_KEYS = [
  'crossFilterMode',
  'chartSortBy',
  'chartSortDirection',
  'chartType',
  'xField',
  'yField',
  'yAggregation',
  'ySeries',
  'yField2',
  'seriesField',
  'xGroupBy',
  'barLayout',
  'barBandLabelWrap',
  'wrapBandLabelMaxLines',
  'barCategoryGapRatio',
  'barMinBandSize',
  'barMaxCategories',
  'axisTickFontSize',
  'annotations',
] as const satisfies readonly (keyof StudioBarFamilyChartConfig)[];
const BAR_FAMILY_KEYS_COVERED: AssertKeysCovered<
  StudioBarFamilyChartConfig,
  typeof BAR_FAMILY_CHART_KEYS
> = true;
void BAR_FAMILY_KEYS_COVERED;

const LINE_AREA_FAMILY_CHART_KEYS = [
  'crossFilterMode',
  'chartSortBy',
  'chartSortDirection',
  'chartType',
  'xField',
  'yField',
  'yAggregation',
  'ySeries',
  'yField2',
  'seriesField',
  'xGroupBy',
  'axisTickFontSize',
  'annotations',
  'forecast',
] as const satisfies readonly (keyof StudioLineAreaFamilyChartConfig)[];
const LINE_AREA_FAMILY_KEYS_COVERED: AssertKeysCovered<
  StudioLineAreaFamilyChartConfig,
  typeof LINE_AREA_FAMILY_CHART_KEYS
> = true;
void LINE_AREA_FAMILY_KEYS_COVERED;

const MIXED_CHART_KEYS = [
  'crossFilterMode',
  'chartSortBy',
  'chartSortDirection',
  'chartType',
  'xField',
  'yField',
  'yAggregation',
  'ySeries',
  'yField2',
  'seriesField',
  'xGroupBy',
  'dualYAxis',
  'axisTickFontSize',
  'annotations',
] as const satisfies readonly (keyof StudioMixedChartConfig)[];
const MIXED_KEYS_COVERED: AssertKeysCovered<StudioMixedChartConfig, typeof MIXED_CHART_KEYS> = true;
void MIXED_KEYS_COVERED;

const HEATMAP_CHART_KEYS = [
  'crossFilterMode',
  'chartType',
  'xField',
  'heatYField',
  'yField',
  'ySeries',
  'yAggregation',
  'xGroupBy',
  'heatColorScheme',
  'heatLegendPosition',
  'heatLegendAlign',
  'heatSortBy',
  'heatSortDirection',
  'axisTickFontSize',
] as const satisfies readonly (keyof StudioHeatmapChartConfig)[];
const HEATMAP_KEYS_COVERED: AssertKeysCovered<StudioHeatmapChartConfig, typeof HEATMAP_CHART_KEYS> =
  true;
void HEATMAP_KEYS_COVERED;

const FUNNEL_CHART_KEYS = [
  'crossFilterMode',
  'chartType',
  'xField',
  'yField',
  'ySeries',
  'yAggregation',
  'chartSortBy',
  'funnelCategoryOrder',
  'funnelReachedField',
  'funnelStageSequence',
  'funnelLabelFormat',
  'funnelLabelPlacement',
  'funnelGap',
  'funnelCurve',
  'funnelVariant',
] as const satisfies readonly (keyof StudioFunnelChartConfig)[];
const FUNNEL_KEYS_COVERED: AssertKeysCovered<StudioFunnelChartConfig, typeof FUNNEL_CHART_KEYS> =
  true;
void FUNNEL_KEYS_COVERED;

const GANTT_CHART_KEYS = [
  'crossFilterMode',
  'chartType',
  'ganttLabelField',
  'ganttStartField',
  'ganttEndField',
  'ganttColorField',
] as const satisfies readonly (keyof StudioGanttChartConfig)[];
const GANTT_KEYS_COVERED: AssertKeysCovered<StudioGanttChartConfig, typeof GANTT_CHART_KEYS> = true;
void GANTT_KEYS_COVERED;

const SANKEY_CHART_KEYS = [
  'crossFilterMode',
  'chartType',
  'xField',
  'yField',
  'ySeries',
  'sankeyTargetField',
  'sankeyLinkColor',
  'sankeyShowValues',
] as const satisfies readonly (keyof StudioSankeyChartConfig)[];
const SANKEY_KEYS_COVERED: AssertKeysCovered<StudioSankeyChartConfig, typeof SANKEY_CHART_KEYS> =
  true;
void SANKEY_KEYS_COVERED;

const PIE_FAMILY_CHART_KEYS = [
  'crossFilterMode',
  'chartSortBy',
  'chartSortDirection',
  'chartType',
  'xField',
  'yField',
  'yAggregation',
  'ySeries',
  'seriesField',
  'xGroupBy',
  'pieArcLabel',
  'pieArcLabelMinAngle',
  'pieMaxSlices',
  'pieLegendBelow',
] as const satisfies readonly (keyof StudioPieFamilyChartConfig)[];
const PIE_FAMILY_KEYS_COVERED: AssertKeysCovered<
  StudioPieFamilyChartConfig,
  typeof PIE_FAMILY_CHART_KEYS
> = true;
void PIE_FAMILY_KEYS_COVERED;

const SCATTER_CHART_KEYS = [
  'crossFilterMode',
  'chartType',
  'xField',
  'yField',
  'ySeries',
  'yField2',
  'scatterColorField',
  'scatterSizeField',
  'scatterMinRadius',
  'scatterMaxRadius',
  'axisTickFontSize',
  'annotations',
] as const satisfies readonly (keyof StudioScatterChartConfig)[];
const SCATTER_KEYS_COVERED: AssertKeysCovered<StudioScatterChartConfig, typeof SCATTER_CHART_KEYS> =
  true;
void SCATTER_KEYS_COVERED;

const GAUGE_CHART_KEYS = [
  'crossFilterMode',
  'chartType',
  'yField',
  'yAggregation',
  'gaugeMin',
  'gaugeMax',
] as const satisfies readonly (keyof StudioGaugeChartConfig)[];
const GAUGE_KEYS_COVERED: AssertKeysCovered<StudioGaugeChartConfig, typeof GAUGE_CHART_KEYS> = true;
void GAUGE_KEYS_COVERED;

/**
 * Own config keys per `StudioChartType`, typed as `Record<StudioChartType, …>` so
 * adding a chart type without an entry is a compile error (fail-closed). Families
 * that share a config interface point at the same tuple. Each tuple already
 * includes the shared base/sort keys (see the block comment above).
 */
const CHART_TYPE_CONFIG_KEYS: Record<StudioChartType, readonly string[]> = {
  bar: BAR_FAMILY_CHART_KEYS,
  'bar-stacked': BAR_FAMILY_CHART_KEYS,
  'bar-100': BAR_FAMILY_CHART_KEYS,
  line: LINE_AREA_FAMILY_CHART_KEYS,
  area: LINE_AREA_FAMILY_CHART_KEYS,
  'area-stacked': LINE_AREA_FAMILY_CHART_KEYS,
  'area-100': LINE_AREA_FAMILY_CHART_KEYS,
  mixed: MIXED_CHART_KEYS,
  heatmap: HEATMAP_CHART_KEYS,
  funnel: FUNNEL_CHART_KEYS,
  gantt: GANTT_CHART_KEYS,
  sankey: SANKEY_CHART_KEYS,
  pie: PIE_FAMILY_CHART_KEYS,
  donut: PIE_FAMILY_CHART_KEYS,
  scatter: SCATTER_CHART_KEYS,
  gauge: GAUGE_CHART_KEYS,
};

/**
 * The kind-level chart allow-list (consumed by `BUILTIN_OWN_CONFIG_KEYS.chart`),
 * DERIVED as the union of every per-chartType tuple so the two levels can't drift.
 * Duplicate keys across families are harmless — `getAllowedConfigKeys` builds a
 * `Set`. The literal tuple (not a `Set`) preserves the exact key union so the
 * `AssertKeysCovered` below still fails closed against the recomposed flat
 * `StudioChartConfig` if a family gains/loses a key.
 */
const CHART_CONFIG_KEYS = [
  ...BAR_FAMILY_CHART_KEYS,
  ...LINE_AREA_FAMILY_CHART_KEYS,
  ...MIXED_CHART_KEYS,
  ...HEATMAP_CHART_KEYS,
  ...FUNNEL_CHART_KEYS,
  ...GANTT_CHART_KEYS,
  ...SANKEY_CHART_KEYS,
  ...PIE_FAMILY_CHART_KEYS,
  ...SCATTER_CHART_KEYS,
  ...GAUGE_CHART_KEYS,
] as const satisfies readonly (keyof StudioChartConfig)[];
const CHART_KEYS_COVERED: AssertKeysCovered<StudioChartConfig, typeof CHART_CONFIG_KEYS> = true;
void CHART_KEYS_COVERED;

const KPI_CONFIG_KEYS = [
  'kpiValueField',
  'kpiAggregation',
  'kpiCompact',
  'kpiPrefix',
  'kpiSuffix',
  'kpiSparkline',
  'kpiSparklineField',
  'kpiSparklineSourceId',
  'kpiSparklinePlotType',
  'kpiSparklineArea',
  'kpiSparklineGranularity',
  'kpiSparklineCumulative',
  'kpiTrend',
  'kpiTrendComparison',
  'kpiTrendInvert',
  'kpiTrendFixedPeriod',
  'kpiSparklineGaugeMax',
] as const satisfies readonly (keyof StudioKpiConfig)[];
const KPI_KEYS_COVERED: AssertKeysCovered<StudioKpiConfig, typeof KPI_CONFIG_KEYS> = true;
void KPI_KEYS_COVERED;

const TEXT_CONFIG_KEYS = [
  'textContent',
  'textSubtitle',
  'textBody',
  'textAiEnabled',
  'textTitleFontFamily',
  'textTitleFontSize',
  'textTitleFontWeight',
  'textTitleColor',
  'textTitleAlign',
  'textSubtitleFontFamily',
  'textSubtitleFontSize',
  'textSubtitleColor',
  'textSubtitleAlign',
  'textBodyFontFamily',
  'textBodyFontSize',
  'textBodyColor',
  'textBodyAlign',
] as const satisfies readonly (keyof StudioTextConfig)[];
const TEXT_KEYS_COVERED: AssertKeysCovered<StudioTextConfig, typeof TEXT_CONFIG_KEYS> = true;
void TEXT_KEYS_COVERED;

const FILTER_CONFIG_KEYS = [
  'filterWidgetType',
  'filterWidgetField',
  'filterWidgetSourceId',
  'filterWidgetMin',
  'filterWidgetMax',
  'filterWidgetStep',
] as const satisfies readonly (keyof StudioFilterWidgetConfig)[];
const FILTER_KEYS_COVERED: AssertKeysCovered<StudioFilterWidgetConfig, typeof FILTER_CONFIG_KEYS> =
  true;
void FILTER_KEYS_COVERED;

const PIVOT_CONFIG_KEYS = [
  'pivotRowField',
  'pivotColField',
  'pivotValueField',
  'pivotAggregation',
  'pivotShowTotals',
] as const satisfies readonly (keyof StudioPivotConfig)[];
const PIVOT_KEYS_COVERED: AssertKeysCovered<StudioPivotConfig, typeof PIVOT_CONFIG_KEYS> = true;
void PIVOT_KEYS_COVERED;

const MAP_CONFIG_KEYS = [
  'mapCountryField',
  'mapCountrySourceId',
  'mapValueField',
  'mapValueSourceId',
  'mapAggregation',
  'mapGeography',
  'mapColorScheme',
  'mapLegendZeroMin',
  'mapCrossFilterEmit',
  'mapLegendPosition',
  'mapLegendAlign',
] as const satisfies readonly (keyof StudioMapConfig)[];
const MAP_KEYS_COVERED: AssertKeysCovered<StudioMapConfig, typeof MAP_CONFIG_KEYS> = true;
void MAP_KEYS_COVERED;

/**
 * Own (non-shared) config keys per built-in kind. Typed as
 * `Record<BuiltinStudioWidgetKind, …>` so adding a new built-in kind without an
 * entry here is a compile error (fail-closed), mirroring `BUILTIN_WIDGET_DEFAULTS`.
 */
const BUILTIN_OWN_CONFIG_KEYS: Record<BuiltinStudioWidgetKind, readonly string[]> = {
  grid: GRID_CONFIG_KEYS,
  chart: CHART_CONFIG_KEYS,
  kpi: KPI_CONFIG_KEYS,
  text: TEXT_CONFIG_KEYS,
  filter: FILTER_CONFIG_KEYS,
  pivot: PIVOT_CONFIG_KEYS,
  map: MAP_CONFIG_KEYS,
};

/**
 * The set of config keys allowed on a widget of the given `kind`: the shared
 * config keys plus that kind's own interface keys.
 *
 * Returns `null` for an unknown / consumer-defined custom kind — a custom widget
 * has no built-in per-kind config surface, so NO key restriction is enforced for
 * it (callers treat `null` as "anything goes"). `Object.hasOwn` (not `kind in`)
 * so an untrusted kind like `'constructor'` is treated as custom rather than
 * matching a prototype-chain member.
 */
export function getAllowedConfigKeys(kind: StudioWidgetKind): Set<string> | null {
  if (!Object.hasOwn(BUILTIN_OWN_CONFIG_KEYS, kind)) {
    return null;
  }
  const ownKeys = BUILTIN_OWN_CONFIG_KEYS[kind as BuiltinStudioWidgetKind];
  return new Set<string>([...SHARED_CONFIG_KEYS, ...ownKeys]);
}

/**
 * Returns the keys present in `config` that are NOT valid for the given `kind`
 * (i.e. not in the shared keys or that kind's own key set). An empty array means
 * the config is valid for the kind. For an unknown / custom kind (no restriction),
 * always returns `[]`.
 *
 * This is a key-PRESENCE check only — it does not validate value types or deeper
 * semantics, matching the shallow, shape-only validation style of every other
 * validator in `parseStateMutation.ts`.
 *
 * Keys whose value is `undefined` are skipped: an `undefined` value can only ever
 * DELETE a key when the config is merged (never persist a wrong-family value), so
 * flagging it produces false positives — e.g. switching chart types sends
 * `{ chartType: 'line', barLayout: undefined }`, and `barLayout: undefined` merely
 * clears the stale key rather than corrupting the config.
 */
export function validateConfigKeysForKind(
  kind: StudioWidgetKind,
  config: Record<string, unknown>,
): string[] {
  const allowed = getAllowedConfigKeys(kind);
  if (allowed === null) {
    return [];
  }
  return Object.keys(config).filter((key) => config[key] !== undefined && !allowed.has(key));
}

// ── Chart-type validators ─────────────────────────────────────────────────────
//
// Asymmetry vs. the kind-level validator above: an unrecognized widget KIND is a
// real, supported case (consumer-defined custom widgets), so `getAllowedConfigKeys`
// returns `null` = "no restriction". There are NO custom CHART types —
// `StudioChartType` is a closed union — so there is no "anything goes" chart type.
// `getAllowedChartConfigKeys` is therefore TOTAL over `StudioChartType` and never
// returns `null`. Callers holding an untrusted string must gate it with
// `isStudioChartType` first and treat a non-member as a HARD ERROR, rather than
// passing it here and expecting a permissive pass-through.

/**
 * The set of config keys allowed on a chart of the given `chartType`: its family's
 * full key set (already including the shared base/sort keys — see
 * `CHART_TYPE_CONFIG_KEYS`). Total over `StudioChartType`; there is no custom /
 * unrestricted chart type.
 */
export function getAllowedChartConfigKeys(chartType: StudioChartType): Set<string> {
  return new Set<string>(CHART_TYPE_CONFIG_KEYS[chartType]);
}

/**
 * Returns the keys present in `config` that are NOT valid for the given
 * `chartType`. An empty array means the config is valid for that chart type. Like
 * `validateConfigKeysForKind`, this is a shallow key-PRESENCE check only.
 *
 * The caller is responsible for having validated `chartType` (e.g. via
 * `isStudioChartType`) — passing a string that is not a real `StudioChartType`
 * yields an empty allow-list and thus flags every key, which is the intended
 * fail-closed behavior for an unknown chart type (there is no permissive mode).
 *
 * Keys whose value is `undefined` are skipped (same rationale as
 * `validateConfigKeysForKind`): an `undefined` value can only DELETE a key on
 * merge, never persist a wrong-family value, so flagging it is a false positive.
 */
export function validateChartConfigKeysForType(
  chartType: StudioChartType,
  config: Record<string, unknown>,
): string[] {
  const allowed = getAllowedChartConfigKeys(chartType);
  return Object.keys(config).filter((key) => config[key] !== undefined && !allowed.has(key));
}

/**
 * Returns a copy of `config` retaining ONLY the keys valid for `chartType`'s
 * effective family (per {@link getAllowedChartConfigKeys}); any key belonging to a
 * different chart family is dropped.
 *
 * WHY THIS EXISTS (future-use — no current call site): the write-side full-widget
 * wire check (`parseStateMutation.ts`'s `validateWidget`) is STATELESS and rejects
 * any full widget whose config carries a key outside its `chartType`'s family. A
 * STORED chart config legitimately retains keys authored under a previously-selected
 * chartType (retention-across-chartType-switch — see `StudioChartConfig`'s doc in
 * `widgetTypes.ts`), so a future producer that round-trips a stored widget through
 * `addWidget`/`applyBulkUpdate.addedWidgets` must strip it to its effective family's
 * keys FIRST via this helper, or the valid, user-authored config is rejected at the
 * boundary. This is the sanctioned way to do that strip. Shallow, key-presence-based,
 * mirroring the validators above.
 */
export function stripForeignFamilyKeys(
  config: Record<string, unknown>,
  chartType: StudioChartType,
): Record<string, unknown> {
  const allowed = getAllowedChartConfigKeys(chartType);
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    if (allowed.has(key)) {
      next[key] = config[key];
    }
  }
  return next;
}
