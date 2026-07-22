/**
 * Pure factories for default Studio domain objects.
 *
 * No React dependency — creates plain objects. Shared by the client UI
 * (`@mui/x-studio`) and server tool execution (`@mui/x-studio-ai-middleware`) so
 * UI-created and AI-created objects get identical defaults.
 */
import type { BuiltinStudioWidgetKind, StudioWidgetKind } from './baseTypes';
import type {
  StudioChartSeries,
  StudioGridColumn,
  StudioWidgetOf,
  StudioWidgetConfigForKind,
} from './widgetTypes';
import { CURRENT_SCHEMA_VERSION } from './stateTypes';
import type { StudioDoc, StudioRuntime, StudioSession, StudioState } from './stateTypes';
import type { StateMutation, MutationEnvelope } from './aiTypes';

/**
 * Builds a collision-resistant id factory for the given `prefix`.
 *
 * A naive `${prefix}-${Date.now()}` scheme is millisecond-resolution, so two ids
 * minted within the same millisecond collide — and every id below becomes a `Record`
 * map key (`state.widgets`, `state.pages`, …) where a collision silently overwrites an
 * entry (or, for a filter, makes a genuinely-new filter be dropped as an idempotent
 * "re-delivery"). Each returned factory therefore combines the timestamp with a
 * per-factory monotonic counter (deterministically unique within one process — no
 * birthday-paradox risk from a short random string alone under a tight creation loop)
 * plus a random suffix (so ids minted by separate processes, e.g. client + server,
 * still don't collide).
 *
 * The five domain id factories share this single implementation, so a tweak to the id
 * scheme is made once here instead of five hand-copies.
 */
function makeIdFactory(prefix: string): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  };
}

/** Mints a collision-resistant widget ID (see {@link makeIdFactory}). A widget id
 *  becomes a `state.widgets` map key, so a collision would silently overwrite a widget
 *  via `{ ...state.widgets, [id]: widget }`. */
export const createWidgetId = makeIdFactory('widget');

/** Mints a collision-resistant mutation-envelope ID (see {@link makeIdFactory}). */
export const createMutationId = makeIdFactory('mut');

/** Mints a collision-resistant page ID (see {@link makeIdFactory}). A page id becomes a
 *  `state.pages` map key, so a collision would silently overwrite a page. */
export const createPageId = makeIdFactory('page');

/** Mints a collision-resistant filter-preset ID (see {@link makeIdFactory}). */
export const createPresetId = makeIdFactory('preset');

/** Mints a collision-resistant filter ID (see {@link makeIdFactory}). `addFilter` is
 *  idempotent on the filter's `id`, so a collision would make a genuinely-new filter be
 *  dropped as a "re-delivery". */
export const createFilterId = makeIdFactory('filter');

/**
 * Public generic escape hatch onto {@link makeIdFactory} for ad-hoc client-side entities
 * that don't warrant their own dedicated named factory above (e.g. a chart annotation, a
 * manually-created relationship) — mint one factory per entity type and reuse it at module
 * scope, exactly like each factory above does with its own fixed prefix. Prefer adding a
 * dedicated `create<Entity>Id` above instead when an entity becomes a `Record` map key (the
 * collision consequence — a silently overwritten entry — is the same either way; only the
 * naming differs).
 */
export function createIdFactory(prefix: string): () => string {
  return makeIdFactory(prefix);
}

/**
 * Wraps a `StateMutation` in its wire-transport {@link MutationEnvelope}: a
 * fresh `id` (via {@link createMutationId}) and the current time as `at`. The
 * ONE place a `state-mutation` SSE event's envelope is constructed, so every
 * producer (`agenticLoop.ts`'s three yield sites) stamps ids the same way.
 */
export function createMutationEnvelope<T extends StateMutation>(mutation: T): MutationEnvelope<T> {
  return { id: createMutationId(), at: new Date().toISOString(), mutation };
}

/**
 * Default title + config per built-in widget kind.
 *
 * A factory function per kind (rather than a shared literal) guarantees fresh
 * object identity on every call — critical for kinds whose default embeds a
 * mutable container (e.g. `grid`'s `columns: []`), which must never be shared
 * across widget instances.
 *
 * Typed as `Record<BuiltinStudioWidgetKind, ...>` so adding a new built-in kind
 * without a default here is a compile error (fail-closed) rather than silently
 * falling through to another kind's branch.
 */
