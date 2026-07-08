/**
 * Rich AI context types for MUI X Studio.
 *
 * Extra, purely-additive context attached to each chat request to give the
 * model more signal without any user effort. Shared by both the client
 * (`@mui/x-studio`) and the server (`@mui/x-studio-ai-middleware`).
 */

/**
 * Summary statistics for a single data-source field, computed client-side from
 * pipeline-filtered rows. Numeric fields carry `min`/`max`/`mean`; all other
 * field types carry a `distinctCount`.
 */
export interface StudioAIFieldStat {
  /** Field data type, copied from `StudioDataField['type']`. */
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /** Minimum value (numeric fields only). */
  min?: number;
  /** Maximum value (numeric fields only). */
  max?: number;
  /** Arithmetic mean, rounded (numeric fields only). */
  mean?: number;
  /** Number of distinct values (non-numeric fields). */
  distinctCount?: number;
  /** Number of rows the statistics were computed from. */
  sampledRows: number;
}

/** A single widget entry in the active-page layout snapshot. */
export interface StudioAILayoutWidget {
  widgetId: string;
  kind: string;
  title: string;
  chartType?: string;
  colSpan?: number;
}

/** An edge in the cross-filter graph: a widget whose selection filters the page. */
export interface StudioAICrossFilterEdge {
  sourceWidgetId: string;
  field: string;
  scope: 'cross-filter' | 'interactive';
}

/** Active-page widget layout plus its cross-filter graph. */
export interface StudioAIPageLayout {
  pageId: string;
  /** Widget rows, mirroring `StudioPage.widgetRows` but enriched per widget. */
  rows: StudioAILayoutWidget[][];
  /** Cross-filter / interactive-filter edges currently active on the page. */
  crossFilters: StudioAICrossFilterEdge[];
}

/** A compact record of one user-driven state mutation. */
export interface StudioAIRecentMutation {
  /** Short label, e.g. `"addFilter:revenue"` or `"updateWidgetConfig:chart-3"`. */
  label: string;
  /** ISO 8601 timestamp of when the mutation was committed. */
  at: string;
}

/**
 * Extra client-derived context attached to each AI chat request to give the
 * model more signal without any user effort. Every section is optional: the
 * client drops lower-priority sections (recent mutations first, then layout)
 * to stay under a token budget, recording dropped section names in `omitted`.
 *
 * Never sent in `privateMode` — field statistics expose real data values.
 */
export interface StudioAIRichContext {
  /** Per-field summary statistics, keyed by `${sourceId}.${fieldId}`. */
  fieldStats?: Record<string, StudioAIFieldStat>;
  /** Active page widget layout and cross-filter graph. */
  pageLayout?: StudioAIPageLayout;
  /** Most recent user-driven mutations, oldest first. */
  recentMutations?: StudioAIRecentMutation[];
  /** Names of sections dropped to fit the token budget (for prompt honesty). */
  omitted?: string[];
}
