import dayjs from 'dayjs';
import type { RelativeDateValue } from '../../internals/filterTypes';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterOperator,
  StudioFilterState,
} from '../../models';
import {
  DEFAULT_STUDIO_LOCALE_TEXT,
  type StudioLocaleText,
} from '../../internals/StudioUIConfigContext';
import { buildFieldCatalog } from '../../internals/fieldCatalog';
import { hasBetweenBound, isConditionComplete } from '../../internals/filterUtils';
import type { FieldOption, FieldType, FilterMode } from './filterDrawerTypes';
import { getOperatorLabel, getOperatorsForFieldType } from './filterOperatorMetadata';

// ─── Mutation rejections ──────────────────────────────────────────────────────

/**
 * Resolves the user-facing message for a rejected `addFilter`/`updateFilter`.
 *
 * `StudioController.addFilter`/`updateFilter` return a `StudioMutationResult` rather than
 * `void`, so a refusal is no longer indistinguishable from a save. Every filter-authoring
 * surface routes its rejection text through this one function so the drawer rows, the drawer's
 * add buttons and the widget edit dialog's filters panel cannot drift apart.
 *
 * `rank-conflict` — a second Top-N filter on a page that already has one — is the reachable
 * rejection here and gets its own message: `saveRejectedMessage` tells the user to close a
 * dialog, which is wrong advice in a drawer. It falls back to `saveRejectedMessage` until the
 * translation bundles carry `filterRankConflictMessage`.
 */
export function filterMutationRejectionMessage(
  reason: 'duplicate-id' | 'not-found' | 'cycle' | 'rank-conflict' | 'invalid',
  localeText: Partial<StudioLocaleText>,
): string {
  const generic = localeText.saveRejectedMessage ?? DEFAULT_STUDIO_LOCALE_TEXT.saveRejectedMessage;
  if (reason === 'rank-conflict') {
    return localeText.filterRankConflictMessage ?? generic;
  }
  return generic;
}

// ─── Operators ────────────────────────────────────────────────────────────────
// Operator metadata (which operators are valid per field type, and their labels)
// now lives in `filterOperatorMetadata.ts`, shared with
// `StudioWidgetEditDialog/FilterRow.tsx` — see that module for why.
//
// `getOperators` resolves each option's display label through `getOperatorLabel`
// (passing `localeText` through) so the drawer's operator picker matches the
// widget-edit-dialog's `FilterRow.tsx` localization behavior exactly — see
// `filterOperatorMetadata.ts` for the full rationale. When `localeText` is
// omitted, labels fall back to the hardcoded English strings.

export function getOperators(
  fieldType: FieldType | undefined,
  localeText?: Partial<StudioLocaleText>,
): { value: StudioFilterOperator; label: string }[] {
  return getOperatorsForFieldType(fieldType).map((option) => ({
    value: option.value,
    label: getOperatorLabel(option.value, localeText, fieldType),
  }));
}

// ─── Field options ────────────────────────────────────────────────────────────

/**
 * Build a flat list of field options across all sources, annotated with source and type info.
 *
 * Thin adapter over the shared `buildFieldCatalog` (see `internals/fieldCatalog.ts`) — no
 * expression fields, default (skip-hidden) visibility, same `FieldOption` shape as before.
 */
export function buildFieldOptions(dataSources: Record<string, StudioDataSource>): FieldOption[] {
  return buildFieldCatalog(dataSources, [], { expression: 'none', sort: false }).map((entry) => ({
    id: entry.id,
    label: entry.label,
    fieldType: entry.type,
    sourceId: entry.sourceId,
    sourceLabel: entry.sourceLabel,
  }));
}

// ─── Field resolution ─────────────────────────────────────────────────────────

/**
 * Whether a filter's stored `field` still names a real column.
 *
 * - `'resolved'` — the field exists on the filter's source (or, when the filter carries no
 *   source, on some loaded source), or it is a declared expression field.
 * - `'unresolved'` — the catalogs are loaded and none of them has this field. The filter is
 *   dead: every row reads `undefined` for it, so the widget silently matches zero rows.
 * - `'unknown'` — the answer cannot be trusted yet and must never be reported as a problem:
 *   the filter has no field at all (the row is still showing its field picker), no data
 *   source has been injected, or the source the filter names has not loaded yet.
 *
 * Resolution deliberately runs against the RAW catalogs rather than a drawer/dialog option
 * list: `buildFieldOptions` drops hidden fields and expression fields, so a filter that is
 * legitimately configured on one of those would otherwise be reported as broken.
 */
export type FilterFieldResolution = 'resolved' | 'unresolved' | 'unknown';