const BUILTIN_WIDGET_DEFAULTS: {
  [K in BuiltinStudioWidgetKind]: () => { title: string; config: StudioWidgetConfigForKind<K> };
} = {
  text: () => ({ title: 'Text block', config: { textSubtitle: '', textBody: '' } }),
  grid: () => ({ title: '', config: { columns: [] } }),
  chart: () => ({ title: '', config: { chartType: 'bar' } }),
  filter: () => ({ title: 'Filter', config: { filterWidgetType: 'multi-select' } }),
  pivot: () => ({ title: '', config: { pivotAggregation: 'sum' } }),
  map: () => ({ title: '', config: { mapAggregation: 'sum' } }),
  kpi: () => ({ title: '', config: { kpiAggregation: 'sum' } }),
};

/**
 * Creates a default widget for the given kind, with sensible empty config. Used
 * by `executeToolOnState` when the `add_widget` tool is called without a full
 * config.
 *
 * Generic over the kind `K`, so `createDefaultWidget('grid')` returns a
 * `StudioWidgetOf<'grid'>` whose `config` is already narrowed to the grid config
 * shape — callers get the precise per-kind type without a manual narrow.
 */
export function createDefaultWidget<K extends StudioWidgetKind>(
  kind: K,
  overrides?: { title?: string; customConfig?: Record<string, unknown> },
): StudioWidgetOf<K> {
  const id = createWidgetId();

  // `Object.hasOwn` (not `kind in BUILTIN_WIDGET_DEFAULTS`) so an untrusted kind
  // like `'constructor'`/`'hasOwnProperty'` — e.g. from an LLM tool call — is
  // treated as an unknown custom kind rather than matching a prototype-chain
  // member and invoking `Object.prototype.constructor` as a defaults factory
  // (which would mint a corrupted `title: undefined`/`config: undefined` widget
  // that crashes on the first `widget.config.*` access downstream). The table
  // stays a `Record<BuiltinStudioWidgetKind, …>` so the per-kind exhaustiveness
  // check is preserved; only the membership test is hardened.
  //
  // The `as StudioWidgetOf<K>` casts below are unavoidable: `K` is an
  // unresolved generic, so TS cannot evaluate the `StudioWidgetConfigForKind<K>`
  // conditional to see that each branch's concrete config matches it. The
  // runtime dispatch on `kind` is exactly what makes the concrete shape correct.
  if (!Object.hasOwn(BUILTIN_WIDGET_DEFAULTS, kind)) {
    // Custom widget kind
    return {
      id,
      kind,
      title: overrides?.title ?? kind,
      config: { customConfig: overrides?.customConfig ?? {} },
    } as StudioWidgetOf<K>;
  }

  const { title, config } = BUILTIN_WIDGET_DEFAULTS[kind as BuiltinStudioWidgetKind]();
  // Thread `overrides.customConfig` into the built-in config too (the custom-kind
  // branch above already honors it). `customConfig` is a key on the shared widget
  // config for every kind, so a caller passing `createDefaultWidget('grid', {
  // customConfig })` gets it merged rather than silently dropped.
  const mergedConfig =
    overrides?.customConfig !== undefined
      ? { ...config, customConfig: overrides.customConfig }
      : config;
  return {
    id,
    kind,
    title: overrides?.title ?? title,
    config: mergedConfig,
  } as StudioWidgetOf<K>;
}

/**
 * Normalise a column entry that may be either a legacy `string` field ID or a
 * `StudioGridColumn` object. Call this when reading persisted state.
 */
export function normalizeGridColumn(col: string | StudioGridColumn): StudioGridColumn {
  return typeof col === 'string' ? { fieldId: col } : col;
}

/**
 * Normalise a chart series that may carry the render kind under either the
 * canonical `type` field or the deprecated `seriesType` alias.
 *
 * `type` is the canonical spelling (see its JSDoc on `StudioChartSeries`); when
 * both are present `type` wins. The returned series always expresses the render
 * kind through `type` and never carries the deprecated `seriesType`, so every
 * consumer can read a single field instead of guessing precedence. Call this
 * when reading persisted state (same pattern as `normalizeGridColumn`).
 */
