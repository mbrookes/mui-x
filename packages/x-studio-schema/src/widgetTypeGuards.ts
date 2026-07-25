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
import type { BuiltinStudioWidgetKind, StudioChartType, StudioFilterOperator } from './baseTypes';
import type { StudioExpressionOperator } from './expressionTypes';
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

// ── Filter-operator helpers ─────────────────────────────────────────────────────
//
// `StudioFilterOperator` (`baseTypes.ts`) is a closed 17-member union that BOTH
// trust boundaries branch on — the wire boundary (`parseStateMutation`'s
// `validateFilter`) and the AI-tool boundary (`executeToolOnState.ts`). Before this
// list existed the schema exported only the operator TYPE, forcing the middleware to
// hand-copy its own `VALID_FILTER_OPERATORS` record (locked with
// `satisfies Record<StudioFilterOperator, true>`) as its "authoritative source of
// truth". That per-package hand-copy is exactly the drift this package exists to
// eliminate: the two boundaries could silently disagree on the identical payload. The
// runtime list below is the single shared source both boundaries membership-check
// against — mirrors the `STUDIO_CHART_TYPES` / `isStudioChartType` pattern above.

/**
 * Every `StudioFilterOperator` literal. The `as const` preserves the literal element
 * types so `(typeof STUDIO_FILTER_OPERATORS)[number]` is the exact union of listed
 * operators; the `satisfies readonly StudioFilterOperator[]` clause checks each element
 * is a VALID operator (no stray entry). Element-validity alone does NOT enforce
 * COMPLETENESS — a list missing `'between'` still satisfies it — so the
 * `AssertAllFilterOperatorsListed` error-tuple lock below (the same pattern as
 * `AssertAllChartTypesListed`) fails the build if any `StudioFilterOperator` literal is
 * absent from this list.
 */
export const STUDIO_FILTER_OPERATORS = [
  'equals',
  'not_equals',
  'in',
  'not_in',
  'contains',
  'does_not_contain',
  'starts_with',
  'not_starts_with',
  'ends_with',
  'not_ends_with',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'greater_than_or_equal',
  'less_than_or_equal',
  'between',
] as const satisfies readonly StudioFilterOperator[];

/**
 * Fail-closed compile-time assertion that EVERY `StudioFilterOperator` literal appears
 * in `STUDIO_FILTER_OPERATORS`. Resolves to `true` when the list is complete; otherwise
 * to a descriptive error tuple naming the missing operators, which makes the
 * `ALL_FILTER_OPERATORS_LISTED` binding below fail to compile. This is what actually
 * fail-closes the list — `isStudioFilterOperator` gates the `addFilter` wire boundary
 * (and the AI-tool boundary consuming this list), so a new operator missing here would
 * be silently rejected everywhere.
 */
type AssertAllFilterOperatorsListed =
  Exclude<StudioFilterOperator, (typeof STUDIO_FILTER_OPERATORS)[number]> extends never
    ? true
    : [
        'STUDIO_FILTER_OPERATORS is missing:',
        Exclude<StudioFilterOperator, (typeof STUDIO_FILTER_OPERATORS)[number]>,
      ];
const ALL_FILTER_OPERATORS_LISTED: AssertAllFilterOperatorsListed = true;
void ALL_FILTER_OPERATORS_LISTED;

/** Runtime membership test for the closed `StudioFilterOperator` union. */
export function isStudioFilterOperator(value: unknown): value is StudioFilterOperator {
  return (
    typeof value === 'string' && (STUDIO_FILTER_OPERATORS as readonly string[]).includes(value)
  );
}

// ── Expression-operator helpers ─────────────────────────────────────────────────
//
// `StudioExpressionOperator` (`expressionTypes.ts`) is the third closed union this package
// membership-checks at a trust boundary, and it is the one that had no runtime counterpart:
// the persistence load boundary (`statePersistence.ts`'s `isExpressionFieldSafe`) validated
// only that a persisted `expressionFields[i].expression` was a RECORD, so an unknown
// operator loaded successfully and every walker in `@mui/x-studio`'s `expressionEvaluator`
// then fell through to its `default:` case and evaluated the whole computed column to
// `null` — a silent wrong-numbers result with no error, the same fail-open class the sibling
// `relationships[i].type` membership check exists to prevent. The list below is the shared
// runtime source that boundary checks against, mirroring the `STUDIO_CHART_TYPES` /
// `STUDIO_FILTER_OPERATORS` pattern above.

/**
 * Every `StudioExpressionOperator` literal. The `as const` preserves the literal element
 * types so `(typeof STUDIO_EXPRESSION_OPERATORS)[number]` is the exact union of listed
 * operators; the `satisfies readonly StudioExpressionOperator[]` clause checks each element
 * is a VALID operator (no stray entry). Element-validity alone does NOT enforce
 * COMPLETENESS — a list missing `'datediff'` still satisfies it — so the
 * `AssertAllExpressionOperatorsListed` error-tuple lock below (the same pattern as
 * `AssertAllChartTypesListed` / `AssertAllFilterOperatorsListed`) fails the build if any
 * `StudioExpressionOperator` literal is absent from this list.
 */
export const STUDIO_EXPRESSION_OPERATORS = [
  // Arithmetic
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  // Comparison
  'equals',
  'notEqual',
  'lessThan',
  'greaterThan',
  'lessThanOrEqual',
  'greaterThanOrEqual',
  // Logical
  'and',
  'or',
  'not',
  'negate',
  // Conditional / membership
  'if',
  'in',
  // Null / truthiness predicates
  'isTrue',
  'isFalse',
  'isNull',
  'isNotNull',
  // Date
  'datediff',
] as const satisfies readonly StudioExpressionOperator[];

/**
 * Fail-closed compile-time assertion that EVERY `StudioExpressionOperator` literal appears
 * in `STUDIO_EXPRESSION_OPERATORS`. Resolves to `true` when the list is complete; otherwise
 * to a descriptive error tuple naming the missing operators, which makes the
 * `ALL_EXPRESSION_OPERATORS_LISTED` binding below fail to compile. This is what actually
 * fail-closes the list — `isStudioExpressionOperator` gates the persisted-doc load boundary,
 * so a new operator missing here would make every expression field using it silently
 * disappear from loaded dashboards.
 */
type AssertAllExpressionOperatorsListed =
  Exclude<StudioExpressionOperator, (typeof STUDIO_EXPRESSION_OPERATORS)[number]> extends never
    ? true
    : [
        'STUDIO_EXPRESSION_OPERATORS is missing:',
        Exclude<StudioExpressionOperator, (typeof STUDIO_EXPRESSION_OPERATORS)[number]>,
      ];
const ALL_EXPRESSION_OPERATORS_LISTED: AssertAllExpressionOperatorsListed = true;
void ALL_EXPRESSION_OPERATORS_LISTED;

/** Runtime membership test for the closed `StudioExpressionOperator` union. */
export function isStudioExpressionOperator(value: unknown): value is StudioExpressionOperator {
  return (
    typeof value === 'string' && (STUDIO_EXPRESSION_OPERATORS as readonly string[]).includes(value)
  );
}
