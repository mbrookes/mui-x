/**
 * The one query planner.
 *
 * Takes a `StudioQueryDescriptor` — the question — plus a `StudioQueryCapabilities` declaration —
 * what one executor can answer faithfully — and splits the question into the part that executor may
 * run and the part the caller must run locally against its response.
 *
 * ```text
 *                     ┌──────────────────────────────────────────┐
 *   descriptor  ──────▶  planQueryExecution(descriptor, caps)     │
 *   capabilities ─────▶                                           │
 *                     └───────────────┬──────────────────────────┘
 *                                     │
 *            acceptedLeaves ──────────┴────────── residualLeaves
 *          (this executor runs)                (the local engine runs,
 *                                               against the response)
 * ```
 *
 * ## Why this is not inside the adapter any more
 *
 * It was. `createBatchingAdapter` held the whole judgement — `isOpValueServerTranslatable`,
 * `isLeafServerTranslatable`, `partitionFilterNode`, and the aggregation ladder — as private
 * knowledge about one particular backend. That made three things true, all structural:
 *
 * - A second backend would have re-derived every one of those judgements.
 * - Adding a `StudioFilterOperator` compiled everywhere and fell through to "unmapped" — correct by
 *   accident, and only for the wire.
 * - The in-memory engine, which is an executor too and the most capable one, could not be described
 *   at all. So the two were parallel implementations rather than one contract with two conformers.
 *
 * Splitting is now a pure function of a declared capability set, so every executor gets the same
 * judgement and a new one declares rather than re-derives. **Encoding stays with the executor**:
 * this module decides WHO runs a leaf, never how that leaf is spelled on a wire. `leafToPredicates`
 * is still the batching adapter's own, because a `FilterPredicate` is the wire's encoding and
 * nobody else's.
 *
 * ## Ordering is load-bearing
 *
 * Filters are partitioned FIRST, aggregations decided SECOND, because the first rung of the
 * aggregation ladder depends on the partition's outcome — an unpushable filter must be re-applied
 * against the response, and an aggregated response is one row per group with the predicate's own
 * column absent. The batching adapter once ran its ladder before its partition and so could not see
 * that rung; enshrining the order here is what stops that recurring.
 *
 * The contract these decisions serve is `packages/x-studio/docs/EXECUTION_SEMANTICS.md`, and
 * `EXECUTION_CONFORMANCE_CASES` is the executable form of it.
 */
import type {
  StudioAggregationFn,
  StudioFilterNode,
  StudioFilterState,
  StudioQueryCapabilities,
  StudioQuery,
  StudioQueryDescriptor,
} from '../models';
import { isConditionComplete, isRankCountComplete } from './filterUtils';

export type StudioFilterLeaf = Extract<StudioFilterNode, { type: 'leaf' }>;

export interface StudioQueryPlan {
  /**
   * Leaves the executor may evaluate, in tree-visit order.
   *
   * Order matters to callers that build index-aligned side tables from it (the batching adapter's
   * `predicateSourceIds`), so it is part of the contract rather than an implementation detail.
   */
  acceptedLeaves: StudioFilterLeaf[];
  /** Leaves the CALLER must evaluate locally, against whatever the executor returns. */
  residualLeaves: StudioFilterLeaf[];
  /**
   * True when an OR-combined group was dropped entirely.
   *
   * Dropped rather than routed to the residual because the local re-application path
   * (`applyFilters` over a `StudioFilterState[]`) is itself AND-combined, so there is nowhere to
   * put it. Producers only build `logic: 'and'` groups today, so this is defensive — but a silent
   * drop would be a wrong answer, hence the flag.
   */
  droppedOrGroup: boolean;
  /** The aggregations the executor may compute — `undefined` when they must be stripped. */
  aggregations: StudioQueryDescriptor['aggregations'];
  /** Why aggregations were stripped, phrased for a warning. `undefined` when nothing was. */
  aggregationStripReason?: string;
  /**
   * Divergences to announce for leaves that WERE accepted but are not faithful.
   *
   * Distinct from the residual: a residual leaf produces the right answer somewhere else, so it
   * needs no warning. An entry here means the executor is about to answer differently from the
   * contract and the host should know. There is one today.
   */
  divergences: string[];
}

// ── Value-shape questions the capability set asks about ───────────────────────