export function normalizeChartSeries(series: StudioChartSeries): StudioChartSeries {
  // Total over junk input: a `ySeries` entry that is `null` or a non-object (e.g. a
  // malformed wire payload — `parseStateMutation` leaves the config interior as an
  // unvalidated leaf, so `{ ySeries: [null] }` reaches here) must not crash the
  // reducer on the `.type` read. Return it unchanged so the caller keeps its
  // reference-stable no-op behaviour and `applyMutation` never throws mid-apply.
  if (series === null || typeof series !== 'object') {
    return series;
  }
  const resolvedType = series.type ?? series.seriesType;
  // No deprecated alias present ⇒ already canonical; avoid churning object identity.
  // (The former `&& series.type === resolvedType` conjunct was tautological here:
  // when `seriesType` is `undefined`, `resolvedType` collapses to `series.type`.)
  if (series.seriesType === undefined) {
    return series;
  }
  // Past the early return the `seriesType` alias key is present — strip it. Express the
  // render kind through the canonical `type` only when one actually resolved: a NULLISH
  // alias (`seriesType: null`, possible via an unvalidated config leaf) with no canonical
  // `type` must OMIT `type` rather than promote the junk into a `type: null` canonical
  // field. The normalizer's contract is that the result expresses the render kind through
  // `type`, and `null` is not a render kind.
  const { seriesType, ...rest } = series;
  return resolvedType == null ? rest : { ...rest, type: resolvedType };
}

const defaultPageId = 'page-1';

/**
 * Overrides for {@link createDefaultStudioState}, one bag per lifetime partition.
 *
 * Deliberately nested (`{ doc?, session?, runtime? }`) rather than a flat
 * convenience shape: a flat bag would need a hand-maintained field-routing table
 * (which field goes to which partition), which is exactly the fragility this
 * lifetime-partition rewrite exists to eliminate. Callers name the partition
 * explicitly, so a new `StudioDoc` field is never silently mis-routed.
 *
 * `dashboard` (in `doc`) and `shell`/`shell.openDrawers` (in `session`) are
 * deep-merged onto their defaults; every other field replaces its default
 * wholesale (e.g. a `doc.pages` override replaces the default page map entirely).
 */
export interface CreateDefaultStudioStateOverrides {
  doc?: Partial<StudioDoc>;
  session?: Partial<StudioSession>;
  runtime?: Partial<StudioRuntime>;
}

export function createDefaultStudioState(
  overrides?: CreateDefaultStudioStateOverrides,
): StudioState {
  const baseDoc: StudioDoc = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dashboard: {
      id: 'dashboard-1',
      title: 'Untitled Dashboard',
      activePageId: defaultPageId,
    },
    pages: {
      [defaultPageId]: {
        id: defaultPageId,
        title: 'Page 1',
        widgetRows: [], // No widgets by default
      },
    },
    widgets: {},
    relationships: [],
    filters: [],
    expressionFields: [],
  };
  const baseSession: StudioSession = {
    mode: 'edit',
    shell: {
      openDrawers: {
        data: true,
        compose: true,
        filters: false,
      },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  };
  const baseRuntime: StudioRuntime = {
    dataSources: {},
  };

  const docOverrides = overrides?.doc;
  const sessionOverrides = overrides?.session;
  const runtimeOverrides = overrides?.runtime;

  const mergedDoc: StudioDoc = {
    ...baseDoc,
    ...docOverrides,
    dashboard: {
      ...baseDoc.dashboard,
      ...docOverrides?.dashboard,
    },
  };
  // Reconcile a dangling `activePageId`: a `doc.pages` override replaces the default page
  // map WHOLESALE (the documented merge contract), so a caller that supplies `pages`
  // without also updating `dashboard.activePageId` would mint a state whose active page
  // names a page that no longer exists — a blank canvas until the user switches pages.
  // Fall back to the first page id (or `''` when the map is empty), mirroring the exact
  // fallback `removePage` uses when it deletes the active page.
  if (!Object.hasOwn(mergedDoc.pages, mergedDoc.dashboard.activePageId)) {
    mergedDoc.dashboard = {
      ...mergedDoc.dashboard,
      activePageId: Object.keys(mergedDoc.pages)[0] ?? '',
    };
  }

  return {
    doc: mergedDoc,
    session: {
      ...baseSession,
      ...sessionOverrides,
      shell: {
        ...baseSession.shell,
        ...sessionOverrides?.shell,
        openDrawers: {
          ...baseSession.shell.openDrawers,
          ...sessionOverrides?.shell?.openDrawers,
        },
      },
    },
    runtime: {
      ...baseRuntime,
      ...runtimeOverrides,
    },
  };
}
