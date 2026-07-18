'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import type {
  StudioCustomWidgetDef,
  StudioCustomWidgetSetupPanelProps,
  StudioWidgetOf,
} from '../models';
import type { BuiltinStudioWidgetKind } from '../models/baseTypes';
import {
  useStudioUIConfig,
  type StudioWidgetDef,
  type StudioWidgetRenderProps,
} from './StudioUIConfigContext';
// ── Widget-kind registry: built-in widget components + setup panels ─────────
// Deliberately kept OUT of `StudioUIConfigContext.ts`: these widget/setup-panel
// modules import hooks (`useStudioFeatures`, `useStudioGeographies`,
// `useStudioUIConfig`) from that file, so importing them there would create a
// module cycle (in a couple of cases a literal self-cycle, e.g.
// `ChartSetupPanel.tsx` -> `StudioUIConfigContext.ts` -> `ChartSetupPanel.tsx`),
// which breaks tests that `vi.mock('../../context', ...)`. This file depends on
// `StudioUIConfigContext.ts` (for `useStudioUIConfig` and the registry types)
// but is never imported back by it or by any widget/setup-panel module, so the
// dependency graph stays acyclic.
import { StudioGridWidget } from '../components/widgets/StudioGridWidget/StudioGridWidget';
import type { StudioGridWidgetProps } from '../components/widgets/StudioGridWidget/StudioGridWidget';
import { StudioChartWidget, CHART_MIN_HEIGHT } from '../components/widgets/StudioChartWidget';
import type { StudioChartWidgetProps } from '../components/widgets/StudioChartWidget';
import { StudioKpiWidget } from '../components/widgets/StudioKpiWidget';
import type { StudioKpiWidgetProps } from '../components/widgets/StudioKpiWidget/StudioKpiWidget';
import { StudioTextWidget } from '../components/widgets/StudioTextWidget';
import type { StudioTextWidgetProps } from '../components/widgets/StudioTextWidget/StudioTextWidget';
import { StudioFilterWidget } from '../components/widgets/StudioFilterWidget';
import type { StudioFilterWidgetProps } from '../components/widgets/StudioFilterWidget';
import { StudioPivotWidget } from '../components/widgets/StudioPivotWidget/StudioPivotWidget';
import { StudioMapWidget } from '../components/widgets/StudioMapWidget';
import { ChartSetupPanel } from '../components/StudioComposeDrawer/ChartSetupPanel';
import { GridSetupPanel } from '../components/StudioComposeDrawer/GridSetupPanel';
import { KpiSetupPanel } from '../components/StudioComposeDrawer/KpiSetupPanel';
import { TextSetupPanel } from '../components/StudioComposeDrawer/TextSetupPanel';
import { FilterSetupPanel } from '../components/StudioComposeDrawer/FilterSetupPanel';
import { PivotSetupPanel } from '../components/StudioComposeDrawer/PivotSetupPanel';
import { MapSetupPanel } from '../components/StudioComposeDrawer/MapSetupPanel';

const KPI_WIDGET_MIN_HEIGHT = 160;
const FILTER_WIDGET_MIN_HEIGHT = KPI_WIDGET_MIN_HEIGHT / 2;
const MAP_WIDGET_DEFAULT_HEIGHT = 400;

// ── Render wrappers ──────────────────────────────────────────────────────────

function GridWidgetRender(props: StudioWidgetRenderProps) {
  // The registry only ever invokes this wrapper for the `grid` kind, so the
  // widget is a grid widget — narrow `props.widget` (typed as the whole
  // `StudioWidget` union) to the precise per-kind type at this dispatch boundary.
  return React.createElement(StudioGridWidget, {
    widget: props.widget as StudioWidgetOf<'grid'>,
    dataSource: props.dataSource,
    pageId: props.pageId,
    ...(props.extraProps as Partial<
      Omit<StudioGridWidgetProps, 'widget' | 'dataSource' | 'pageId'>
    >),
  });
}

function ChartWidgetRender(props: StudioWidgetRenderProps) {
  const content = React.createElement(StudioChartWidget, {
    widget: props.widget as StudioWidgetOf<'chart'>,
    dataSource: props.dataSource,
    pageId: props.pageId,
    height: props.height ?? CHART_MIN_HEIGHT,
    anomalyEnabled: props.anomalyEnabled,
    onAnomalyDetected: props.onAnomalyDetected,
    ...(props.extraProps as Partial<
      Omit<StudioChartWidgetProps, 'widget' | 'dataSource' | 'pageId' | 'height'>
    >),
  });
  if (props.chartContainerRef) {
    return React.createElement(
      Box,
      { ref: props.chartContainerRef, sx: { minHeight: CHART_MIN_HEIGHT } },
      content,
    );
  }
  return content;
}

