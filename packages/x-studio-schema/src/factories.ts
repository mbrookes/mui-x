/**
 * Pure factories for default Studio domain objects.
 *
 * No React dependency — creates plain objects. Shared by the client UI
 * (`@mui/x-studio`) and server tool execution (`@mui/x-studio-ai-middleware`) so
 * UI-created and AI-created objects get identical defaults.
 */
import type { BuiltinStudioWidgetKind, StudioWidgetKind } from './baseTypes';
import type { StudioGridColumn, StudioWidget, StudioWidgetConfig } from './widgetTypes';
import type { StudioState } from './stateTypes';

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
  const id = `widget-${kind}-${Date.now()}`;

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
