import type * as React from 'react';
import type { StudioDataSource, StudioWidget } from '.';

/**
 * Props passed to a custom widget's render component.
 *
 * `dataSource` is the raw data source assigned to the widget (if any).
 * For access to filtered rows, cross-filter state, or other runtime data,
 * use the `useStudioSelector` hook inside your component.
 */
export interface StudioCustomWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

/**
 * Props passed to a custom widget's optional compose-drawer setup panel.
 *
 * Use `useStudioController()` inside your panel component and call
 * `controller.updateWidgetConfig(widgetId, { customConfig: { ...changes } })`
 * to persist changes into the widget state.
 */
export interface StudioCustomWidgetSetupPanelProps {
  widgetId: string;
}

/**
 * Registration record for a consumer-defined custom widget kind.
 *
 * Pass an array of these as `customWidgets` on `<Studio>`, `<StudioProvider>`,
 * or `<StudioDashboard>`.
 *
 * @example
 * ```tsx
 * const alertWidget: StudioCustomWidgetDef = {
 *   kind: 'acme-alert',
 *   label: 'Alert Banner',
 *   description: 'Coloured alert box with configurable message',
 *   icon: <NotificationsIcon />,
 *   component: AlertBannerWidget,
 *   setupPanel: AlertBannerSetupPanel,
 * };
 *
 * <Studio customWidgets={[alertWidget]} ... />
 * ```
 */
export interface StudioCustomWidgetDef {
  /**
   * Unique identifier for this widget kind.
   * Use namespaced strings to avoid collisions with built-in kinds
   * and other custom widgets (e.g. `'acme-weather'`, `'my-org-gauge'`).
   */
  kind: string;
  /** Display name shown in the widget picker. */
  label: string;
  /** Short description shown below the label in the widget picker. */
  description?: string;
  /** Icon element (24–32 px) shown in the widget picker. */
  icon?: React.ReactNode;
  /**
   * The React component that renders the widget on the canvas.
   * Receives the widget model and its data source.
   */
  component: React.ComponentType<StudioCustomWidgetProps>;
  /**
   * Optional compose-drawer setup panel for editing the widget's `customConfig`.
   * When omitted, the widget appears in the picker but has no editable settings.
   */
  setupPanel?: React.ComponentType<StudioCustomWidgetSetupPanelProps>;
  /**
   * Whether a data source must be selected before this widget can be created.
   * When `true`, the widget picker's data-source selector is shown just like for
   * chart/grid/kpi widgets.
   * @default false
   */
  requiresDataSource?: boolean;
  /**
   * Whether the AI insights icon should be shown on this widget's action overlay.
   * Only meaningful when an `aiConfig` endpoint is configured on `<Studio>`.
   * @default false
   */
  aiInsight?: boolean;
  /**
   * Default `config.customConfig` values written when a new widget of this kind is created.
   * Must contain only JSON-serializable values.
   */
  defaultConfig?: Record<string, unknown>;
}
