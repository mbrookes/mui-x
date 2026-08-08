/**
 * What a query executor can do, declared rather than embedded.
 *
 * A `StudioQueryDescriptor` is the question. An EXECUTOR answers it — in memory over `Row[]`, or
 * over the wire as SQL, or (in future) anywhere else. Executors differ in what they can express
 * faithfully, and something has to decide which parts of a descriptor each one may run.
 *
 * That decision used to live INSIDE the one executor that needed it. `createBatchingAdapter` knew
 * the wire's operator set, its AND-only conjunction, its date-value limits and its boolean-binding
 * hazard, spread across `isOpValueServerTranslatable`, `isLeafServerTranslatable` and
 * `decideAggregationPushdown`. Three consequences followed, and all three are structural:
 *
 * - **A second backend had to re-derive all of it.** Nothing was reusable, so the second
 *   implementation would have been a second set of judgements about the same questions.
 * - **Adding a filter operator was silently incomplete.** A new member of `StudioFilterOperator`
 *   compiled everywhere and simply fell through `mapOperator` to "unmapped" — correct by accident,
 *   and only for the wire.
 * - **The in-memory engine was not describable at all.** It is an executor too, and the most
 *   capable one, but there was nowhere to say so — which is why it and the adapter were two
 *   parallel implementations rather than one contract with two conformers.
 *
 * Here the knowledge is a value. `planQueryExecution` (in `@mui/x-studio-core/engine`) is the one
 * splitter, and it reads a capability set instead of knowing about any particular backend.
 *
 * ## The compile-time guarantee
 *
 * `operators` is declared `satisfies Record<StudioFilterOperator, boolean>`, so adding an operator
 * to the union breaks EVERY declaration until each one says yes or no. That is the same
 * fail-closed pattern the widget registry uses (`satisfies Record<BuiltinStudioWidgetKind, …>`),
 * applied to the thing that was previously correct only by accident.
 *
 * The same applies to `aggregations`, and to the interface itself: a new capability is a compile
 * error in every executor's declaration, so "we forgot to consider the SQL path" stops being a way
 * for a feature to ship.
 *
 * ## What a capability is, and is not
 *
 * A capability answers **"can this executor produce EXACTLY the answer the contract specifies?"**
 * — never "would this executor be faster" or "is this usually fine". The contract is
 * `packages/x-studio/docs/EXECUTION_SEMANTICS.md`; anything an executor cannot match exactly is
 * declared `false` and the planner routes it to the local engine instead.
 *
 * Declaring `true` where an executor is merely close is how a wrong number ships. The whole
 * degradation register in that document is a list of places where `false` is the honest answer.
 *
 * Zero-dependency by design (mirrors `wireLimits.ts` and `wireProtocol.ts`) so both middleware
 * packages, the engine and the client can read it with no risk of an import cycle.
 */
import type { StudioFilterOperator } from './baseTypes';

/**
 * The aggregation vocabulary, canonically.
 *
 * Named here rather than in the engine because it now has three implementers that must agree — the
 * in-memory aggregators, the wire protocol, and this capability model — and a union with several
 * implementers belongs in the package they all already depend on. `@mui/x-studio-core`'s
 * `AggregateFn` is an alias of this.
 *
 * `count` and `count_non_null` are deliberately distinct, and the distinction is the reason the
 * wire needs a capability set at all. Studio's `count` is `COUNT(*)` — every row, nulls included.
 * The wire's `count` is SQL `COUNT(column)`, which skips a NULL measure. Those are different
 * questions, so they get different names, and an executor declares each separately.
 */
export type StudioAggregationFn =
  | 'sum'
  | 'avg'
  | 'count'
  | 'count_non_null'
  | 'min'
  | 'max'
  | 'count_distinct';

/**
 * How an executor binds a boolean filter value.
 *
 * Not a boolean capability, because the failure mode is not "cannot express" — it is **silent
 * inversion**, which is worse and needs its own vocabulary. The filter drawer stores a boolean
 * condition's value as the STRING `'true'`/`'false'`. Bound to SQL as a string, PostgreSQL
 * implicitly casts it, but MySQL (`tinyint(1)`) and SQLite coerce it NUMERICALLY to `0` — so
 * `col = 'true'` returns exactly the rows where the flag is FALSE, the complement of the question.
 *
 * - `'any'` — the executor compares the raw value as the contract specifies
 *   (`String(row[field]) === String(value)`). The in-memory engine.
 * - `'coerced-spellings'` — only a value that reduces to a real boolean may be sent; anything else
 *   is routed to the local engine rather than shipped as a guess.
 */
export type BooleanValueBinding = 'any' | 'coerced-spellings';

export interface StudioQueryCapabilities {
  /** Human-readable name, used in divergence warnings so a host knows which executor declined. */
  readonly name: string;

