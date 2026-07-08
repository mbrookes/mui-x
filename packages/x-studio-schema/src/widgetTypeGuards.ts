/**
 * Runtime type guards for narrowing a `StudioWidget` to a single kind.
 *
 * WHY THIS EXISTS (important): `StudioWidget` includes a catch-all
 * `StudioWidgetOf<string & {}>` member so consumer-defined CUSTOM widget kinds
 * are first-class (a shipping feature). That member's `kind` is a non-literal
 * `string`, which means the union is NOT a TypeScript discriminated union — so a
 * bare `if (widget.kind === 'chart')` check does NOT narrow `widget.config` to
 * the chart config (TS keeps every member because `string` could equal
 * `'chart'`). This guard performs the same runtime check but ASSERTS the precise
 * `StudioWidgetOf<K>` result type, restoring per-kind config narrowing at the
 * cross-kind read sites (dispatchers, registries, summary/insight builders).
 *
 * Single-kind components should instead type their prop directly as
 * `StudioWidgetOf<'chart'>` (no guard needed); this guard is for the genuinely
 * cross-kind sites that branch on `widget.kind`.
 */
import type { BuiltinStudioWidgetKind, StudioChartType } from './baseTypes';
import type {
  StudioChartConfig,
  StudioChartConfigByType,
  StudioChartConfigOfType,
  StudioChartWidgetConfig,
  StudioWidget,
  StudioWidgetOf,
} from './widgetTypes';

/**
 * Narrows `widget` to `StudioWidgetOf<K>` when its `kind` matches `kind`.
 * Use in place of a bare `widget.kind === kind` check when you then need to read
 * `widget.config`'s kind-specific keys.
 */
export function isWidgetOfKind<K extends BuiltinStudioWidgetKind>(
  widget: StudioWidget,
  kind: K,
): widget is StudioWidgetOf<K> {
  return widget.kind === kind;
}

// ── Chart-type helpers ──────────────────────────────────────────────────────────
//
// Unlike `isWidgetOfKind` (which is MANDATORY because `StudioWidget` carries a
// non-literal custom-kind member, defeating native discrimination),
// `StudioChartWidgetConfig` IS a closed discriminated union. A bare
// `config.chartType === 'gauge'` narrows it natively. The helpers below therefore
// exist only for the narrower ergonomic needs the closed union does not cover.

/**
 * Resolves a chart config's effective chart type, applying the runtime default
 * `config.chartType ?? 'bar'` in one place. Use wherever the concrete type is
 * needed (registry lookup, describe/summary code) so the `'bar'` default is not
 * re-spelled at every call site.
 */
export function resolveChartType(config: Pick<StudioChartConfig, 'chartType'>): StudioChartType {
  return config.chartType ?? 'bar';
}

/**
 * Narrows a chart config to the family shape for `type`, applying the same
 * `?? 'bar'` default as {@link resolveChartType}.
 *
 * NOT needed for a plain `config.chartType === 'x'` check: because
 * `StudioChartWidgetConfig` is a CLOSED discriminated union, bare equality already
 * narrows it. Reach for this guard only when narrowing (a) a value still typed as
 * the flat `StudioChartConfig` (which has all keys, so `===` does not narrow it to
 * a family), or (b) via an already-resolved chart-type variable rather than an
 * inline literal.
 */
export function isChartConfigOfType<T extends StudioChartType>(
  config: StudioChartConfig | StudioChartWidgetConfig,
  type: T,
): config is StudioChartConfigOfType<T> {
  return (config.chartType ?? 'bar') === type;
}

/**
 * Every `StudioChartType` literal. The `as const` preserves the literal element
 * types so `(typeof STUDIO_CHART_TYPES)[number]` is the exact union of listed types;
 * the `satisfies readonly (keyof StudioChartConfigByType)[]` clause checks each
 * element is a VALID chart type (no stray entry). Element-validity alone does NOT
 * enforce COMPLETENESS — a list missing `'gauge'` still satisfies it — so the
 * `AssertAllChartTypesListed` error-tuple lock below (the same pattern as
 * `widgetTypes.ts`'s `AssertChartTypesCovered`) fails the build if any
 * `StudioChartType` literal is absent from this list.
 */
export const STUDIO_CHART_TYPES = [
  'bar',
  'bar-stacked',
  'bar-100',
  'line',
  'area',
  'area-stacked',
  'area-100',
  'mixed',
  'heatmap',
  'funnel',
  'gantt',
  'sankey',
  'pie',
  'donut',
  'scatter',
  'gauge',
] as const satisfies readonly (keyof StudioChartConfigByType)[];

/**
 * Fail-closed compile-time assertion that EVERY `StudioChartType` literal appears in
 * `STUDIO_CHART_TYPES`. Resolves to `true` when the list is complete; otherwise to a
 * descriptive error tuple naming the missing chart types, which makes the
 * `ALL_CHART_TYPES_LISTED` binding below fail to compile. This is what actually
 * fail-closes the list — `isStudioChartType` gates every `addWidget`/`add_widget`
 * boundary, so a new chart type missing here would be silently rejected everywhere.
 */
type AssertAllChartTypesListed =
  Exclude<StudioChartType, (typeof STUDIO_CHART_TYPES)[number]> extends never
    ? true
    : [
        'STUDIO_CHART_TYPES is missing:',
        Exclude<StudioChartType, (typeof STUDIO_CHART_TYPES)[number]>,
      ];
const ALL_CHART_TYPES_LISTED: AssertAllChartTypesListed = true;
void ALL_CHART_TYPES_LISTED;

/** Runtime membership test for the closed `StudioChartType` union. */
export function isStudioChartType(value: string): value is StudioChartType {
  return (STUDIO_CHART_TYPES as readonly string[]).includes(value);
}