/**
 * True when a `{ from, to }` (or `[lo, hi]`) `between` value has BOTH bounds set.
 *
 * Mirrors the in-memory evaluator's truthy-bound semantics (`filterUtils.ts`: `range.from ? … :
 * null`), so an empty string counts as "unset". `!= null && !== ''` rather than a truthiness check,
 * so a genuine `0` bound ("between 0 and 100") counts as SET — a truthiness check treated `0` as
 * unset and kept the whole predicate client-side.
 */
export function isFullyBoundedBetween(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const hasBound = (v: unknown): boolean => v != null && v !== '';
  if (Array.isArray(value)) {
    return value.length === 2 && hasBound(value[0]) && hasBound(value[1]);
  }
  const range = value as { from?: unknown; to?: unknown };
  return hasBound(range.from) && hasBound(range.to);
}

/**
 * A filter value as a REAL boolean, or `null` when no coercion is certain.
 *
 * The filter drawer stores a boolean condition's value as the STRING `'true'`/`'false'`, which the
 * in-memory evaluator compares as `String(row[field]) === value` — correct. Bound to SQL as a
 * string it is not: PostgreSQL implicitly casts it, but MySQL (`tinyint(1)`) and SQLite coerce it
 * NUMERICALLY to `0`, so `col = 'true'` returns exactly the rows where the flag is FALSE — the
 * complement of the question. Anything outside the two recognised spellings has no equally certain
 * coercion, so it goes to the residual rather than shipping a guess.
 */
export function coerceToBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

export function isDateFieldType(fieldType: StudioFilterLeaf['fieldType']): boolean {
  return fieldType === 'date' || fieldType === 'datetime';
}

/**
 * The calendar day of a date value as `YYYY-MM-DD` — the whole of a bare date, or the date part of
 * a full ISO instant. `null` for anything that cannot be reduced to a calendar day here (a numeric
 * epoch, a `Date` instance, a non-ISO string), which is the signal to decline rather than guess.
 *
 * Deliberately looser than a bare-date test: `equals` is day-granular in-memory even for a value
 * that carries a time (`toDayComparable` truncates it), so its day-range rewrite needs the day of
 * an instant too.
 */
export function dayPartOfValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match === null ? null : match[1];
}

// ── The judgement ─────────────────────────────────────────────────────────────

/**
 * Can one (operator, value, fieldType) triple be executed by `caps` with EXACTLY the contract's
 * semantics?
 *
 * Every branch below reads a declared capability. Nothing here knows what a wire predicate looks
 * like, which is the whole point: a second backend changes the declaration, not this function.
 * @param caps The executor's declaration.
 * @param op The operator to judge.
 * @param value Its value, needed because several capabilities are value-shaped rather than
 *   operator-shaped (an empty `in`, a half-bounded `between`, a non-calendar-day date).
 * @param fieldType The leaf's declared field type, which changes the answer for dates and booleans.
 * @returns Whether this executor may run it.
 */
function canExecuteCondition(
  caps: StudioQueryCapabilities,
  op: StudioFilterLeaf['op'],
  value: unknown,
  fieldType: StudioFilterLeaf['fieldType'],
): boolean {
  if (!caps.operators[op]) {
    return false;
  }
  if (op === 'in' && Array.isArray(value) && value.length === 0 && !caps.emptyInMatchesNothing) {
    return false;
  }
  if (op === 'between' && !isFullyBoundedBetween(value) && !caps.openEndedBetween) {
    return false;
  }
  if (fieldType === 'boolean' && caps.booleanValues === 'coerced-spellings') {
    return coerceToBoolean(value) !== null;
  }
  if (isDateFieldType(fieldType)) {
    if (op === 'not_equals' && !caps.dateNotEquals) {
      return false;
    }
    if (op === 'equals' && !caps.dateEqualsOnNonCalendarDayValue) {
      return dayPartOfValue(value) !== null;
    }
  }
  return true;
}

/**
 * Can `caps` execute a whole leaf, both conditions included?
 * @param caps The executor's declaration.
 * @param leaf The leaf to judge.
 * @returns Whether this executor may run it.
 */
