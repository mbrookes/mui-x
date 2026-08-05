'use client';

import * as React from 'react';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioWidget,
} from '../models';
import { buildWidgetQueryDescriptor } from './queryDescriptor';
import { studioRequestCache } from './StudioRequestCache';
import { useStudioLocaleText } from '../context';

type Row = Record<string, unknown>;

export interface UseAdapterRowsResult {
  /** Rows fetched from the adapter (physical columns only — enrichment happens in useWidgetRows). */
  adapterRows: Row[];
  /**
   * True while `adapterRows` are the cold-cache PLACEHOLDER seeded from `dataSource.rows`
   * rather than a response the adapter actually produced for the current descriptor.
   *
   * Callers must not assume the descriptor's server-side filters were applied to placeholder
   * rows — they never went to the server. `useWidgetRows` re-applies the FULL local filter
   * chain to them instead of only the rank/cross/interactive residual, so a dashboard with a
   * "last 30 days" range doesn't render the entire dataset (and KPI totals computed from it)
   * on every page load until the first fetch resolves.
   *
   * Always false once any real response (cached or fetched) lands, and always false for a
   * source with no adapter.
   */
  isPlaceholder: boolean;
  /**
   * True while an async adapter fetch is in progress.
   * Always false for sources without an adapter (sync path).
   */
  isLoading: boolean;
  /**
   * True when the last async adapter fetch failed.
   * Cleared when a subsequent fetch succeeds.
   */
  isError: boolean;
  /** Human-readable error message from the last failed adapter fetch (empty when none). */
  errorMessage: string;
}

/**
 * Encapsulates the async-adapter state machine for a widget: builds the
 * `StudioQueryDescriptor`, seeds rows from (and dedupes through) the module-singleton
 * `studioRequestCache`, and tracks loading/error state across descriptor changes.
 *
 * Pure extraction from `useWidgetRows` — no behavior change. For sources without an
 * adapter it returns an empty row set and all flags false.
 */
