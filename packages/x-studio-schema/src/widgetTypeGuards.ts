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
 * Every `StudioChartType` literal, derived-checked against `StudioChartConfigByType`'s
 * keys (via `satisfies`) so this list cannot drift from the union — adding a chart
 * type without a `StudioChartConfigByType` entry is already a compile error there,
 * and dropping one here fails this `satisfies`.
 */
export const STUDIO_CHART_TYPES: readonly StudioChartType[] = [
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
] satisfies readonly (keyof StudioChartConfigByType)[];

/** Runtime membership test for the closed `StudioChartType` union. */
export function isStudioChartType(value: string): value is StudioChartType {
  return (STUDIO_CHART_TYPES as readonly string[]).includes(value);
}