/**
 * Is this leaf authored to the point where it constrains anything?
 *
 * An incomplete leaf (the drawer's `{ operator: 'equals', value: '' }` add-filter default, an empty
 * selection, a rank with no N) has no effect under the contract — `applyFilters` drops it via
 * `isFilterComplete`. It therefore goes to the residual for EVERY executor, including one that
 * could technically express it, because the residual re-drops it (self-healing) whereas a real
 * `col = ''` predicate empties a string column and errors a numeric one.
 *
 * Exported because "declined" and "declined for a reason worth reporting" are different questions,
 * and only the caller knows which it is asking. The local executor warns when it declines a leaf —
 * it is the reference implementation, so a genuine decline means the contract describes something
 * nothing implements. An incomplete leaf is not that: it is the expected state of a filter the user
 * is still typing, and warning about it would fire on every keystroke.
 * @param leaf The leaf to judge.
 * @returns Whether it is fully authored.
 */
export function isLeafComplete(leaf: StudioFilterLeaf): boolean {
  if ((leaf.filterMode ?? 'condition') === 'rank') {
    return isRankCountComplete(leaf.value);
  }
  return isConditionComplete(leaf.op, leaf.value);
}

function canExecuteLeaf(caps: StudioQueryCapabilities, leaf: StudioFilterLeaf): boolean {
  if (!isLeafComplete(leaf)) {
    return false;
  }
  // Rank is judged separately, because it is not a row predicate and the condition machinery below
  // asks the wrong questions about it. A rank leaf's `op`/`value` are its N, not a comparison —
  // `isConditionComplete('equals', 5)` happens to be true, so falling through would have judged
  // rank filters by an unrelated rule and then consulted `caps.operators.equals`, which says
  // nothing about whether the executor can reduce a result set.
  if ((leaf.filterMode ?? 'condition') === 'rank') {
    return caps.rankFilters;
  }
  if (!canExecuteCondition(caps, leaf.op, leaf.value, leaf.fieldType)) {
    return false;
  }
  // Presence, not `value2 !== undefined`. A valueless second operator (`is_empty`/`is_not_empty`)
  // IS a real second condition with no value at all; a bare-undefined check reported it as absent,
  // declared the leaf executable on its FIRST condition alone, and silently dropped the second.
  const hasSecondCondition = leaf.op2 !== undefined && isConditionComplete(leaf.op2, leaf.value2);
  if (!hasSecondCondition) {
    return true;
  }
  if (leaf.conjunction === 'or' && !caps.intraLeafOr) {
    return false;
  }
  return canExecuteCondition(caps, leaf.op2!, leaf.value2, leaf.fieldType);
}

/**
 * Divergences for a leaf this executor WILL run but cannot answer faithfully.
 *
 * Exactly one exists. `not_equals` on a non-date field is declared executable by the wire even
 * though SQL three-valued logic drops NULL rows the contract keeps, because routing it locally
 * would defeat the pushdown and, for an aggregated widget, drop the filter entirely. Announced
 * rather than hidden — that is the whole "degrades visibly, never silently wrong" bargain.
 *
 * Keyed off the capability declaration rather than off the wire, so an executor that CAN express a
 * faithful `not_equals` (one with `intraLeafOr`, which could send `<> v OR IS NULL`) is not warned
 * about.
 * @param caps The executor's declaration.
 * @param leaf The accepted leaf.
 * @param sourceId The descriptor's source, for the message.
 * @returns Zero or one warning strings.
 */
function divergencesForAcceptedLeaf(
  caps: StudioQueryCapabilities,
  leaf: StudioFilterLeaf,
  sourceId: string,
): string[] {
  const isNotEquals = leaf.op === 'not_equals' || leaf.op2 === 'not_equals';
  if (!isNotEquals || isDateFieldType(leaf.fieldType) || caps.intraLeafOr) {
    return [];
  }
  return [
    `A "not_equals" filter on "${leaf.field}" for source "${sourceId}" is executed by ${caps.name}, ` +
      `where SQL three-valued logic excludes rows whose value is NULL. In-memory sources keep ` +
      `those NULL rows, so the adapter may return fewer rows. Add an explicit "is empty" ` +
      `condition if NULL rows should be included.`,
  ];
}

/**
 * True when this executor would aggregate at a FINER grain than the descriptor asked for.
 *
 * Only reachable when the executor declared `aggregatesAtRequestedGrain: false`, which means it
 * derives its GROUP BY from the projection. Then any projected non-measure column outside
 * `groupBy`, or any `xGroupBy` time bucketing the request cannot transmit, splits one intended
 * group into several.
 * @param d The descriptor.
 * @returns Whether the grains differ.
 */
