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
import type { StudioState } from './stateTypes';

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

  if (!(kind in BUILTIN_WIDGET_DEFAULTS)) {
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

export function createDefaultStudioState(overrides?: Partial<StudioState>): StudioState {
  const baseState: StudioState = {
    schemaVersion: 1,
    mode: 'edit',
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
    dataSources: {},
    relationships: [],
    filters: [],
    expressionFields: [],
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

  return {
    ...baseState,
    ...overrides,
    dashboard: {
      ...baseState.dashboard,
      ...overrides?.dashboard,
    },
    shell: {
      ...baseState.shell,
      ...overrides?.shell,
      openDrawers: {
        ...baseState.shell.openDrawers,
        ...overrides?.shell?.openDrawers,
      },
      selectedFieldId: overrides?.shell?.selectedFieldId ?? null,
      selectedSourceId: overrides?.shell?.selectedSourceId ?? null,
    },
    pages: overrides?.pages ?? baseState.pages,
    widgets: overrides?.widgets ?? baseState.widgets,
    dataSources: overrides?.dataSources ?? baseState.dataSources,
    relationships: overrides?.relationships ?? baseState.relationships,
    filters: overrides?.filters ?? baseState.filters,
    expressionFields: overrides?.expressionFields ?? baseState.expressionFields,
  };
}
