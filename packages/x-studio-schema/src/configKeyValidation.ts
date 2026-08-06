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
  StudioWidgetConfig,
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
  'crossFilterMode',
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
// `StudioChart*Config` interfaces), each tuple listing its family's OWN key set
// INCLUDING the `chartSortBy`/`chartSortDirection` (sort) keys it inherits. The
// shared card-chrome keys (`crossFilterMode`, `titleFontSize`, …) are NOT listed
// per family — they live in `SHARED_CONFIG_KEYS` and `getAllowedChartConfigKeys`
// unions them in. Families sharing a config interface (bar/bar-stacked/bar-100 →
// one tuple; line/area/area-stacked/area-100 → one; pie/donut → one) reuse the
// same tuple in the chartType map below.

const BAR_FAMILY_CHART_KEYS = [
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
  'chartType',
  'ganttLabelField',
  'ganttStartField',
  'ganttEndField',
  'ganttColorField',
] as const satisfies readonly (keyof StudioGanttChartConfig)[];
const GANTT_KEYS_COVERED: AssertKeysCovered<StudioGanttChartConfig, typeof GANTT_CHART_KEYS> = true;
void GANTT_KEYS_COVERED;

const SANKEY_CHART_KEYS = [
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
// `CHART_CONFIG_KEYS` is the union of the chart families' OWN keys, so it covers
// `StudioChartConfig` minus the shared card-chrome keys (which `StudioChartConfig`
// now inherits from `StudioSharedWidgetConfig` and which are validated by the
// SHARED layer, not the per-family tuples).
const CHART_KEYS_COVERED: AssertKeysCovered<
  Omit<StudioChartConfig, keyof StudioSharedWidgetConfig>,
  typeof CHART_CONFIG_KEYS
> = true;
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
  if (!Object.hasOwn(CHART_TYPE_CONFIG_KEYS, chartType)) {
    return new Set<string>();
  }
  // Shared card-chrome keys (including `crossFilterMode`, now a shared key read by
  // every widget kind — not chart-only) are valid on a chart config too, so they
  // are always allowed alongside the family-specific keys. Mirrors how
  // `getAllowedConfigKeys` composes SHARED ∪ own keys at the kind level.
  return new Set<string>([...SHARED_CONFIG_KEYS, ...CHART_TYPE_CONFIG_KEYS[chartType]]);
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
 * NOT USED BY ANY TRUST BOUNDARY IN THIS PACKAGE, deliberately. `parseStateMutation.ts`'s
 * `validateWidget` used to call it to normalize an `addWidget`/`applyBulkUpdate.addedWidgets`
 * payload in place, which made the wire boundary the ONE place a foreign-family key was
 * deleted: `deserializeState` preserves such keys, and so does `applyMutation`'s config
 * merge. That disagreement silently destroyed exactly the keys
 * retention-across-chartType-switch exists to keep (see `StudioChartConfig`'s doc in
 * `widgetTypes.ts`) whenever a stored widget was round-tripped through the wire — duplicated,
 * or moved across dashboards. All three boundaries now PRESERVE.
 *
 * It stays exported as a public utility for the opposite intent: a host or tool that wants a
 * config REDUCED to one family (a "reset to this chart type's keys" affordance, an export
 * that should not carry dormant keys) has an implementation to call rather than hand-rolling
 * one that drifts from `getAllowedChartConfigKeys`. Shallow and key-presence-based, mirroring
 * the validators above.
 *
 * As of this audit it has zero callers anywhere in the monorepo (outside its own tests in
 * `configKeyValidation.test.ts`) — confirmed by grepping `packages/` and `examples/`. That is
 * expected, not a bug to fix: don't spend time hunting for a caller that doesn't exist.
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

/**
 * The primitive type a scalar config key's value must have, or `never` for a key whose declared
 * type is not a bare `boolean`/`number` (a string union, an array, a nested object).
 *
 * Every conditional is written in the `[T] extends [U]` tuple form deliberately: a bare
 * `T extends boolean` DISTRIBUTES over `boolean` (which is `true | false`) and over any union,
 * so a `'day' | 'week'` key would resolve to a union of branches rather than a single answer.
 * The leading `never` guard matters for the same class of reason — `never` extends everything,
 * so a key declared `?: undefined` would otherwise be classified as a boolean.
 */
type ScalarConfigTypeName<T> = [NonNullable<T>] extends [never]
  ? never
  : [NonNullable<T>] extends [boolean]
    ? 'boolean'
    : [NonNullable<T>] extends [number]
      ? 'number'
      : never;

/** The keys of {@link StudioWidgetConfig} whose declared type is a bare `boolean` or `number`. */
type ScalarConfigKey = {
  [K in keyof StudioWidgetConfig]-?: [ScalarConfigTypeName<StudioWidgetConfig[K]>] extends [never]
    ? never
    : K;
}[keyof StudioWidgetConfig];

/**
 * Exactly the scalar config keys, each mapped to the primitive its declaration requires.
 *
 * Being a mapped type over `ScalarConfigKey` rather than a hand-written `Record<string, …>` is
 * the entire point: a missing key, a stray key, and a `'number'` written against a `boolean`-
 * declared property are all COMPILE errors. See {@link SCALAR_CONFIG_VALUE_TYPES}.
 */
export type ScalarConfigValueTypes = {
  [K in ScalarConfigKey]-?: ScalarConfigTypeName<StudioWidgetConfig[K]>;
};

/**
 * Runtime value-type expectations for every scalar config key.
 *
 * The counterpart to the key allow-lists above: those answer "may this writer set this key",
 * this answers "must the value be a boolean or a number". Both questions are asked at the same
 * untyped write boundaries — `StudioController.updateWidgetConfig` and the AI's tool-call
 * arguments — and neither is answered by the types alone, because a `StudioWidgetConfig` that
 * arrives over a wire has been through `JSON.parse` and is typed by assertion, not by checking.
 *
 * The concrete hazard, in the words of the middleware finding that produced the original table:
 * `update_widget({ config: { pivotShowTotals: "…" } })` stores a STRING in a field declared
 * `boolean`, which is a structurally-broken widget the client then has to render.
 *
 * **This lives here, beside the key lists, because it had already drifted from the type it
 * mirrors.** It was a 21-entry hand-maintained object in `@mui/x-studio-ai-middleware`, whose
 * comment described the set as "intentionally small (the scalar toggles the tools populate)".
 * That was true when written; by the time it was measured, 15 of the 36 scalar keys were absent
 * and every one of the 15 passed `validateConfigKeysForKind` — so a tool could write them and
 * nothing checked the value. Nothing would have surfaced that: a runtime mirror of a static
 * type, in a different package from the type, with no link between them. `ScalarConfigValueTypes`
 * is that link, and it is the same technique `AssertKeysCovered` already applies to the key
 * lists above.
 */
export const SCALAR_CONFIG_VALUE_TYPES: ScalarConfigValueTypes = {
  // boolean toggles
  dualYAxis: 'boolean',
  sankeyShowValues: 'boolean',
  pieLegendBelow: 'boolean',
  kpiCompact: 'boolean',
  kpiSparkline: 'boolean',
  kpiSparklineArea: 'boolean',
  kpiSparklineCumulative: 'boolean',
  kpiTrend: 'boolean',
  kpiTrendInvert: 'boolean',
  pivotShowTotals: 'boolean',
  mapCrossFilterEmit: 'boolean',
  mapLegendZeroMin: 'boolean',
  textAiEnabled: 'boolean',
  // numeric settings — bar/axis
  barBandLabelWrap: 'number',
  wrapBandLabelMaxLines: 'number',
  barCategoryGapRatio: 'number',
  barMinBandSize: 'number',
  barMaxCategories: 'number',
  axisTickFontSize: 'number',
  // numeric settings — per chart family
  funnelGap: 'number',
  pieArcLabelMinAngle: 'number',
  pieMaxSlices: 'number',
  scatterMinRadius: 'number',
  scatterMaxRadius: 'number',
  gaugeMin: 'number',
  gaugeMax: 'number',
  // numeric settings — non-chart kinds
  filterWidgetMin: 'number',
  filterWidgetMax: 'number',
  filterWidgetStep: 'number',
  gridHeight: 'number',
  kpiSparklineGaugeMax: 'number',
  textTitleFontSize: 'number',
  textSubtitleFontSize: 'number',
  textBodyFontSize: 'number',
  textTitleFontWeight: 'number',
  titleFontSize: 'number',
};

/**
 * The scalar config keys whose value is present and of the wrong primitive type, as
 * `"<key> (expected a finite number)"` / `"<key> (expected a boolean)"` fragments.
 *
 * Returns an empty array when every present scalar value is well-typed. A `null`/`undefined`
 * value is INERT rather than a violation — clearing a key is handled by the dedicated unset
 * paths, and treating an explicit `null` as an error would reject them. `number` additionally
 * requires finiteness: `NaN`/`Infinity` are `typeof 'number'` but serialize to `null`, so a
 * config carrying one silently loses the value on the next round-trip.
 *
 * Returns fragments rather than a finished sentence so each caller can address its own audience
 * — the AI middleware owes the model an actionable retry message, a client-side writer owes its
 * caller something else. Same division the key validators above follow.
 */
export function validateConfigValueTypes(config: Record<string, unknown>): string[] {
  const offenders: string[] = [];
  for (const [key, expected] of Object.entries(SCALAR_CONFIG_VALUE_TYPES)) {
    if (!Object.hasOwn(config, key)) {
      continue;
    }
    const value = config[key];
    if (value === null || value === undefined) {
      continue;
    }
    if (expected === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        offenders.push(`${key} (expected a finite number)`);
      }
    } else if (typeof value !== 'boolean') {
      offenders.push(`${key} (expected a boolean)`);
    }
  }
  return offenders;
}
