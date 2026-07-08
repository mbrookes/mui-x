// ── Widget-kind registry (built-in + custom, unified) ───────────────────────
//
// Kind → component/setup-panel/capability dispatch used to be a hardcoded
// if/else chain repeated at every call site (`StudioWidgetCard`,
// `StudioComposeDrawer`, `StudioWidgetEditDialog`, `BuiltinWidgetPreview`),
// with one site (`StudioWidgetEditDialog`) missing custom-widget handling
// entirely. `BUILTIN_WIDGET_DEFS` registers every built-in kind using the same
// `StudioCustomWidgetDef` shape consumers already use for `customWidgets`, and
// `useWidgetDefMap()` layers custom defs over it so every dispatch site can do
// a single map lookup regardless of whether a kind is built-in or
// consumer-defined.
//
// These registry TYPES were split out of `StudioUIConfigContext.ts`;
// that file re-exports them so existing deep imports resolve unchanged.
//
// `BUILTIN_WIDGET_DEFS` and `useWidgetDefMap()` — the values that complete this
// registry — live in `internals/builtinWidgetDefs.ts`, NOT here. That file needs
// direct component references to every built-in widget/setup-panel, and those
// widget/setup-panel modules import hooks (`useStudioFeatures`, `useStudioGeographies`,
// `useStudioUIConfig`) back from the UI-config context file — so importing them there
// would create a real module cycle (in a couple of cases a literal self-cycle, e.g.
// `ChartSetupPanel.tsx` -> context -> `ChartSetupPanel.tsx`). That combination broke
// several existing tests that `vi.mock('../../context', ...)`, so the concrete
// component wiring is kept in a separate file that depends on the context but is never
// depended on by it.

import type * as React from 'react';
import type {
  StudioCustomWidgetDef,
  StudioCustomWidgetSetupPanelProps,
  StudioWidget,
  StudioDataSource,
  StudioChartAnnotation,
} from '../models';

/**
 * Normalized prop bag passed to a `StudioWidgetDef.component`. A superset of
 * every built-in kind's actual widget-component props, plus `extraProps` for
 * forwarding call-site-specific `slotProps` (currently only used by
 * `StudioWidgetCard`). Fields that only apply to specific kinds (e.g.
 * `chartContainerRef` for chart) are simply ignored by every other kind's
 * render wrapper.
 */
export interface StudioWidgetRenderProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  /** ID of the page the widget belongs to. Required by every built-in kind except `text`/`filter`. */
  pageId: string;
  /** Chart only: pixel height of the rendered chart area. */
  height?: number;
  /** Chart only: whether client-side anomaly detection is active. */
  anomalyEnabled?: boolean;
  /** Chart only: called with the detected anomaly annotations. */
  onAnomalyDetected?: (annotations: StudioChartAnnotation[]) => void;
  /** Chart only: ref to the element wrapping the chart's rendered SVG (used for PNG export). */
  chartContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Text only: ref exposing an imperative AI-content-refresh function. */
  aiRefreshRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Ref exposing an imperative export function once data is available. Populated by pivot
   * internally, or by a custom widget kind that declares `export` (see
   * `StudioCustomWidgetDef.export` / `StudioCustomWidgetProps.exportRef`).
   */
  exportRef?: React.MutableRefObject<(() => void) | null>;
  /** Extra props forwarded from a call site's per-kind `slotProps` (e.g. `StudioWidgetCardProps.slotProps`). */
  extraProps?: Record<string, unknown>;
}

/**
 * Capability flags consolidating what used to be scattered
 * `widget.kind === '…'` conditionals at each dispatch site (export
 * availability, AI-insight eligibility, card min-height, …).
 */
export interface StudioWidgetCapabilities {
  /** Export format offered in the widget card action overlay. Omit to disable export for this kind. */
  export?: 'csv' | 'png';
  /** Whether the full-screen "expand" dialog is available (chart only today). */
  expand?: boolean;
  /** Whether the edit dialog's Filters tab / widget-filters panel applies to this kind. */
  widgetFilters?: boolean;
  /** Fixed `minHeight` (px) applied to the widget card's outer Paper shell. */
  minHeight?: number;
  /** Extra `sx` merged onto the Box wrapping the rendered widget content. */
  contentSx?: object;
  /** Height (px) of the Skeleton placeholder shown before first paint. May read the widget's own config. */
  skeletonHeight?: (widget: StudioWidget) => number;
}

/**
 * Registration record for a widget kind — built-in or custom — consumed by
 * every kind-dispatch site. Mirrors {@link StudioCustomWidgetDef} (the
 * existing `customWidgets` registration shape): `kind`/`label`/`description`/
 * `icon`/`requiresDataSource`/`fullBleed`/`shouldHide`/`defaultConfig`/
 * `aiInsight` are inherited unchanged, `component`/`setupPanel` get the
 * normalized signatures built-ins need, and `capabilities` adds the
 * additional per-kind flags built-ins require beyond what custom widgets
 * already support.
 */
export interface StudioWidgetDef extends Omit<StudioCustomWidgetDef, 'component' | 'setupPanel'> {
  component: React.ComponentType<StudioWidgetRenderProps>;
  setupPanel?: React.ComponentType<StudioCustomWidgetSetupPanelProps>;
  capabilities: StudioWidgetCapabilities;
}