export function resolveFilterField(
  filter: Pick<StudioFilterState, 'field' | 'filterSourceId'>,
  dataSources: Record<string, StudioDataSource>,
  expressionFields: StudioExpressionField[] = [],
  fallbackSourceId?: string,
): FilterFieldResolution {
  const fieldId = filter.field;
  if (!fieldId) {
    return 'unknown';
  }
  if (expressionFields.some((expressionField) => expressionField.id === fieldId)) {
    return 'resolved';
  }
  const sources = Object.values(dataSources);
  if (sources.length === 0) {
    return 'unknown';
  }
  const scopedSourceId = filter.filterSourceId ?? fallbackSourceId;
  if (scopedSourceId) {
    // `filterSourceId`/`sourceId` are doc-authored: guard the record index against inherited
    // prototype keys so a bare lookup can't resolve a function off `Object.prototype`.
    if (!Object.hasOwn(dataSources, scopedSourceId)) {
      return 'unknown';
    }
    return dataSources[scopedSourceId].fields.some((field) => field.id === fieldId)
      ? 'resolved'
      : 'unresolved';
  }
  return sources.some((source) => source.fields.some((field) => field.id === fieldId))
    ? 'resolved'
    : 'unresolved';
}

// ─── Relative date helpers ────────────────────────────────────────────────────

const RELATIVE_DATE_UNITS: ReadonlySet<string> = new Set<RelativeDateValue['unit']>([
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'year',
]);

/**
 * True only for a COMPLETE, scalar `RelativeDateValue` (`{ relative: true, amount, unit,
 * direction }`).
 *
 * The predicate used to check `.relative === true` and nothing else, so a `between` value
 * built on top of a relative date — `{ relative: true, amount: 3, unit: 'month', direction:
 * 'past', from: '2024-01-01' }`, which `FilterValueInput`'s between editor could produce by
 * spreading the previous relative value as its `{ from, to }` base — answered `true`. Every
 * `between` ↔ scalar reset guard is written as `… && !isRelativeDateValue(value)`, so that one
 * object permanently disarmed all of them: the user's typed range could never be reset or
 * repaired, and the widget-edit dialog rendered it read-only. Rejecting anything carrying
 * `from`/`to` bounds — and requiring the three scalar fields to actually be present and valid —
 * keeps the two shapes disjoint, which is what every caller assumes.
 *
 * NOTE: `internals/filterUtils.ts` carries its own, deliberately loose copy for the evaluation
 * path (where `.relative === true` is enough to pick the relative-date branch). This one is the
 * authoring-UI predicate: it decides whether a value is SAFE TO KEEP across a shape change, so
 * it must be the strict of the two.
 */
export function isRelativeDateValue(value: unknown): value is RelativeDateValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.relative !== true) {
    return false;
  }
  if ('from' in candidate || 'to' in candidate) {
    return false;
  }
  return (
    typeof candidate.amount === 'number' &&
    typeof candidate.unit === 'string' &&
    RELATIVE_DATE_UNITS.has(candidate.unit) &&
    (candidate.direction === 'past' || candidate.direction === 'next')
  );
}

/**
 * True when `value` carries the `{ from, to }` shape the `between` operator edits, rather than
 * the scalar shape every other operator edits. A `RelativeDateValue` is a non-array object too,
 * but a fully-supported _scalar_, so it is excluded.
 */
export function isBetweenShapedValue(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isRelativeDateValue(value)
  );
}

/**
 * True when switching from `previousOperator` to `nextOperator` crosses the `between` ↔ scalar
 * value-shape boundary and therefore has to reset the value.
 *
 * The reset used to run in ONE direction only — leaving `between` cleared the stranded
 * `{ from, to }` object, but entering `between` left a scalar in place. `revenue = 500` switched
 * to "Between" rendered two EMPTY bound inputs while `filter.value` was still `500`, so the card
 * read as a half-authored range that the user had in fact never cleared, and the first bound they
 * typed silently replaced it. It fails safe (`isConditionComplete` rejects a scalar `between`, so
 * `applyFilters` drops the filter rather than matching nothing), but the drawer and the doc
 * disagreed — and ARCHITECTURE.md has always claimed the reset runs "in both directions".
 */
