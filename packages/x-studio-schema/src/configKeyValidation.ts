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
import type { BuiltinStudioWidgetKind, StudioWidgetKind } from './baseTypes';
import type {
  StudioChartConfig,
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

const CHART_CONFIG_KEYS = [
  'chartType',
  'barLayout',
  'barBandLabelWrap',
  'wrapBandLabelMaxLines',
  'barCategoryGapRatio',
  'barMinBandSize',
  'barMaxCategories',
  'axisTickFontSize',
  'xField',
  'yField',
  'yAggregation',
  'ySeries',
  'yField2',
  'seriesField',
  'xGroupBy',
  'chartSortBy',
  'chartSortDirection',
  'scatterColorField',
  'scatterSizeField',
  'scatterMinRadius',
  'scatterMaxRadius',
  'dualYAxis',
  'heatYField',
  'heatColorScheme',
  'heatLegendPosition',
  'heatLegendAlign',
  'heatSortBy',
  'heatSortDirection',
  'ganttLabelField',
  'ganttStartField',
  'ganttEndField',
  'ganttColorField',
  'funnelCategoryOrder',
  'funnelReachedField',
  'funnelStageSequence',
  'funnelLabelFormat',
  'funnelLabelPlacement',
  'funnelGap',
  'funnelCurve',
  'funnelVariant',
  'sankeyTargetField',
  'sankeyLinkColor',
  'sankeyShowValues',
  'pieArcLabel',
  'pieArcLabelMinAngle',
  'pieMaxSlices',
  'pieLegendBelow',
  'gaugeMin',
  'gaugeMax',
  'crossFilterMode',
  'annotations',
  'forecast',
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
 */
export function validateConfigKeysForKind(
  kind: StudioWidgetKind,
  config: Record<string, unknown>,
): string[] {
  const allowed = getAllowedConfigKeys(kind);
  if (allowed === null) {
    return [];
  }
  return Object.keys(config).filter((key) => !allowed.has(key));
}