function KpiWidgetRender(props: StudioWidgetRenderProps) {
  return React.createElement(StudioKpiWidget, {
    widget: props.widget as StudioWidgetOf<'kpi'>,
    dataSource: props.dataSource,
    pageId: props.pageId,
    ...(props.extraProps as Partial<
      Omit<StudioKpiWidgetProps, 'widget' | 'dataSource' | 'pageId'>
    >),
  });
}

function TextWidgetRender(props: StudioWidgetRenderProps) {
  return React.createElement(StudioTextWidget, {
    widget: props.widget as StudioWidgetOf<'text'>,
    pageId: props.pageId,
    aiRefreshRef: props.aiRefreshRef,
    ...(props.extraProps as Partial<
      Omit<StudioTextWidgetProps, 'widget' | 'pageId' | 'aiRefreshRef'>
    >),
  });
}

function FilterWidgetRender(props: StudioWidgetRenderProps) {
  return React.createElement(StudioFilterWidget, {
    widget: props.widget as StudioWidgetOf<'filter'>,
    dataSource: props.dataSource,
    pageId: props.pageId,
    ...(props.extraProps as Partial<Omit<StudioFilterWidgetProps, 'widget' | 'dataSource'>>),
  });
}

function PivotWidgetRender(props: StudioWidgetRenderProps) {
  return React.createElement(StudioPivotWidget, {
    widget: props.widget as StudioWidgetOf<'pivot'>,
    dataSource: props.dataSource,
    pageId: props.pageId,
    exportRef: props.exportRef,
  });
}

function MapWidgetRender(props: StudioWidgetRenderProps) {
  return React.createElement(
    Box,
    { sx: { height: MAP_WIDGET_DEFAULT_HEIGHT } },
    props.dataSource
      ? React.createElement(StudioMapWidget, {
          widget: props.widget as StudioWidgetOf<'map'>,
          dataSource: props.dataSource,
          pageId: props.pageId,
        })
      : null,
  );
}

// ── Setup-panel wrappers ─────────────────────────────────────────────────────

function GridSetupPanelRender(props: StudioCustomWidgetSetupPanelProps) {
  return React.createElement(GridSetupPanel, { widgetId: props.widgetId });
}
function ChartSetupPanelRender(props: StudioCustomWidgetSetupPanelProps) {
  return React.createElement(ChartSetupPanel, { widgetId: props.widgetId });
}
function KpiSetupPanelRender(props: StudioCustomWidgetSetupPanelProps) {
  return React.createElement(KpiSetupPanel, { widgetId: props.widgetId });
}
function TextSetupPanelRender(props: StudioCustomWidgetSetupPanelProps) {
  return React.createElement(TextSetupPanel, { widgetId: props.widgetId });
}
function FilterSetupPanelRender(props: StudioCustomWidgetSetupPanelProps) {
  return React.createElement(FilterSetupPanel, { widgetId: props.widgetId });
}
function PivotSetupPanelRender(props: StudioCustomWidgetSetupPanelProps) {
  return React.createElement(PivotSetupPanel, { widgetId: props.widgetId });
}
function MapSetupPanelRender(props: StudioCustomWidgetSetupPanelProps) {
  return React.createElement(MapSetupPanel, { widgetId: props.widgetId });
}

/**
 * Registration for every built-in widget kind, keyed by kind. The `satisfies`
 * clause below makes a missed registration for a new `BuiltinStudioWidgetKind`
 * a compile error instead of a silent runtime gap (previously each of the 4+
 * hardcoded dispatch sites had to be remembered independently).
 */