function grainIsFinerThanRequested(d: StudioQuery): boolean {
  if (d.xGroupBy) {
    return true;
  }
  const measureAliases = new Set((d.aggregations ?? []).map((a) => a.alias));
  const measureFields = new Set((d.aggregations ?? []).map((a) => a.field));
  return (d.select ?? []).some(
    (column) => column !== d.groupBy && !measureAliases.has(column) && !measureFields.has(column),
  );
}

/**
 * Decide whether this executor may compute the descriptor's aggregations.
 *
 * The rungs divide into two kinds, and the distinction matters when reading them:
 *
 * - **Response-shape rungs (1–3)** apply to ANY executor that aggregates, because they are about
 *   what an aggregated response can no longer carry: one row per group, with only the grouped and
 *   alias columns. A residual predicate, an incoming cross-filter, or a rank reduction all need
 *   raw rows, and none of them could run against that.
 * - **Capability rungs (4–5)** read the declaration.
 * Exported because `hasResidual` is not always "the plan's residual is non-empty". An executor may
 * refine it: the batching adapter counts only residual leaves whose column it can actually PROJECT
 * back, since a leaf it would drop either way is no reason to give up the push-down. That
 * refinement is executor-specific, so the flag is a parameter rather than something this module
 * infers — but the ladder it feeds stays here, in one implementation.
 * @param d The descriptor.
 * @param caps The executor's declaration.
 * @param hasResidual Whether the filter partition left anything the caller will re-apply.
 * @returns The reason to strip, or `undefined` to push the aggregations down.
 */
export function aggregationStripReason(
  d: StudioQuery,
  caps: StudioQueryCapabilities,
  hasResidual: boolean,
): string | undefined {
  if (!d.aggregations || d.aggregations.length === 0) {
    return undefined;
  }
  if (caps.aggregationPushdown === 'none') {
    return (
      `${caps.name} returns rows rather than aggregates, so the caller computes the aggregation ` +
      `over what it returns`
    );
  }
  if (hasResidual) {
    return (
      `one or more filters have no faithful form in ${caps.name} and are re-applied locally over ` +
      `the returned rows. An aggregated response contains only the grouped/alias columns, so those ` +
      `filters could not be re-applied at all and the widget would aggregate over EVERY row`
    );
  }
  if (d.hasIncomingCrossOrInteractiveFilters) {
    return (
      `the widget has an incoming cross-filter or interactive filter-widget selection, which is ` +
      `enforced locally over the returned rows. An aggregated response contains only the ` +
      `grouped/alias columns, so the cross-filter's field would read undefined on every row and ` +
      `empty the widget`
    );
  }
  if (d.hasRankFilters) {
    return (
      `the widget has an active rank (top/bottom-N) filter, whose reduction must sum the rank ` +
      `measure per group over raw rows. An aggregated response would group the rank measure into a ` +
      `dimension and collapse rows, so the rank would select the wrong Top-N`
    );
  }
  const pushdown = caps.aggregationPushdown;
  const unsupported = d.aggregations.find((a) => !pushdown[a.fn as StudioAggregationFn]);
  if (unsupported) {
    return (
      `the "${unsupported.fn}" aggregation has no faithful form in ${caps.name} (its SQL count ` +
      `skips rows with a NULL measure, and there is no DISTINCT form at all), so it is computed ` +
      `locally to stay consistent with in-memory sources`
    );
  }
  if (
    d.aggregations.some((a) => a.fn === 'avg') &&
    !caps.aggregatesAtRequestedGrain &&
    grainIsFinerThanRequested(d)
  ) {
    return (
      `an "avg" aggregation would be computed at a finer grain than the widget re-aggregates at ` +
      `(${caps.name} groups by every projected non-measure column and cannot transmit time ` +
      `bucketing), so it would be re-bucketed into an incorrect unweighted average of averages`
    );
  }
  return undefined;
}

/**
 * Split a descriptor between one executor and the local engine.
 * @param descriptor The question.
 * @param capabilities What the executor can answer faithfully.
 * @returns Which leaves that executor runs, which the caller must run, and what to announce.
 */
