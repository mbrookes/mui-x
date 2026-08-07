import type { StudioRuntime, StudioDataSource, StudioDataField } from '../models';
import { mapPreservingIdentity } from '../utils/mapPreservingIdentity';

/**
 * Pure `StudioRuntime → StudioRuntime` transforms for the host-injected data sources.
 *
 * The counterpart to what `applyMutation` is for `doc`. Those two partitions differ in a way that
 * shapes this file: `doc` is persisted and undoable, so its reducer lives in the shared schema
 * package and runs on both sides of the wire. `runtime` is neither — it is host-injected live data
 * that must never be persisted or reverted by an undo — so it stays in this package and needs no
 * mutation vocabulary. What it does need is the same DISCIPLINE: one place that decides what a
 * write does, returning the SAME runtime object when nothing changed, so the commit choke point
 * can treat a logical no-op as a no-op.
 *
 * WHAT STAYS IN THE CONTROLLER. Cache invalidation. `studioRequestCache.invalidateSource(...)` is
 * an I/O side effect on a module-level singleton, and interleaving it with state computation is
 * what made these writers hard to read: `setDataSourceAdapter` checked existence, compared the
 * adapter, invalidated the cache and then patched, with the early returns of three concerns
 * braided together. Here each function answers only "what is the next runtime", and the
 * controller decides what to evict.
 */

/**
 * The source with this id, or `undefined` — every transform treats a missing one as a no-op
 * rather than an insert.
 *
 * `Object.hasOwn` rather than a bare bracket read, and not defensively: `sourceId` is
 * caller-authored (a host call, an AI tool call, or a doc-stored `widget.sourceId`), and a key
 * like `constructor`/`toString` resolves a FUNCTION off `Object.prototype` on a plain-object
 * `Record`. That truthy non-source value passes an `if (!source)` check and gets spread into
 * `dataSources` as a real entry — a prototype member persisted as a data source. Same convention
 * `selectors.ts` and the controller's `commitWidgetMove` document.
 */
function existing(runtime: StudioRuntime, sourceId: string): StudioDataSource | undefined {
  return Object.hasOwn(runtime.dataSources, sourceId) ? runtime.dataSources[sourceId] : undefined;
}

/**
 * Insert or replace a source, PRESERVING an adapter the incoming object omits.
 *
 * An adapter can be registered separately (`setDataSourceAdapter`, or the `dataAdapters` prop),
 * and a config produced by `serializeState()`/JSON never carries an `adapter` field — so a
 * config-swap reload would otherwise silently wipe every registered adapter and make
 * adapter-backed sources fall back to their (usually absent) static rows.
 */
export function upsertDataSource(
  runtime: StudioRuntime,
  dataSource: StudioDataSource,
): StudioRuntime {
  const prev = existing(runtime, dataSource.id);
  const next =
    dataSource.adapter || !prev?.adapter ? dataSource : { ...dataSource, adapter: prev.adapter };
  if (next === prev) {
    return runtime;
  }
  return { ...runtime, dataSources: { ...runtime.dataSources, [dataSource.id]: next } };
}

/** Drop a source. A no-op — the same runtime back — when the id is unknown. */
export function removeDataSource(runtime: StudioRuntime, sourceId: string): StudioRuntime {
  if (!existing(runtime, sourceId)) {
    return runtime;
  }
  const dataSources = { ...runtime.dataSources };
  delete dataSources[sourceId];
  return { ...runtime, dataSources };
}

/**
 * Shallow-merge a patch onto one source, with a value-equality bail.
 *
 * The bail is load-bearing rather than an optimization. `setDataSourceRows(id, sameArrayRef)` —
 * a host poller re-injecting the SAME rows array from an effect — would otherwise rebuild the
 * source object AND the `dataSources` record, changing both references and notifying every
 * subscriber for no actual change. `updateDataSourceField` had grown its own copy of this guard
 * for exactly that reason; having it here covers every caller instead.
 */
export function patchDataSource(
  runtime: StudioRuntime,
  sourceId: string,
  patch: Partial<StudioDataSource>,
): StudioRuntime {
  const source = existing(runtime, sourceId);
  if (!source) {
    return runtime;
  }
  const keys = Object.keys(patch) as (keyof StudioDataSource)[];
  if (keys.every((key) => patch[key] === source[key])) {
    return runtime;
  }
  return {
    ...runtime,
    dataSources: { ...runtime.dataSources, [sourceId]: { ...source, ...patch } },
  };
}

/**
 * Merge updates into ONE field of a source's `fields` array.
 *
 * `mapPreservingIdentity` keeps every untouched field's object identity, and returns the original
 * array when no entry changed — so a value-identical update reaches {@link patchDataSource} as a
 * reference-equal `fields` and no-ops there.
 */
export function updateDataSourceField(
  runtime: StudioRuntime,
  sourceId: string,
  fieldId: string,
  updates: Partial<StudioDataField>,
): StudioRuntime {
  const source = existing(runtime, sourceId);
  if (!source) {
    return runtime;
  }
  const nextFields = mapPreservingIdentity(source.fields, (field: StudioDataField) => {
    if (field.id !== fieldId) {
      return field;
    }
    const keys = Object.keys(updates) as (keyof StudioDataField)[];
    if (keys.every((key) => updates[key] === field[key])) {
      return field;
    }
    return { ...field, ...updates };
  });
  return patchDataSource(runtime, sourceId, { fields: nextFields });
}
