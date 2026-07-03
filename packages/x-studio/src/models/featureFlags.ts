// UI feature-flag types for `<Studio>` / `<StudioProvider>`.
//
// These describe component props (which parts of the authoring UI to show), not
// persisted `StudioState` or the AI protocol, so they live in `@mui/x-studio`
// rather than the shared, dependency-free `@mui/x-studio-schema` package.

/**
 * Runtime feature flags for the Studio dashboard.
 * All flags default to `true` (feature enabled) when not specified.
 *
 * Pass via the `featureFlags` prop on `<Studio>` or `<StudioProvider>`.
 */

/**
 * Feature sub-flags for KPI widgets.
 * Passed as the value of `featureFlags.kpi` to selectively disable individual KPI features
 * while keeping the KPI widget kind available in the widget picker.
 *
 * @example
 * // Disable sparkline and trend but keep KPI otherwise enabled:
 * <Studio featureFlags={{ kpi: { sparkline: false, trend: false } }} />
 */
export interface KpiFeatureFlags {
  /**
   * Show the sparkline configuration section in the KPI setup panel.
   * @default true
   */
  sparkline?: boolean;
  /**
   * Show the period-over-period trend indicator configuration in the KPI setup panel.
   * @default true
   */
  trend?: boolean;
  /**
   * Show the "Add calculated field" button in the KPI setup panel.
   * Has no effect when the global `calculatedFields` flag is `false`.
   * @default true
   */
  calculatedFields?: boolean;
}

/**
 * Feature sub-flags for chart widgets.
 * Passed as the value of `featureFlags.chart` to selectively disable individual chart features
 * while keeping the chart widget kind available.
 *
 * @example
 * // Disable annotations but keep charts otherwise enabled:
 * <Studio featureFlags={{ chart: { annotations: false } }} />
 */
export interface ChartFeatureFlags {
  /**
   * Show the reference-line annotations configuration in the chart setup panel.
   * @default true
   */
  annotations?: boolean;
  /**
   * Show the "Add calculated field" button in the chart setup panel.
   * Has no effect when the global `calculatedFields` flag is `false`.
   * @default true
   */
  calculatedFields?: boolean;
}

/**
 * Feature sub-flags for table/grid widgets.
 * Passed as the value of `featureFlags.grid` to selectively disable individual grid features
 * while keeping the table widget kind available.
 *
 * @example
 * // Disable group-by and conditional formats but keep grid otherwise enabled:
 * <Studio featureFlags={{ grid: { groupBy: false, conditionalFormats: false } }} />
 */
export interface GridFeatureFlags {
  /**
   * Show the "Group by" field picker in the grid setup panel.
   * @default true
   */
  groupBy?: boolean;
  /**
   * Show the summary (totals) row configuration in the grid setup panel.
   * @default true
   */
  summary?: boolean;
  /**
   * Show the conditional formatting configuration in the grid setup panel.
   * @default true
   */
  conditionalFormats?: boolean;
  /**
   * Show the "Calculated column…" option in the table/grid setup panel's "Add column" menu.
   * Has no effect when the global `calculatedFields` flag is `false`.
   * @default true
   */
  calculatedFields?: boolean;
}

export interface StudioFeatureFlags {
  /**
   * Show the compose (edit) panel and data drawer, and allow switching to edit mode.
   * Set to `false` to lock the dashboard in a view-only, non-editable state.
   * @default true
   */
  compose?: boolean;
  /**
   * Show the filters sidebar panel and quick filter bar.
   * Set to `false` to hide all filter UI from end users.
   * @default true
   */
  filters?: boolean;
  /**
   * Show the date range / quick filter bar above the widget canvas.
   * This top-of-canvas bar provides quick date presets and active filter pills.
   * Set to `false` to hide the bar entirely (useful in composed layouts where
   * a custom filter toolbar is provided).
   * @default false
   */
  quickFilter?: boolean;
  /**
   * Show the cross-filter mode bar above the widget canvas.
   * This bar lets viewers select a global interaction mode (cross-filter,
   * cross-highlight, or per-chart) and toggle cross-filtering across all pages.
   * @default false
   */
  crossFilterBar?: boolean;
  /**
   * Allow saving and loading named filter presets ("Saved Views") in the filters panel.
   * @default true
   */
  savedFilterViews?: boolean;
  /**
   * Show the data drawer for managing data sources, fields, expression fields,
   * and relationships.
   * @default true
   */
  dataManagement?: boolean;
  /**
   * Show the relationship management panel in the data drawer.
   * Set to `false` to hide the "Relationships" section, preventing editors from
   * adding or removing cross-source join definitions.
   * @default true
   */
  relationships?: boolean;
  /**
   * Show the per-widget "Filters" tab in the widget edit dialog (`StudioWidgetEditDialog`).
   * Set to `false` to hide the widget-level filter conditions editor from editors.
   * @default true
   */
  widgetFilters?: boolean;
  /**
   * Enable the AI chat assistant panel.
   * Requires `aiConfig` to also be provided — this flag only controls visibility.
   * @default true
   */
  aiChat?: boolean;
  /**
   * Enable the per-widget AI insight features (the "AI insight" button and chart anomaly
   * detection/explanation). Requires `aiConfig` to also be provided — this flag only controls
   * visibility. Set to `false` to keep the AI chat assistant while hiding per-widget AI actions.
   * @default true
   */
  aiInsights?: boolean;
  /**
   * Allow exporting widget data from the card action menu — CSV for table/pivot widgets and
   * PNG for charts. Set to `false` to remove the export button in both edit and view modes
   * (useful when the underlying data must not leave the dashboard).
   * @default true
   */
  export?: boolean;

  // ── Widget kind availability ───────────────────────────────────────────────

  /**
   * Allow adding table/grid widgets.
   * - `false`: hides grid from the widget picker entirely.
   * - An object: enables the widget kind but selectively disables sub-features.
   *   See {@link GridFeatureFlags} for available sub-flags.
   * @default true
   */
  grid?: boolean | GridFeatureFlags;
  /**
   * Allow adding chart widgets.
   * - `false`: hides chart from the widget picker entirely.
   * - An object: enables the widget kind but selectively disables sub-features.
   *   See {@link ChartFeatureFlags} for available sub-flags.
   * @default true
   */
  chart?: boolean | ChartFeatureFlags;
  /**
   * Allow adding KPI widgets.
   * - `false`: hides KPI from the widget picker entirely.
   * - An object: enables the widget kind but selectively disables sub-features.
   *   See {@link KpiFeatureFlags} for available sub-flags.
   * @default true
   */
  kpi?: boolean | KpiFeatureFlags;
  /**
   * Allow adding text/markdown widgets. Set to `false` to hide text from the widget picker.
   * @default true
   */
  text?: boolean;
  /**
   * Allow adding interactive filter widgets. Set to `false` to hide filter widgets from the picker.
   * @default true
   */
  filter?: boolean;
  /**
   * Allow adding pivot table widgets. Set to `false` to hide pivot from the widget picker.
   * @default true
   */
  pivot?: boolean;
  /**
   * Allow adding choropleth map widgets. Set to `false` to hide map from the widget picker.
   * @default true
   */
  map?: boolean;
  // ── Calculated fields ──────────────────────────────────────────────────────

  /**
   * Master switch for calculated (expression) fields across all widget types.
   * Set to `false` to hide the "Add calculated field" button from all widget setup panels,
   * preventing editors from creating new expression-based columns or measures.
   * Existing expression fields that are already in use remain functional.
   * @default true
   */
  calculatedFields?: boolean;
}
