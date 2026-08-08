/**
 * The in-memory engine, entered through a `StudioQuery`.
 *
 * The descriptor is the contract (ADR 0005). An executor answers one; this is the executor that
 * answers it over `Row[]` in the browser, and it is the REFERENCE one — the semantics written down
 * in `packages/x-studio/docs/EXECUTION_SEMANTICS.md` are its behaviour, so it cannot fail to match
 * them. Every other executor is judged against what this one does.
 *
 * ## What this changes
 *
 * Before, the in-memory path and the push-down path took DIFFERENT inputs. The push-down path was
 * handed a descriptor; the in-memory path went straight from `StudioFilterState[]` to
 * `resolveRows`. So they were two engines answering the same question from two different
 * statements of it, and nothing structural stopped the two statements from drifting — which is what
 * A5 found. Now both start from the same object.
 *
 * ## Why it returns rows rather than aggregates
 *
 * `LOCAL_QUERY_CAPABILITIES.aggregationPushdown` is `'none'`, and that is a division of labour
 * rather than a gap. The widget layer already owns aggregation — `aggregateCellValues` is the one
 * definition of what each aggregation name means — so an executor that also aggregated would be a
 * second implementation of exactly the thing this contract exists to prevent. The descriptor's
 * `aggregations` are therefore carried, not executed, and the caller reduces the rows.
 *
 * ## What it does not do
 *
 * It does not normalize (L1) or project (`select`). The caller supplies rows that have already been
 * through `getCachedNormalizedDataSource`, because normalization is keyed on the rows array and
 * cached across every widget that shares a source — doing it per query would throw that away. And
 * nothing in Studio benefits from dropping columns client-side: `select` exists so a REMOTE
 * executor can avoid transferring them.
 */
import {
  LOCAL_QUERY_CAPABILITIES,
  type StudioDataSource,
  type StudioExpressionField,
  type StudioQuery,
  type StudioQueryResult,
  type StudioRelationship,
} from '../models';
import { resolveRows } from './dataSourceGraph';
import { resolveRowsCached } from './resolvedRowsCache';
import { isLeafComplete, leafToFilterState, planQueryExecution } from './queryPlan';

type Row = Record<string, unknown>;

export interface LocalQueryContext {
  /**
   * The widget source's rows, already L1-normalized.
   *
   * Not normalized here on purpose — see the module doc. Passing raw rows is not an error this can
   * detect, but it re-opens the day-shift and lexicographic-ordering bugs L1 exists to close, so
   * every caller must come through `getCachedNormalizedDataSource`.
   */
  rows: Row[];
  /** Every source, needed to resolve a cross-source filter's foreign rows. */
  dataSources: Record<string, StudioDataSource>;
  relationships?: StudioRelationship[];
  expressionFields?: StudioExpressionField[];
  /**
   * Out-param threaded to `resolveRows` so a caller can record its foreign-row dependencies.
   *
   * Mutually exclusive with `cache`: a cached call may return a memoized result without joining
   * anything, so there would be nothing to collect. `resolveRowsCached` tracks the same
   * dependencies internally for its own invalidation.
   */
  collectJoinedSourceIds?: Set<string>;
  /**
   * Serve from (and populate) the shared resolved-rows cache instead of resolving afresh.
   *
   * Widgets on a page routinely share a source AND an effective filter set; the cache is what lets
   * the second and later ones reuse the first one's `Row[]` **by reference**, so downstream memos
   * short-circuit too. Without it, routing `useWidgetRows` through this function would have cost a
   * full pipeline pass per widget per render — the descriptor becoming the only road to rows must
   * not also make it a slower one.
   *
   * `usedFieldIds` is part of the cache key and carries a meaning `undefined` does not: an ABSENT
   * set means "enrich every field for the source", an EMPTY set means "enrich none". Passing the
   * wrong one does not merely miss the cache, it shares a slot with a differently-enriched result.
   */
  cache?: { usedFieldIds?: ReadonlySet<string> };
}

/**
 * Execute a descriptor against in-memory rows.
 * @param descriptor The query to answer.
 * @param context The rows and the graph needed to resolve cross-source filters.
 * @returns The matching rows.
 */
export function executeLocalQuery(
  descriptor: StudioQuery,
  context: LocalQueryContext,
): StudioQueryResult {
  const plan = planQueryExecution(descriptor, LOCAL_QUERY_CAPABILITIES);

  // A residual here would mean the contract describes a filter NO executor can run, which is a
  // contract bug rather than a runtime condition — and it is the invariant that makes the whole
  // arrangement a contract rather than two peers, since the planner can only route a declined leaf
  // somewhere if one executor always accepts everything. Checked in development only; in
  // production the leaves are applied regardless, so a mistake degrades to "the filter still ran"
  // rather than to a thrown error in a dashboard.
  //
  // Incomplete leaves are excluded from the check, and that exclusion is load-bearing now that this
  // function is on the hot path for every widget. Every executor declines a half-authored filter by
  // design — the residual re-drops it — so counting those would fire this warning on every keystroke
  // while a user types into the filter drawer, telling them a contract bug had occurred.
  const unexpectedDeclines = plan.residualLeaves.filter(isLeafComplete);
  if (process.env.NODE_ENV !== 'production' && unexpectedDeclines.length > 0) {
    const ops = unexpectedDeclines.map((leaf) => leaf.op).join(', ');
    console.warn(
      `MUI X Studio: The in-memory executor declined ${unexpectedDeclines.length} filter leaf/leaves ` +
        `(${ops}), but it is the reference executor and must accept everything the contract defines. ` +
        `Either LOCAL_QUERY_CAPABILITIES understates what the engine does, or the contract describes ` +
        `a filter nothing implements. See packages/x-studio/docs/EXECUTION_SEMANTICS.md.`,
    );
  }

  // A dropped OR group is the one shape the local path genuinely cannot carry either: the
  // re-application form is a `StudioFilterState[]`, which is AND-combined, so there is nowhere to
  // put it. Producers only build `logic: 'and'` groups, so this is defensive — but silent would be
  // a wrong answer.
  if (process.env.NODE_ENV !== 'production' && plan.droppedOrGroup) {
    console.warn(
      `MUI X Studio: An OR-combined filter group was dropped from a query for source ` +
        `"${descriptor.sourceId}". The filter-state form every executor re-applies through is ` +
        `AND-combined, so an OR group has no representation on either path.`,
    );
  }

  const filters = [...plan.acceptedLeaves, ...plan.residualLeaves].map(leafToFilterState);

  if (context.cache) {
    return {
      rows: resolveRowsCached(
        context.rows,
        descriptor.sourceId,
        filters,
        context.dataSources,
        context.relationships ?? [],
        context.expressionFields ?? [],
        context.cache.usedFieldIds,
      ),
    };
  }

  return {
    rows: resolveRows(
      context.rows,
      descriptor.sourceId,
      filters,
      context.dataSources,
      context.relationships ?? [],
      context.expressionFields ?? [],
      context.collectJoinedSourceIds
        ? { collectJoinedSourceIds: context.collectJoinedSourceIds }
        : undefined,
    ),
  };
}