  /**
   * Which filter operators this executor can express with EXACTLY the contract's semantics.
   *
   * `false` is not a statement that the operator is unsupported by the backend — it is a
   * statement that the backend's version of it would answer differently. SQL has `LIKE`; the six
   * substring operators are still `false` here, because `LIKE` is case-sensitive on most engines
   * and Studio's `contains` is not.
   */
  readonly operators: Readonly<Record<StudioFilterOperator, boolean>>;

  /** Can it express an OR between a leaf's two conditions (`x < 5 OR x > 100`)? */
  readonly intraLeafOr: boolean;

  /** Can it express an OR-combined group of leaves? */
  readonly orGroups: boolean;

  /**
   * Does an empty `in: []` mean "match nothing"?
   *
   * The contract says it does. The middleware drops an empty-`in` predicate on reads, which
   * matches EVERYTHING — the exact inversion, which is why this is a capability and not an
   * assumption.
   */
  readonly emptyInMatchesNothing: boolean;

  /**
   * Can it express a `between` with only one bound set (unbounded on the other side)?
   *
   * `whereBetween(col, [value, undefined])` is a binding error on Postgres and a silent wrong
   * result on SQLite/MySQL.
   */
  readonly openEndedBetween: boolean;

  /**
   * Can it express `equals` on a date/datetime field whose value does NOT reduce to a calendar
   * day — an epoch number, a `Date`, a non-ISO string?
   *
   * A day-granular `equals` is expressible as the bound pair `>= D AND < D+1day`, but only once
   * the value reduces to a day. When it does not, `false` here sends the leaf to the local engine
   * rather than shipping a raw `eq` that matches only exact-midnight rows.
   */
  readonly dateEqualsOnNonCalendarDayValue: boolean;

  /**
   * Can it express `not_equals` on a date/datetime field?
   *
   * Its faithful day-granular form is `< D OR >= D+1day` — an OR. An executor with
   * `intraLeafOr: false` cannot carry it, and a raw `neq` against midnight keeps every
   * non-midnight row of the excluded day.
   */
  readonly dateNotEquals: boolean;

  /** How boolean filter values may be bound. See {@link BooleanValueBinding}. */
  readonly booleanValues: BooleanValueBinding;

  /**
   * Whether this executor may be asked to AGGREGATE, and if so which functions it computes with the
   * contract's semantics.
   *
   * `'none'` is not a limitation — it is a statement that this executor returns rows and the
   * CALLER aggregates them. That is how the in-memory path works and how it should keep working:
   * the widget layer already owns aggregation (`aggregateCellValues` is the single definition of
   * what each name means), so an executor that aggregated too would be a second implementation of
   * the very thing this contract exists to prevent.
   *
   * When it IS a record and any entry is `false`, the planner strips the WHOLE aggregation set and
   * the executor returns raw rows. A partial aggregation is not a thing a response can carry: an
   * aggregated response is one row per group, so a function computed client-side would have no
   * rows left to compute over.
   */
  readonly aggregationPushdown: 'none' | Readonly<Record<StudioAggregationFn, boolean>>;

  /**
   * Does this executor aggregate at exactly the grain the descriptor asks for?
   *
   * Only meaningful when {@link StudioQueryCapabilities.aggregationPushdown} is a record. `false`
   * means it derives its GROUP BY from the projection instead, so any projected column outside
   * `groupBy` — or any `xGroupBy` time bucketing the request cannot transmit — splits each intended
   * group into several. `sum`/`min`/`max` re-reduce correctly from that; `avg` does not, and
   * becomes an unweighted average of averages.
   */
  readonly aggregatesAtRequestedGrain: boolean;

  /**
   * Can it evaluate a filter whose field lives on ANOTHER source, reached through a relationship?
   *
   * Both executors can, and both do it as a semi-join rather than a join — from the "one" side a
   * `LEFT JOIN` fans the row set out and a `SUM` reads N×. Declared anyway, because it is the
   * capability a simpler backend is most likely to lack.
   */
  readonly crossSourceFilters: boolean;

  /**
   * Can it evaluate a `filterMode: 'rank'` leaf — a top/bottom-N reduction of the whole result
   * set, rather than a per-row predicate?
   *
   * Unlike every other capability here, this one is not about expressiveness at the value level.
   * A rank is a different KIND of operation: `applyFilters` runs the row predicates first and then
   * reduces the survivors, so a rank cannot be evaluated one row at a time and has no WHERE-clause
   * form at all. `false` therefore means "this executor must be handed raw rows and the caller
   * ranks them", which is exactly what the wire path already does.
   *
   * Declared rather than assumed because the LOCAL path now hands rank leaves to the planner. An
   * executor that answered `true` without implementing the reduction would return the unranked
   * set — the full dataset where the user asked for five rows.
   */
  readonly rankFilters: boolean;
}

/**
 * The in-memory engine: the reference implementation.
 *
 * Every capability is `true` **by definition, not by coincidence** — the contract in
 * `EXECUTION_SEMANTICS.md` is written FROM this engine's behaviour, so it cannot fail to match
 * itself. A `false` here would not mean "the local engine is limited"; it would mean the contract
 * describes something no executor implements, which is a contract bug.
 *
 * This is what makes the arrangement a contract rather than two peers: the planner can always
 * route a declined leaf somewhere, because one executor always accepts everything.
 */
