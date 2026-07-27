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
import type {
  BuiltinStudioWidgetKind,
  StudioChartType,
  StudioFilterOperator,
  StudioWidgetKind,
} from './baseTypes';
import type { StudioExpressionOperator } from './expressionTypes';
import type { StudioRelationship } from './dataTypes';
import type { OptionalWidgetField } from './mutationTypes';
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

// ── Relationship-type helpers ───────────────────────────────────────────────────
//
// The fourth closed union this package membership-checks at a trust boundary, and the one
// that had a runtime list with NO compile lock: `statePersistence.ts` carried a bare
// `new Set(['many-to-one', 'one-to-one', 'many-to-many'])` with no `satisfies` and no
// completeness assertion, unlike its three siblings above. A FOURTH relationship type added
// to `StudioRelationship['type']` would compile cleanly and make `isRelationshipSafe`
// silently DROP every persisted relationship using it at load — the same fail-open class the
// siblings' `AssertAll…Listed` locks exist to prevent.

/**
 * Every `StudioRelationship['type']` literal. Locked for completeness by
 * {@link AssertAllRelationshipTypesListed} below, exactly like the three lists above.
 */
export const STUDIO_RELATIONSHIP_TYPES = [
  'many-to-one',
  'one-to-one',
  'many-to-many',
] as const satisfies readonly StudioRelationship['type'][];

/**
 * Fail-closed compile-time assertion that EVERY `StudioRelationship['type']` literal appears
 * in `STUDIO_RELATIONSHIP_TYPES`, so a new relationship type cannot be added without the
 * runtime list following. See the block comment above for the failure it closes.
 */
type AssertAllRelationshipTypesListed =
  Exclude<StudioRelationship['type'], (typeof STUDIO_RELATIONSHIP_TYPES)[number]> extends never
    ? true
    : [
        'STUDIO_RELATIONSHIP_TYPES is missing:',
        Exclude<StudioRelationship['type'], (typeof STUDIO_RELATIONSHIP_TYPES)[number]>,
      ];
const ALL_RELATIONSHIP_TYPES_LISTED: AssertAllRelationshipTypesListed = true;
void ALL_RELATIONSHIP_TYPES_LISTED;

/**
 * Runtime membership test for the closed `StudioRelationship['type']` union. Backed by a
 * `Set` so an untrusted persisted `type` can never resolve up a prototype chain.
 */
const RELATIONSHIP_TYPE_SET: ReadonlySet<string> = new Set<string>(STUDIO_RELATIONSHIP_TYPES);
export function isStudioRelationshipType(value: unknown): value is StudioRelationship['type'] {
  return typeof value === 'string' && RELATIONSHIP_TYPE_SET.has(value);
}

// ── Widget-field lists ──────────────────────────────────────────────────────────
//
// `StudioWidgetOf`'s field names were independently re-enumerated by hand at five sites —
// the reducer's `MERGEABLE_WIDGET_CHANGE_KEYS` allow-list and `unsetFields` denylist and
// optional-scalar screen, the wire boundary's `updateWidget.changes` per-field checks, and
// the load boundary's optional-scalar screen — in a package that compile-locks every OTHER
// list it publishes. None of the five was locked, so adding a field to `StudioWidgetOf`
// compiled cleanly while `updateWidget` silently no-opped on it forever
// (`MERGEABLE_WIDGET_CHANGE_KEYS.has(key)` is `false`) and neither boundary screened it.
//
// The three partition tuples below are the single source those five sites derive from. Each
// is `satisfies`-checked for VALIDITY (no stray name) and, together, locked for
// COMPLETENESS against `keyof StudioWidgetOf` by `AssertAllWidgetFieldsListed`: a new field
// must be added to exactly one partition or the build fails. The partitions are by VALUE
// SHAPE, because that is what the screening sites actually branch on.

/** Widget fields whose value is a plain `string` (`kind`/`title` required, the rest optional). */
export const WIDGET_STRING_FIELDS = [
  'kind',
  'title',
  'subtitle',
  'sourceId',
] as const satisfies readonly (keyof StudioWidgetOf<StudioWidgetKind>)[];