export function planQueryExecution(
  descriptor: StudioQuery,
  capabilities: StudioQueryCapabilities,
): StudioQueryPlan {
  const acceptedLeaves: StudioFilterLeaf[] = [];
  const residualLeaves: StudioFilterLeaf[] = [];
  const divergences: string[] = [];
  let droppedOrGroup = false;

  const visit = (node: StudioFilterNode): void => {
    if (node.type === 'group') {
      if (node.logic === 'or' && !capabilities.orGroups) {
        droppedOrGroup = true;
        return;
      }
      // AND distributes, so each child is judged independently.
      node.children.forEach(visit);
      return;
    }
    if (canExecuteLeaf(capabilities, node)) {
      acceptedLeaves.push(node);
      divergences.push(
        ...divergencesForAcceptedLeaf(capabilities, node, descriptor.sourceId ?? ''),
      );
    } else {
      residualLeaves.push(node);
    }
  };
  if (descriptor.filter) {
    visit(descriptor.filter);
  }

  const stripReason = aggregationStripReason(
    descriptor,
    capabilities,
    residualLeaves.length > 0 || droppedOrGroup,
  );

  return {
    acceptedLeaves,
    residualLeaves,
    droppedOrGroup,
    aggregations: stripReason === undefined ? descriptor.aggregations : undefined,
    aggregationStripReason: stripReason,
    divergences,
  };
}

/**
 * The single warning an executor emits when {@link planQueryExecution} strips its aggregations.
 *
 * Shared so the two adapters cannot phrase it differently; each keeps its own emission policy (the
 * batching adapter dedupes per descriptor build and warns everywhere, the simple adapter warns once
 * per request in development only).
 * @param sourceId The descriptor's source.
 * @param reason The plan's `aggregationStripReason`.
 * @returns The message body, without the `MUI X Studio:` prefix its callers add.
 */
export function aggregationStripWarning(sourceId: string, reason: string): string {
  return (
    `A server-side aggregation for source "${sourceId}" was computed client-side instead of ` +
    `pushed to the data adapter: ${reason}. Raw rows are fetched for this widget and aggregated ` +
    `client-side instead.`
  );
}

/**
 * Convert a leaf back into a `StudioFilterState`, so the shared evaluator enforces it.
 *
 * Both executors need this and for the same reason. The batching adapter re-applies its residual
 * with `applyFilters`; the local executor turns the WHOLE accepted set into filter states and hands
 * them to `resolveRows`. Two converters would be two chances to drop a field, so there is one.
 *
 * `id`/`scope` are unused by the evaluator — only field, operator(s), value(s), type and mode
 * matter — but `filterSourceId` is carried because `resolveRows` routes a cross-source leaf by it.
 * It is inert on the adapter's residual path (`applyFilters` never reads it, since that path runs
 * against rows already fetched from one source), so carrying it unconditionally costs nothing and
 * is what lets the local executor use the same function.
 * @param leaf The leaf to convert.
 * @returns An equivalent filter state.
 */
export function leafToFilterState(leaf: StudioFilterLeaf): StudioFilterState {
  return {
    id: `_plan_${leaf.field}`,
    // A leaf carries no scope, because scoping already happened: `buildQueryDescriptor` ran
    // `selectFiltersForWidget` before the tree was built, so every leaf in a descriptor is one that
    // ALREADY applies to this widget. The page scope with no `pageId` is the "applies everywhere"
    // form, which is the honest encoding of "already scoped, apply unconditionally" — and it is
    // what `resolveRows` needs, since it reads `scope.kind` to special-case a dashboard date range.
    // Omitting it threw there; the adapter's residual never noticed because `applyFilters` does not
    // read `scope` at all.
    scope: { kind: 'page' },
    field: leaf.field,
    operator: leaf.op,
    value: leaf.value,
    operator2: leaf.op2,
    value2: leaf.value2,
    conjunction: leaf.conjunction,
    fieldType: leaf.fieldType,
    filterSourceId: leaf.filterSourceId,
    // Preserve the leaf's authoring mode instead of hardcoding `'condition'`. An empty selection
    // ("any value") arrives as a selection-mode `in []`: `isFilterComplete` drops it (→ match
    // everything), but a `'condition'` restamp makes `isConditionComplete('in', [])` true and
    // re-applies `in []` as a real predicate that matches NOTHING — inverting the filter.
    filterMode: leaf.filterMode ?? 'condition',
    // Restored rather than defaulted. `applyFilters` reads `rankDirection ?? 'top'` and branches on
    // the presence of `rankByField`, so dropping these does not fail — it answers a different
    // question: "bottom 5 by revenue" becomes "top 5 by the dimension's own value".
    rankDirection: leaf.rankDirection,
    rankByField: leaf.rankByField,
    rankMultiSeriesBy: leaf.rankMultiSeriesBy,
  } as unknown as StudioFilterState;
}