export const LOCAL_QUERY_CAPABILITIES = {
  name: 'the in-memory pipeline',
  operators: {
    equals: true,
    not_equals: true,
    in: true,
    not_in: true,
    contains: true,
    does_not_contain: true,
    starts_with: true,
    not_starts_with: true,
    ends_with: true,
    not_ends_with: true,
    is_empty: true,
    is_not_empty: true,
    greater_than: true,
    less_than: true,
    greater_than_or_equal: true,
    less_than_or_equal: true,
    between: true,
  } satisfies Record<StudioFilterOperator, boolean>,
  intraLeafOr: true,
  orGroups: true,
  emptyInMatchesNothing: true,
  openEndedBetween: true,
  dateEqualsOnNonCalendarDayValue: true,
  dateNotEquals: true,
  booleanValues: 'any',
  // Returns rows; the widget layer aggregates them. See the field's doc — this is a division of
  // labour, not a gap, and making it anything else would mint a second aggregator.
  aggregationPushdown: 'none',
  aggregatesAtRequestedGrain: true,
  crossSourceFilters: true,
  // `applyFilters` reduces the survivors after the row predicates have run — the reference
  // implementation of the whole "filter then rank" ordering, which the wire path imitates by
  // fetching raw rows and re-applying the rank client-side.
  rankFilters: true,
  // `satisfies` rather than a type annotation: the interface is still checked, but the literal
  // types survive, so a reader of `aggregationPushdown` gets the record (or `'none'`) rather than
  // the union — which is what lets a consumer narrow off the declaration instead of restating it.
} satisfies StudioQueryCapabilities;

/**
 * The `StudioQueryDescriptor` wire protocol, as `@mui/x-studio-data-middleware` implements it.
 *
 * Every `false` below is an entry in the degradation register of
 * `packages/x-studio/docs/EXECUTION_SEMANTICS.md`, and each one has a recorded reason there. This
 * declaration and that register are the same list in two forms; the conformance suite is what
 * keeps them the same list.
 *
 * `not_equals` is the one place this declaration is deliberately OPTIMISTIC. On a non-date field
 * it is `true` here while SQL three-valued logic drops NULL rows that the contract keeps — pushed
 * anyway because routing it locally would defeat the pushdown, and for an aggregated widget would
 * drop the filter entirely. It is the single known divergence, it is announced at runtime through
 * `warnAdapterDivergence`, and the conformance suite caps the category at one entry.
 */
export const WIRE_QUERY_CAPABILITIES = {
  name: "the adapter's query protocol",
  operators: {
    equals: true,
    // Optimistic, knowingly — see the module note above.
    not_equals: true,
    in: true,
    // No negated `in` on the wire.
    not_in: false,
    // The six substring operators: SQL `LIKE` is case-sensitive, Studio's are not. Declared
    // `false` rather than mapped-and-then-rejected, so there is no half-translation for a future
    // change to widen by accident.
    contains: false,
    does_not_contain: false,
    starts_with: false,
    not_starts_with: false,
    ends_with: false,
    not_ends_with: false,
    // No `IS NULL` wire form, and `is_empty` means null OR the empty string.
    is_empty: false,
    is_not_empty: false,
    greater_than: true,
    less_than: true,
    greater_than_or_equal: true,
    less_than_or_equal: true,
    between: true,
  } satisfies Record<StudioFilterOperator, boolean>,
  intraLeafOr: false,
  orGroups: false,
  emptyInMatchesNothing: false,
  openEndedBetween: false,
  dateEqualsOnNonCalendarDayValue: false,
  dateNotEquals: false,
  booleanValues: 'coerced-spellings',
  aggregationPushdown: {
    sum: true,
    avg: true,
    // Studio's `count` is `COUNT(*)`; the wire's is `COUNT(column)`, which skips NULL measures.
    count: false,
    // The one count that DOES push down faithfully: the wire's `count` IS `COUNT(column)`, which
    // is exactly this one's definition. That mismatch is why the two need separate names.
    count_non_null: true,
    min: true,
    max: true,
    // No DISTINCT form on the wire at all.
    count_distinct: false,
  } satisfies Record<StudioAggregationFn, boolean>,
  aggregatesAtRequestedGrain: false,
  crossSourceFilters: true,
  // No SQL form for a top/bottom-N reduction of the result set, and deliberately so: even if one
  // existed, putting rank into the wire's filter tree would rebuild the request cacheKey every
  // time the user nudged the N, turning a client-side reduction into a server round-trip.
  // `buildQueryDescriptor` keeps rank out of the wire tree entirely; this declaration is what
  // makes a rank leaf route to the residual should one ever reach the planner by another road.
  rankFilters: false,
} satisfies StudioQueryCapabilities;
