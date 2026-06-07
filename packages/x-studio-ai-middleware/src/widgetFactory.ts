/**
 * Factory for default StudioWidget instances.
 *
 * This is a pure function with no React dependency — it creates plain
 * StudioWidget objects for use in server-side tool execution.
 */
import type { StudioWidget, StudioWidgetKind } from '@mui/x-studio';

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

  if (kind === 'text') {
    return {
      id,
      kind,
      title: overrides?.title ?? 'Text block',
      config: {
        textSubtitle: '',
        textBody: '',
      },
    };
  }

  if (kind === 'grid') {
    return {
      id,
      kind,
      title: overrides?.title ?? '',
      config: { columns: [] },
    };
  }

  if (kind === 'chart') {
    return {
      id,
      kind,
      title: overrides?.title ?? '',
      config: { chartType: 'bar' },
    };
  }

  if (kind === 'filter') {
    return {
      id,
      kind,
      title: overrides?.title ?? 'Filter',
      config: { filterWidgetType: 'multi-select' as const },
    };
  }

  if (kind === 'pivot') {
    return {
      id,
      kind,
      title: overrides?.title ?? '',
      config: { pivotAggregation: 'sum' as const },
    };
  }

  if (kind === 'map') {
    return {
      id,
      kind,
      title: overrides?.title ?? '',
      config: { mapAggregation: 'sum' as const },
    };
  }

  if (!['grid', 'chart', 'kpi', 'text', 'filter', 'pivot', 'map'].includes(kind)) {
    // Custom widget kind
    return {
      id,
      kind,
      title: overrides?.title ?? kind,
      config: { customConfig: overrides?.customConfig ?? {} },
    };
  }

  // KPI
  return {
    id,
    kind,
    title: overrides?.title ?? '',
    config: { kpiAggregation: 'sum' },
  };
}