/** Widget fields whose value is the closed `'auto' | 'manual'` title-mode union. */
export const WIDGET_TITLE_MODE_FIELDS = [
  'titleMode',
  'subtitleMode',
] as const satisfies readonly (keyof StudioWidgetOf<StudioWidgetKind>)[];

/**
 * The widget fields that are neither a string nor a title mode: `id` (also the
 * `state.widgets` map key) and the `config` bag.
 */
export const WIDGET_OTHER_FIELDS = [
  'id',
  'config',
] as const satisfies readonly (keyof StudioWidgetOf<StudioWidgetKind>)[];

/**
 * Every `StudioWidgetOf` field, composed from the three partitions above so no partition
 * can be forgotten while this list stays complete.
 */
export const STUDIO_WIDGET_FIELDS = [
  ...WIDGET_OTHER_FIELDS,
  ...WIDGET_STRING_FIELDS,
  ...WIDGET_TITLE_MODE_FIELDS,
] as const satisfies readonly (keyof StudioWidgetOf<StudioWidgetKind>)[];

/**
 * Fail-closed compile-time assertion that the three partitions together cover EVERY
 * `StudioWidgetOf` field. This is the lock that actually fail-closes the five derived
 * screening sites — see the block comment above.
 */
type AssertAllWidgetFieldsListed =
  Exclude<
    keyof StudioWidgetOf<StudioWidgetKind>,
    (typeof STUDIO_WIDGET_FIELDS)[number]
  > extends never
    ? true
    : [
        'STUDIO_WIDGET_FIELDS is missing:',
        Exclude<keyof StudioWidgetOf<StudioWidgetKind>, (typeof STUDIO_WIDGET_FIELDS)[number]>,
      ];
const ALL_WIDGET_FIELDS_LISTED: AssertAllWidgetFieldsListed = true;
void ALL_WIDGET_FIELDS_LISTED;

/**
 * Every OPTIONAL `StudioWidget` field — the fields `updateWidget.unsetFields` may void, and
 * the fields the write/load boundaries strip (rather than reject) when their value is junk.
 * Locked for completeness against the derived `OptionalWidgetField` type below, so making a
 * field optional (or required) forces this list to follow.
 */
export const OPTIONAL_STUDIO_WIDGET_FIELDS = [
  'titleMode',
  'subtitle',
  'subtitleMode',
  'sourceId',
] as const satisfies readonly OptionalWidgetField[];

type AssertAllOptionalWidgetFieldsListed =
  Exclude<OptionalWidgetField, (typeof OPTIONAL_STUDIO_WIDGET_FIELDS)[number]> extends never
    ? true
    : [
        'OPTIONAL_STUDIO_WIDGET_FIELDS is missing:',
        Exclude<OptionalWidgetField, (typeof OPTIONAL_STUDIO_WIDGET_FIELDS)[number]>,
      ];
const ALL_OPTIONAL_WIDGET_FIELDS_LISTED: AssertAllOptionalWidgetFieldsListed = true;
void ALL_OPTIONAL_WIDGET_FIELDS_LISTED;

const OPTIONAL_WIDGET_FIELD_SET: ReadonlySet<string> = new Set<string>(
  OPTIONAL_STUDIO_WIDGET_FIELDS,
);

/**
 * The REQUIRED `StudioWidgetOf` fields, DERIVED as `STUDIO_WIDGET_FIELDS` minus the optional
 * ones rather than re-listed. The reducer's `unsetFields` denylist is exactly this set: a
 * widget must never be left without one.
 */
export const REQUIRED_STUDIO_WIDGET_FIELDS: readonly string[] = STUDIO_WIDGET_FIELDS.filter(
  (field) => !OPTIONAL_WIDGET_FIELD_SET.has(field),
);

/**
 * The OPTIONAL string-valued widget fields (`WIDGET_STRING_FIELDS` ∩ the optional set) —
 * the fields both the write boundary (`applyMutation`'s `screenOptionalWidgetScalars`) and
 * the load boundary strip when a non-string value arrives, rather than dropping the whole
 * widget. Derived, so it cannot drift from either source list.
 */
export const OPTIONAL_WIDGET_STRING_FIELDS: readonly string[] = WIDGET_STRING_FIELDS.filter(
  (field) => OPTIONAL_WIDGET_FIELD_SET.has(field),
);