export function useAdapterRows(
  widget: StudioWidget,
  dataSource: StudioDataSource | undefined,
  pageId: string,
  filters: StudioFilterState[],
  expressionFields: StudioExpressionField[],
  relationships: StudioRelationship[] = [],
  crossFilterAllPages: boolean = false,
): UseAdapterRowsResult {
  const localeText = useStudioLocaleText();
  const hasAdapter = Boolean(dataSource?.adapter);

  // Descriptor is rebuilt whenever any state that affects it changes.
  const descriptor = React.useMemo(() => {
    if (!hasAdapter || !widget.sourceId) {
      return null;
    }
    // Delegates to the shared helper (rather than calling `buildQueryDescriptor` directly)
    // so this — the live-render path — can never drift out of sync with the CSV export
    // path's descriptor, which reads the same `studioRequestCache` entry by `cacheKey`.
    //
    return buildWidgetQueryDescriptor(widget, pageId, dataSource?.tableName, {
      filters,
      expressionFields,
      relationships,
      crossFilterAllPages,
    });
  }, [
    hasAdapter,
    widget,
    filters,
    pageId,
    dataSource,
    expressionFields,
    relationships,
    crossFilterAllPages,
  ]);

  // Async state: rows fetched from adapter, plus whether they are the cold-cache placeholder.
  // Both live in ONE state object so the two can never disagree (a placeholder flag lagging a
  // row update by a render would be exactly the unfiltered-rows bug it exists to prevent).
  const [rowsState, setRowsState] = React.useState<{ rows: Row[]; isPlaceholder: boolean }>(() => {
    if (!hasAdapter) {
      return { rows: [], isPlaceholder: false };
    }
    // Seed from cache synchronously on mount. Pass the live adapter so this instance only
    // ever reads entries written by its OWN adapter (two `<Studio>` instances sharing a
    // `sourceId` but backed by different adapters must not serve each other's rows).
    const cached = descriptor
      ? studioRequestCache.get(descriptor.cacheKey, dataSource?.adapter)
      : undefined;
    if (cached) {
      return { rows: cached.rows, isPlaceholder: false };
    }
    // Fall back to source.rows as a display placeholder so the widget doesn't
    // flash empty while the adapter re-fetches on a cold cache (e.g. after page
    // navigation when source.rows was pre-populated by setDataSourceRows). These rows never
    // went through the server, so nothing in `descriptor.filter` has been applied to them —
    // flagged so the caller can apply the whole filter chain locally instead.
    //
    // Returned RAW (as `dataSource.rows`, by reference), like every other row set this hook
    // yields: L1 normalization belongs to the consumer, and `useWidgetRows` runs it over
    // `adapterRows` before L2/L3. Keeping the reference identical is what lets it reuse the
    // sync path's own normalized-source cache slot rather than cloning the array twice.
    return { rows: (dataSource?.rows as Row[] | undefined) ?? [], isPlaceholder: true };
  });

  // react-doctor-disable-next-line react-doctor/rendering-usetransition-loading -- isLoading guards an async data fetch (adapter.getRows), not a state transition
  const [isLoading, setIsLoading] = React.useState(false);
  const [isError, setIsError] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');

  /**
   * Records rows that came from a real adapter response (cached or freshly fetched). Returns
   * the previous state unchanged when nothing actually changed, preserving the setState bail-out
   * the repeated-cache-hit path relies on to avoid an extra render.
   */
  const setResolvedRows = React.useCallback((rows: Row[]) => {
    setRowsState((prev) =>
      prev.rows === rows && !prev.isPlaceholder ? prev : { rows, isPlaceholder: false },
    );
  }, []);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- multiple setState calls are intentional: they atomically update related async fetch state
  React.useEffect(() => {
    if (!descriptor || !dataSource?.adapter) {
      // The descriptor/adapter became unavailable (e.g. the adapter was removed
      // mid-flight via setDataSourceAdapter(id, undefined), removeDataSource, or the
      // dataAdapters prop dropping this source). Any in-flight promise from a previous
      // descriptor is neutralized by its own cleanup (`cancelled = true`), so nothing
      // else will ever clear isLoading/isError — reset them here so the widget doesn't
      // get stuck showing a permanent loading spinner or stale error overlay after
      // falling back to in-memory rows.
      setIsLoading(false);
      setIsError(false);
      setErrorMessage('');
      return;
    }

    const { cacheKey } = descriptor;
    const adapter = dataSource.adapter;
    const cached = studioRequestCache.get(cacheKey, adapter);

    if (cached) {
      // Cache hit — serve synchronously, no loading state.
      setResolvedRows(cached.rows);
      // Must clear isLoading here too: if a previous descriptor (A) missed the cache
      // and set isLoading=true, then the descriptor switched to B (this cache hit)
      // before A resolved, A's cleanup marks it cancelled and its `.then` never runs —
      // so nothing else would ever reset isLoading and the overlay would stay stuck
      // forever even though valid data is already rendered. When isLoading is already
      // false (the common repeated cache-hit case) React bails on the no-op setState,
      // so this does not reintroduce a flash of loading state.
      setIsLoading(false);
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- resetting error state on new descriptor is intentional
      setIsError(false);
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- resetting error state on new descriptor is intentional
      setErrorMessage('');
      return;
    }

    // Check for an existing in-flight request to deduplicate.
    let promise = studioRequestCache.getInflight(cacheKey, adapter);
    if (!promise) {
      // A well-behaved adapter returns a promise (rejecting on failure), but a host adapter
      // can also throw synchronously from getRows(). Without this guard that throw escapes
      // the effect uncaught and — with no error boundary above — takes down the render tree.
      // Route a sync throw into the same isError/errorMessage state as the rejection path.
      let getRowsResult;
      try {
        getRowsResult = dataSource.adapter.getRows(descriptor);
      } catch (err: unknown) {
        setIsLoading(false);
        setIsError(true);
        setErrorMessage(err instanceof Error ? err.message : localeText.widgetLoadError);
        return;
      }
      // Pass descriptor.sourceId explicitly so the generation guard / reverse index use
      // the true source even if it contains a ':' (rather than the cacheKey parse). Pass
      // `adapter` so the settled result is namespaced to this adapter instance, matching
      // the `get`/`getInflight` calls above.
      promise = studioRequestCache.addInflight(
        cacheKey,
        getRowsResult,
        descriptor.sourceId,
        adapter,
      );
    }

    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- setting loading state when descriptor changes triggers a new fetch
    setIsLoading(true);
    let cancelled = false;

    promise.then(
      (result) => {
        if (!cancelled) {
          setResolvedRows(result.rows);
          setIsLoading(false);
          setIsError(false);
          setErrorMessage('');
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setIsLoading(false);
          setIsError(true);
          setErrorMessage(err instanceof Error ? err.message : localeText.widgetLoadError);
        }
      },
    );

    // eslint-disable-next-line consistent-return
    return () => {
      cancelled = true;
    };
  }, [descriptor, dataSource, localeText.widgetLoadError, setResolvedRows]);

  return {
    adapterRows: rowsState.rows,
    isPlaceholder: rowsState.isPlaceholder,
    isLoading,
    isError,
    errorMessage,
  };
}