export function needsOperatorValueReset(
  previousOperator: StudioFilterOperator,
  nextOperator: StudioFilterOperator,
  value: unknown,
): boolean {
  if (previousOperator === nextOperator) {
    return false;
  }
  if (nextOperator === 'between') {
    // Entering `between`: a scalar cannot be read as a range. An already-empty value needs no
    // reset (nothing to strand), and an existing `{ from, to }` object must be preserved.
    return value !== '' && value !== null && value !== undefined && !isBetweenShapedValue(value);
  }
  // Leaving `between`: a stranded `{ from, to }` object makes `toComparable` yield NaN (silently
  // matching nothing) and the scalar value input render "[object Object]".
  return isBetweenShapedValue(value);
}

export function absoluteToRelative(dateStr: string): RelativeDateValue {
  const date = dayjs(dateStr);
  const now = dayjs();
  if (!date.isValid()) {
    return { relative: true, amount: 1, unit: 'day', direction: 'past' };
  }
  const direction = date.isAfter(now) ? 'next' : 'past';
  const absDays = Math.abs(date.diff(now, 'day'));

  if (absDays >= 365) {
    return {
      relative: true,
      amount: Math.max(1, Math.round(absDays / 365)),
      unit: 'year',
      direction,
    };
  }
  if (absDays >= 28) {
    return {
      relative: true,
      amount: Math.max(1, Math.round(absDays / 30)),
      unit: 'month',
      direction,
    };
  }
  if (absDays >= 7) {
    return {
      relative: true,
      amount: Math.max(1, Math.round(absDays / 7)),
      unit: 'week',
      direction,
    };
  }
  return { relative: true, amount: Math.max(1, absDays), unit: 'day', direction };
}

export function relativeToAbsolute(rel: RelativeDateValue): string {
  const now = dayjs();
  const result =
    rel.direction === 'past' ? now.subtract(rel.amount, rel.unit) : now.add(rel.amount, rel.unit);
  return result.format('YYYY-MM-DD');
}

// ─── Filter effectiveness check ───────────────────────────────────────────────

/**
 * Returns true when a filter has a meaningful value configured AND is actually applied.
 * Used to decide whether a FilterCard should start expanded (freshly added,
 * no value yet) or collapsed (pre-configured, loaded from preset or state), and to gate
 * which filters can act as cascading parents for another filter's option narrowing
 * (`PageFilterRow`'s `parentFilters`/`useFieldValues`'s `applyParentFilters`).
 *
 * A `disabled: true` filter (toggled off in the drawer, not deleted) is never effective,
 * regardless of its stored value — mirrors every other data path's `!f.disabled` guard
 * (`selectFiltersForWidget`, `useWidgetRows`, `selectors.ts`, etc.).
 * Without this, a disabled parent filter still narrowed a cascading child's option list as
 * if it were active, since it still had a "meaningful" stored value.
 */
export function isFilterEffective(filter: StudioFilterState): boolean {
  if (filter.disabled) {
    return false;
  }
  const mode = filter.filterMode ?? 'condition';
  if (mode === 'selection') {
    return Array.isArray(filter.value) && (filter.value as unknown[]).length > 0;
  }
  if (mode === 'rank') {
    return typeof filter.value === 'number' && filter.value > 0;
  }
  return filter.value !== '' && filter.value !== null && filter.value !== undefined;
}

/**
 * Returns true when a filter is in its fresh default state (just added, not yet configured).
 * Rank filters default to "Top 10" — we consider them fresh until the user changes
 * the value/direction/byField, so the card starts expanded for immediate configuration.
 */
export function isFilterFresh(filter: StudioFilterState): boolean {
  if (filter.filterMode === 'rank') {
    return (
      filter.value === 10 &&
      (filter.rankDirection === 'top' || filter.rankDirection === undefined) &&
      !filter.rankByField &&
      !filter.rankMultiSeriesBy
    );
  }
  return false;
}

// ─── Filter summary ───────────────────────────────────────────────────────────

/** Locale keys for the singular form of each relative-date unit — shared with
 * `internals/widgetUtils.tsx`'s `formatDateFilterLabel` (same underlying tokens,
 * already translated in every locale bundle). */
const RELATIVE_UNIT_SINGULAR_KEYS: Record<RelativeDateValue['unit'], keyof StudioLocaleText> = {
  year: 'dateFilterUnitYear',
  month: 'dateFilterUnitMonth',
  week: 'dateFilterUnitWeek',
  day: 'dateFilterUnitDay',
  hour: 'dateFilterUnitHour',
  minute: 'dateFilterUnitMinute',
  second: 'dateFilterUnitSecond',
};

const RELATIVE_UNIT_PLURAL_KEYS: Record<RelativeDateValue['unit'], keyof StudioLocaleText> = {
  year: 'dateFilterUnitYears',
  month: 'dateFilterUnitMonths',
  week: 'dateFilterUnitWeeks',
  day: 'dateFilterUnitDays',
  hour: 'dateFilterUnitHours',
  minute: 'dateFilterUnitMinutes',
  second: 'dateFilterUnitSeconds',
};

