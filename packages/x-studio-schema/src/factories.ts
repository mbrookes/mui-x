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
  StudioWidget,
  StudioWidgetConfig,
} from './widgetTypes';
import { CURRENT_SCHEMA_VERSION } from './stateTypes';
import type { StudioDoc, StudioRuntime, StudioSession, StudioState } from './stateTypes';
import type { StateMutation, MutationEnvelope } from './aiTypes';

/**
 * Mints a collision-resistant widget ID.
 *
 * The previous `widget-${kind}-${Date.now()}` scheme was millisecond-resolution,
 * so two widgets created within the same millisecond received identical IDs — and
 * a collision silently overwrites a widget via `{ ...state.widgets, [id]: widget }`.
 * Both consumers (the client UI and the AI middleware) mint IDs through this one
 * generator, so the anti-collision suffix lives in a single place.
 *
 * Combines the timestamp with a per-process monotonic counter (deterministically
 * unique within one process — no birthday-paradox risk from a short random string
 * alone under a tight creation loop) plus a random component (so ids minted by
 * separate processes, e.g. client + server, still don't collide).
 */
let widgetIdSequence = 0;
export function createWidgetId(): string {
  widgetIdSequence += 1;
  return `widget-${Date.now()}-${widgetIdSequence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Mints a collision-resistant mutation-envelope ID. Same scheme as
 * {@link createWidgetId} (timestamp + per-process counter + random suffix) —
 * see that function's doc comment for the collision-avoidance rationale.
 */
let mutationIdSequence = 0;
export function createMutationId(): string {
  mutationIdSequence += 1;
  return `mut-${Date.now()}-${mutationIdSequence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
const BUILTIN_WIDGET_DEFAULTS: Record<
  BuiltinStudioWidgetKind,
  () => { title: string; config: StudioWidgetConfig }
> = {
  text: () => ({ title: 'Text block', config: { textSubtitle: '', textBody: '' } }),
  grid: () => ({ title: '', config: { columns: [] } }),
  chart: () => ({ title: '', config: { chartType: 'bar' } }),
  filter: () => ({ title: 'Filter', config: { filterWidgetType: 'multi-select' } }),
  pivot: () => ({ title: '', config: { pivotAggregation: 'sum' } }),
  map: () => ({ title: '', config: { mapAggregation: 'sum' } }),
  kpi: () => ({ title: '', config: { kpiAggregation: 'sum' } }),
};

/**
 * Creates a default `StudioWidget` for the given kind, with sensible
 * empty config. Used by `executeToolOnState` when the `add_widget` tool
 * is called without a full config.
 */
export function createDefaultWidget(
  kind: StudioWidgetKind,
  overrides?: { title?: string; customConfig?: Record<string, unknown> },
): StudioWidget {
  const id = createWidgetId();

  // `Object.hasOwn` (not `kind in BUILTIN_WIDGET_DEFAULTS`) so an untrusted kind
  // like `'constructor'`/`'hasOwnProperty'` — e.g. from an LLM tool call — is
  // treated as an unknown custom kind rather than matching a prototype-chain
  // member and invoking `Object.prototype.constructor` as a defaults factory
  // (which would mint a corrupted `title: undefined`/`config: undefined` widget
  // that crashes on the first `widget.config.*` access downstream). The table
  // stays a `Record<BuiltinStudioWidgetKind, …>` so the per-kind exhaustiveness
  // check is preserved; only the membership test is hardened.
  if (!Object.hasOwn(BUILTIN_WIDGET_DEFAULTS, kind)) {
    // Custom widget kind
    return {
      id,
      kind,
      title: overrides?.title ?? kind,
      config: { customConfig: overrides?.customConfig ?? {} },
    };
  }

  const { title, config } = BUILTIN_WIDGET_DEFAULTS[kind as BuiltinStudioWidgetKind]();
  return {
    id,
    kind,
    title: overrides?.title ?? title,
    config,
  };
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
  const resolvedType = series.type ?? series.seriesType;
  if (series.seriesType === undefined && series.type === resolvedType) {
    // Already canonical (no alias present); avoid churning object identity.
    return series;
  }
  const { seriesType, ...rest } = series;
  return resolvedType === undefined ? rest : { ...rest, type: resolvedType };
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

  return {
    doc: {
      ...baseDoc,
      ...docOverrides,
      dashboard: {
        ...baseDoc.dashboard,
        ...docOverrides?.dashboard,
      },
    },
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
        selectedFieldId: sessionOverrides?.shell?.selectedFieldId ?? null,
        selectedSourceId: sessionOverrides?.shell?.selectedSourceId ?? null,
      },
    },
    runtime: {
      ...baseRuntime,
      ...runtimeOverrides,
    },
  };
}
