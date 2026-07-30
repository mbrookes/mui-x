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
import { screenDoc } from './docScreening';
// The per-page rank-uniqueness sweep, shared with the reducer's layout handlers and the
// persistence load boundary. It lives in its own dependency-free module precisely so this
// file can reach it: it began life in `applyMutation.ts`, which imports THIS file, so the
// arrow cannot run both ways. See `rankFilterScope.ts`.
import { dedupeRankFilters } from './rankFilterScope';
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
 * The one exception is an EMPTY `doc.pages` override, which falls back to the
 * default page — see the "at least one page" guard in the body.
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

  // Screen the caller's `doc` bag through the SAME per-entry screens the persistence load
  // boundary applies — see `docScreening.ts`. This factory is the third producer of a
  // `StudioDoc`, and the only one that was unscreened, yet it is reachable straight from the
  // public `Studio initialState` prop (`new StudioController(initialState)`): a filter with
  // no `scope` threw inside `serializeDoc` on the first autosave and on every undo snapshot,
  // a widget with `config: null` threw mid-reduce in `shallowRecordEqual`, and an
  // `ai.threads: 'junk'` threw `map is not a function`. Only the fields the bag actually
  // carries are touched, so the documented "an absent override keeps the factory default"
  // merge contract is unchanged.
  //
  // Two of `deserializeState`'s options are deliberately NOT applied here: `cross-filter`/
  // `interactive`-scoped filters are KEPT (they are session-flavoured and must not come off
  // DISK, but an in-process caller legitimately builds live state carrying them), and the
  // orphan page/widget anchor checks are skipped (a `pages`/`widgets` override is merged onto
  // the factory defaults AFTER this runs, so a filter anchored to the default page would look
  // like an orphan). `pages` gets only the SHAPE screen (`screenPagesShape`: a non-record map
  // coerced to `{}`, an unsafe page key / non-record page value dropped) — enough that no
  // `pages` override can make this factory THROW, which it previously could three ways (see
  // that function's doc). The full LAYOUT sweep is `normalizePersistedPages`, which lives in
  // `applyMutation.ts` and cannot be reached from here without an import cycle, so a `pages`
  // override's `widgetRows`/`widgetColSpans`/`title`/`id` remain unswept — a documented gap.
  const docOverrides = screenDoc(overrides?.doc);
  const sessionOverrides = overrides?.session;
  const runtimeOverrides = overrides?.runtime;

  const mergedDoc: StudioDoc = {
    ...baseDoc,
    ...docOverrides,
    // Stamp the schema version AFTER the spread, never letting an override supply it. This
    // was the one producer of a doc that did: `deserializeState` writes
    // `CURRENT_SCHEMA_VERSION` unconditionally and ignores the persisted value, and no
    // reducer handler writes the field at all. The realistic way an override carries one is
    // `initialState={{ doc: JSON.parse(saved) as StudioDoc }}` (the literal type blocks a
    // direct `schemaVersion: 2`, a cast does not) — and a stale-or-newer disk value riding
    // into live state is not cosmetic: `serializeDoc` spreads it straight back out on the
    // first autosave, so the NEXT load hits `deserializeState`'s deliberate
    // newer-than-current throw (or `migrateState`'s matching refusal) on a doc this very
    // build produced. Stamping here means the version always describes the shape this build
    // actually wrote.
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dashboard: {
      ...baseDoc.dashboard,
      ...docOverrides?.dashboard,
    },
  };
  // "At least one page always exists" is an invariant of this doc shape, and a `doc.pages`
  // override replaces the default page map WHOLESALE, so `{ doc: { pages: {} } }` — reachable
  // from the public `Studio initialState` prop via `new StudioController(initialState)` — used
  // to mint a zero-page doc with `activePageId: ''`. Nothing recovers from that state: every
  // legacy pageId-less mutation (`addWidget`/`setWidgetLayout`/`setWidgetColSpan`) resolves its
  // target through `Object.hasOwn(pages, activePageId)`, which no id satisfies once the map is
  // empty, so the dashboard renders nothing and silently no-ops every edit forever. `removePage`
  // refuses to delete the final page and `deserializeState` synthesizes the default page when its
  // sweep empties the map; this is the third and last producer of a doc, so it upholds the
  // invariant the same way rather than leaving the factory as the one hole.
  if (Object.keys(mergedDoc.pages).length === 0) {
    mergedDoc.pages = baseDoc.pages;
  }
  // Reconcile a dangling `activePageId`: a `doc.pages` override replaces the default page
  // map WHOLESALE (the documented merge contract), so a caller that supplies `pages`
  // without also updating `dashboard.activePageId` would mint a state whose active page
  // names a page that no longer exists — a blank canvas until the user switches pages.
  // Fall back to the first page id, mirroring the exact fallback `removePage` uses when it
  // deletes the active page. The empty-map arm of that fallback is now unreachable (the
  // guard above guarantees a page), so `activePageId` is always a real page id.
  //
  // `typeof ... === 'string'` guards `Object.hasOwn` against its own key-coercion, mirroring
  // the identical clause at the load boundary: `Object.hasOwn(pages, 2)` coerces, so a
  // NUMERIC `activePageId: 2` "matches" a string-keyed page `"2"` and would be waved through
  // as valid — installing a number into a string-typed field. `screenDashboard` deliberately
  // does not check `activePageId` (it needs the FINAL page map), so this is the only screen it
  // passes. Nothing downstream heals it: `removePage`'s strict `===` compare never matches,
  // so removing page `"2"` leaves `activePageId: 2` dangling, and every legacy pageId-less
  // mutation then resolves its target through an `Object.hasOwn` no id satisfies and no-ops
  // forever — an unrecoverable doc for the rest of the session.
  if (
    typeof mergedDoc.dashboard.activePageId !== 'string' ||
    !Object.hasOwn(mergedDoc.pages, mergedDoc.dashboard.activePageId)
  ) {
    mergedDoc.dashboard = {
      ...mergedDoc.dashboard,
      activePageId: Object.keys(mergedDoc.pages)[0] ?? '',
    };
  }
  // Re-check per-page rank-filter uniqueness, the same sweep the load boundary runs right
  // after `screenFilters` and the reducer runs in its three layout handlers. Those handlers
  // exist specifically so a doc is never "live-valid and load-invalid"; the factory was the
  // last producer that could still mint one. An `initialState` carrying two `filterMode:
  // 'rank'` filters that resolve to the same page context installed BOTH, and then the next
  // layout mutation (or the next reload) silently dropped one and re-persisted the loss.
  //
  // Runs HERE, after the page map is final, rather than inside `screenFilters`: the sweep
  // needs the merged `pages` to resolve a `widget` scope's page context, and `screenDoc` runs
  // before the `pages` override is merged onto the defaults — the same reason the orphan
  // anchor probes cannot be applied at screen time. Unlike the reducer and the load boundary
  // this does NOT cascade the drops into the survivors' `dependsOn`: `pruneDependsOn` lives in
  // `applyMutation.ts` and is unreachable from here, and the factory already leaves `dependsOn`
  // alone after every other drop `screenFilters` makes, so the behaviour stays uniform.
  mergedDoc.filters = dedupeRankFilters(mergedDoc.filters, mergedDoc.pages).filters;

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
