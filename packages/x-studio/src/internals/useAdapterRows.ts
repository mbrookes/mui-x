'use client';

import * as React from 'react';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioWidget,
} from '../models';
import { buildQueryDescriptor } from './queryDescriptor';
import { studioRequestCache } from './StudioRequestCache';

type Row = Record<string, unknown>;

export interface UseAdapterRowsResult {
  /** Rows fetched from the adapter (physical columns only — enrichment happens in useWidgetRows). */
  adapterRows: Row[];
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
  const hasAdapter = Boolean(dataSource?.adapter);

  // Descriptor is rebuilt whenever any state that affects it changes.
  const descriptor = React.useMemo(() => {
    if (!hasAdapter || !widget.sourceId) {
      return null;
    }
    return buildQueryDescriptor(
      widget,
      filters,
      pageId,
      dataSource?.tableName,
      expressionFields,
      relationships,
      crossFilterAllPages,
    );
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

  // Async state: rows fetched from adapter.
  const [adapterRows, setAdapterRows] = React.useState<Row[]>(() => {
    if (!hasAdapter) {
      return [];
    }
    // Seed from cache synchronously on mount.
    const cached = descriptor ? studioRequestCache.get(descriptor.cacheKey) : undefined;
    if (cached) {
      return cached.rows;
    }
    // Fall back to source.rows as a display placeholder so the widget doesn't
    // flash empty while the adapter re-fetches on a cold cache (e.g. after page
    // navigation when source.rows was pre-populated by setDataSourceRows).
    return (dataSource?.rows as Row[] | undefined) ?? [];
  });
  // react-doctor-disable-next-line react-doctor/rendering-usetransition-loading -- isLoading guards an async data fetch (adapter.getRows), not a state transition
  const [isLoading, setIsLoading] = React.useState(false);
  const [isError, setIsError] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- multiple setState calls are intentional: they atomically update related async fetch state
  React.useEffect(() => {
    if (!descriptor || !dataSource?.adapter) {
      return;
    }

    const { cacheKey } = descriptor;
    const cached = studioRequestCache.get(cacheKey);

    if (cached) {
      // Cache hit — serve synchronously, no loading state.
      setAdapterRows(cached.rows);
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
    let promise = studioRequestCache.getInflight(cacheKey);
    if (!promise) {
      // Pass descriptor.sourceId explicitly so the generation guard / reverse index use
      // the true source even if it contains a ':' (rather than the cacheKey parse).
      promise = studioRequestCache.addInflight(
        cacheKey,
        dataSource.adapter.getRows(descriptor),
        descriptor.sourceId,
      );
    }

    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- setting loading state when descriptor changes triggers a new fetch
    setIsLoading(true);
    let cancelled = false;

    promise.then(
      (result) => {
        if (!cancelled) {
          setAdapterRows(result.rows);
          setIsLoading(false);
          setIsError(false);
          setErrorMessage('');
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setIsLoading(false);
          setIsError(true);
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load data');
        }
      },
    );

    // eslint-disable-next-line consistent-return
    return () => {
      cancelled = true;
    };
  }, [descriptor, dataSource]);

  return { adapterRows, isLoading, isError, errorMessage };
}