export const BUILTIN_WIDGET_DEFS = {
  grid: {
    kind: 'grid',
    label: 'Table',
    component: GridWidgetRender,
    setupPanel: GridSetupPanelRender,
    aiInsight: true,
    capabilities: {
      export: 'csv',
      widgetFilters: true,
      skeletonHeight: (widget) => (widget as StudioWidgetOf<'grid'>).config.gridHeight ?? 400,
    },
  },
  chart: {
    kind: 'chart',
    label: 'Chart',
    component: ChartWidgetRender,
    setupPanel: ChartSetupPanelRender,
    aiInsight: true,
    capabilities: {
      export: 'png',
      expand: true,
      widgetFilters: true,
      skeletonHeight: () => CHART_MIN_HEIGHT,
    },
  },
  kpi: {
    kind: 'kpi',
    label: 'KPI',
    component: KpiWidgetRender,
    setupPanel: KpiSetupPanelRender,
    aiInsight: false,
    capabilities: {
      widgetFilters: true,
      minHeight: KPI_WIDGET_MIN_HEIGHT,
      contentSx: { flexGrow: 1, minHeight: 0 },
      skeletonHeight: () => KPI_WIDGET_MIN_HEIGHT - 48,
    },
  },
  text: {
    kind: 'text',
    label: 'Text',
    component: TextWidgetRender,
    setupPanel: TextSetupPanelRender,
    aiInsight: false,
    requiresDataSource: false,
    capabilities: {
      widgetFilters: false,
      skeletonHeight: () => 60,
    },
  },
  filter: {
    kind: 'filter',
    label: 'Filter',
    component: FilterWidgetRender,
    setupPanel: FilterSetupPanelRender,
    aiInsight: false,
    capabilities: {
      widgetFilters: true,
      minHeight: FILTER_WIDGET_MIN_HEIGHT,
      skeletonHeight: () => FILTER_WIDGET_MIN_HEIGHT - 48,
    },
  },
  pivot: {
    kind: 'pivot',
    label: 'Pivot Table',
    component: PivotWidgetRender,
    setupPanel: PivotSetupPanelRender,
    aiInsight: true,
    capabilities: {
      export: 'csv',
      widgetFilters: true,
      skeletonHeight: () => 300,
    },
  },
  map: {
    kind: 'map',
    label: 'Map',
    component: MapWidgetRender,
    setupPanel: MapSetupPanelRender,
    aiInsight: true,
    capabilities: {
      widgetFilters: true,
      skeletonHeight: () => MAP_WIDGET_DEFAULT_HEIGHT,
    },
  },
} satisfies Record<BuiltinStudioWidgetKind, StudioWidgetDef>;

/** Converts a consumer-registered custom widget def into the unified `StudioWidgetDef` shape. */
function toWidgetDef(def: StudioCustomWidgetDef): StudioWidgetDef {
  return {
    ...def,
    // A custom widget's `component` only ever reads `widget`/`dataSource`/`exportRef` (see
    // `StudioCustomWidgetProps`) — every other `StudioWidgetRenderProps` field is simply
    // ignored at runtime, so widening the prop type here is safe.
    component: def.component as unknown as React.ComponentType<StudioWidgetRenderProps>,
    // `export` is the one capability a custom widget def declares directly (see
    // `StudioCustomWidgetDef.export`); every other capability is a built-in-only concept.
    capabilities: { export: def.export },
  };
}

/**
 * Returns the unified widget-kind registry: every built-in kind plus any
 * consumer-registered `customWidgets`, keyed by `kind`. Custom entries take
 * precedence over a built-in of the same name (mirrors `useStudioGeographies`'
 * override behavior), though built-in kind strings should not normally be
 * reused by consumers.
 *
 * This is the single lookup every kind-dispatch site should use — built-in and
 * custom kinds are otherwise indistinguishable to callers.
 */
export function useWidgetDefMap(): ReadonlyMap<string, StudioWidgetDef> {
  const { customWidgets } = useStudioUIConfig();
  // Depend on `customWidgets` itself (not a derived key). A prior version keyed
  // this memo on `JSON.stringify(customWidgets?.map(d => d.kind))` — a proxy that
  // only tracked the SET of registered kind strings. That went stale whenever a
  // consumer updated a custom widget def's actual content (swapped `component`,
  // changed `capabilities`, etc.) without adding/removing a kind: the kind list
  // was unchanged, so the memo never recomputed and callers kept reading the old
  // def. Keying on the array reference directly recomputes whenever the caller
  // passes a new `customWidgets` value, which is the correct signal for content
  // changes (a consumer that mutates a def in place without producing a new
  // array reference is already outside React's change-detection contract).
  return React.useMemo(() => {
    const map = new Map<string, StudioWidgetDef>(Object.entries(BUILTIN_WIDGET_DEFS));
    for (const def of customWidgets ?? []) {
      map.set(def.kind, toWidgetDef(def));
    }
    return map;
  }, [customWidgets]);
}