function formatFilterValue(
  value: unknown,
  _fieldType: FieldType | undefined,
  localeText: Partial<StudioLocaleText> = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
  if (isRelativeDateValue(value)) {
    const { amount, unit, direction } = value;
    const singular = localeText[RELATIVE_UNIT_SINGULAR_KEYS[unit]] as string | undefined;
    const plural = localeText[RELATIVE_UNIT_PLURAL_KEYS[unit]] as string | undefined;
    const unitLabel = (amount === 1 ? singular : plural) ?? (amount === 1 ? unit : `${unit}s`);
    const suffix =
      direction === 'past'
        ? (localeText.filterRelativeDateAgo ?? 'ago')
        : (localeText.filterRelativeDateFromNow ?? 'from now');
    return `${amount} ${unitLabel} ${suffix}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value ?? '');
}

/**
 * Returns a compact, human-readable one-line description of a filter's current
 * condition/selection/rank configuration, e.g. "Equals: foo", "is one of: A, B",
 * or "Top 10 · revenue". Consumed by `StudioQuickFilterBar.tsx`'s chips,
 * `PageFilterRow.tsx`/`WidgetFilterRow.tsx`'s collapsed-card summaries, and
 * `StudioKpiWidget.tsx`'s tooltip subtitle.
 *
 * `localeText` is optional (defaulting to the English `DEFAULT_STUDIO_LOCALE_TEXT`)
 * so existing callers that don't have access to the active locale keep working
 * unchanged — pass it through whenever it's available so the summary renders in
 * the active locale rather than always in English.
 */
export function summarizeFilter(
  filter: StudioFilterState,
  localeText: Partial<StudioLocaleText> = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
  const mode = filter.filterMode ?? 'condition';

  if (mode === 'selection') {
    const selected = Array.isArray(filter.value) ? (filter.value as string[]) : [];
    if (selected.length === 0) {
      return localeText.filterSummaryAnyValue ?? 'any value';
    }
    const isExclude = filter.operator === 'not_in';
    const MAX_SHOWN = 3;
    const MAX_LEN = 20;
    const truncate = (v: string) => (v.length > MAX_LEN ? `${v.slice(0, MAX_LEN)}…` : v);
    const shown = selected.slice(0, MAX_SHOWN).map(truncate).join(', ');
    const rest = selected.length - MAX_SHOWN;
    const prefix = isExclude
      ? (localeText.filterSummaryIsNot ?? 'is not:')
      : (localeText.filterSummaryIsOneOf ?? 'is one of:');
    if (rest <= 0) {
      return `${prefix} ${shown}`;
    }
    const andMore = localeText.filterSummaryAndMore
      ? localeText.filterSummaryAndMore(rest)
      : `and ${rest} more`;
    return `${prefix} ${shown} ${andMore}`;
  }

  if (mode === 'rank') {
    const dir =
      filter.rankDirection === 'bottom'
        ? (localeText.filterRankBottom ?? 'Bottom')
        : (localeText.filterRankTop ?? 'Top');
    // Explicit emptiness check, not truthiness: `value: 0` is a real (if degenerate) N and must
    // render "Top 0", not "Top ?" — the last remaining truthiness-on-a-filter-value site, and the
    // same class of bug `hasBetweenBound` and `SliderControl`'s `?? min` already fixed elsewhere.
    const n =
      filter.value === undefined || filter.value === null || filter.value === ''
        ? '?'
        : String(filter.value);
    const field = filter.field ? ` · ${filter.field}` : '';
    return `${dir} ${n}${field}`;
  }

  function summarizeCondition(op: StudioFilterOperator, value: unknown): string {
    const opLabel = getOperatorLabel(op, localeText, filter.fieldType);
    // `is_empty`/`is_not_empty` take no comparison value, so the operator's own
    // (already-localized, per-field-type) label is the full summary — route
    // through the same `filterOperator_${fieldType}_${operator}` locale keys used
    // by the operator picker instead of a hardcoded English fallback string.
    if (op === 'is_empty' || op === 'is_not_empty') {
      return opLabel;
    }
    if (op === 'between') {
      const range = value as { from?: unknown; to?: unknown } | null;
      const from = hasBetweenBound(range?.from)
        ? formatFilterValue(range?.from, filter.fieldType, localeText)
        : '';
      const to = hasBetweenBound(range?.to)
        ? formatFilterValue(range?.to, filter.fieldType, localeText)
        : '';
      if (from && to) {
        return `${opLabel}: ${from} — ${to}`;
      }
      if (from) {
        return localeText.filterSummaryFrom ? localeText.filterSummaryFrom(from) : `from ${from}`;
      }
      if (to) {
        return localeText.filterSummaryUntil ? localeText.filterSummaryUntil(to) : `until ${to}`;
      }
      return opLabel;
    }
    const valStr = formatFilterValue(value, filter.fieldType, localeText);
    if (!valStr) {
      return opLabel;
    }
    return `${opLabel}: ${valStr}`;
  }

  const primary = summarizeCondition(filter.operator, filter.value);
  // `isConditionComplete` mirrors `compileRowTest`'s own gate on the second condition
  // (`filterUtils.ts`: `if (!operator2 || !isConditionComplete(operator2, value2)) return
  // primary`). Without it the summary announced a condition the engine ignores: clicking
  // "Add condition" seeds `{ operator2: 'equals', value2: '' }`, so every collapsed card — and
  // every quick-filter chip and KPI tooltip built on this summary — immediately read
  // "Equals: north AND Equals" for a filter that was still only doing the first half.
  if (!filter.operator2 || !isConditionComplete(filter.operator2, filter.value2)) {
    return primary;
  }
  const conj =
    filter.conjunction === 'or'
      ? (localeText.filterConditionOr ?? 'OR')
      : (localeText.filterConditionAnd ?? 'AND');
  const secondary = summarizeCondition(filter.operator2, filter.value2);
  return `${primary} ${conj} ${secondary}`;
}

// ─── Default values per mode ──────────────────────────────────────────────────

/** Returns the appropriate default filter value when switching modes pre-field-selection. */
export function defaultValueForMode(mode: FilterMode): StudioFilterState['value'] {
  if (mode === 'rank') {
    return 10;
  }
  if (mode === 'selection') {
    return [];
  }
  return '';
}

/**
 * Returns the partial state changes needed when a filter's FIELD changes — a phase-1 field pick,
 * or an `UnresolvedFieldAlert` repoint that drops the row back to its picker. Merge it into the
 * `field`/`fieldType`/`filterSourceId` delta the caller is already committing.
 *
 * A field switch must clear ALL FIVE condition keys together — `operator`, `value`,
 * `operator2`, `value2`, `conjunction`. The drawer rows used to rewrite only `value`/`operator`
 * (phase-1) or nothing at all (repoint), so a second condition authored against the OLD field
 * survived the switch. A string filter reading `contains "north" AND ends_with "ia"` repointed
 * onto numeric `revenue` kept `value2: "ia"`; the operator self-repair then rewrote `contains` →
 * `equals` non-undoably, and the widget silently ANDed `revenue ends_with "ia"`, matching nothing
 * — an empty widget with no second-condition UI on screen to explain or remove it.
 * `StudioWidgetEditDialog/FilterRow` has cleared all five all along; this is the same
 * reset, shared so the two surfaces cannot drift again.
 */
export function buildFieldRepointReset(mode: FilterMode = 'condition'): Partial<StudioFilterState> {
  return {
    operator: 'equals',
    value: defaultValueForMode(mode),
    operator2: undefined,
    value2: undefined,
    conjunction: undefined,
  };
}

/**
 * Returns the partial state changes needed when switching a filter's mode.
 * Clears all mode-specific fields and sets the appropriate default value.
 *
 * `currentFieldType` is the resolved type of the filter's current field (when it has one).
 * 2.19: rank mode sorts rows by the NUMERIC value of `field`, so switching an existing filter
 * that's configured on a non-numeric field into rank mode would compute `NaN` comparators (a
 * silent no-op "Top N"). When switching to rank and the current field isn't numeric, clear the
 * `field`/`fieldType`/`filterSourceId` so the row drops back to its numeric-only field picker.
 * (Chart rank filters re-wire their `xField` back in the row's own change handler.)
 */
export function buildModeReset(
  newMode: FilterMode,
  currentFieldType?: FieldType,
): Partial<StudioFilterState> {
  const reset: Partial<StudioFilterState> = {
    filterMode: newMode,
    value: defaultValueForMode(newMode),
    rankDirection: newMode === 'rank' ? 'top' : undefined,
    rankByField: undefined,
    rankMultiSeriesBy: undefined,
    operator2: undefined,
    value2: undefined,
    conjunction: undefined,
  };
  if (newMode === 'rank' && currentFieldType !== 'number') {
    reset.field = undefined;
    reset.fieldType = undefined;
    reset.filterSourceId = undefined;
  }
  return reset;
}
