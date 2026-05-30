// ─── Studio (root component) ──────────────────────────────────────────────────
export { Studio } from './Studio/Studio';
export type { StudioProps, StudioHandle, StudioSlots } from './Studio/Studio';

// ─── StudioDashboard (embed-first entry point) ────────────────────────────────
export { StudioDashboard } from './Studio/StudioDashboard';
export type { StudioDashboardProps } from './Studio/StudioDashboard';

// ─── StudioCanvas ─────────────────────────────────────────────────────────────
export { StudioCanvas } from './StudioCanvas/StudioCanvas';
export type { StudioCanvasProps } from './StudioCanvas/StudioCanvas';
export { StudioDateRangeBar } from './StudioCanvas/StudioDateRangeBar';

// ─── StudioWidgetCard ─────────────────────────────────────────────────────────
export { StudioWidgetCard } from './StudioWidgetCard/StudioWidgetCard';
export type { StudioWidgetCardProps } from './StudioWidgetCard/StudioWidgetCard';

// ─── StudioNoDataOverlay ──────────────────────────────────────────────────────
export { StudioNoDataOverlay } from './internals/StudioNoDataOverlay';
export type { StudioNoDataOverlayProps } from './internals/StudioNoDataOverlay';

// ─── StudioGridWidget ─────────────────────────────────────────────────────────
export { StudioGridWidget } from './StudioGridWidget/StudioGridWidget';
export type { StudioGridWidgetProps } from './StudioGridWidget/StudioGridWidget';

// ─── StudioChartWidget ────────────────────────────────────────────────────────
export { StudioChartWidget, CHART_MIN_HEIGHT } from './StudioChartWidget/StudioChartWidget';
export type {
  StudioChartWidgetProps,
  StudioChartWidgetSlots,
  StudioChartWidgetSlotProps,
} from './StudioChartWidget/StudioChartWidget';

// ─── StudioKpiWidget ──────────────────────────────────────────────────────────
export { StudioKpiWidget } from './StudioKpiWidget/StudioKpiWidget';
export type {
  StudioKpiWidgetProps,
  StudioKpiWidgetSlots,
  StudioKpiWidgetSlotProps,
} from './StudioKpiWidget/StudioKpiWidget';

// ─── StudioTextWidget ─────────────────────────────────────────────────────────
export { StudioTextWidget } from './StudioTextWidget/StudioTextWidget';
export type { StudioTextWidgetProps } from './StudioTextWidget/StudioTextWidget';

// ─── StudioFilterWidget ───────────────────────────────────────────────────────
export { StudioFilterWidget } from './StudioFilterWidget/StudioFilterWidget';
export type {
  StudioFilterWidgetProps,
  StudioFilterWidgetSlots,
  StudioFilterWidgetSlotProps,
  StudioFilterDateRangeControlProps,
  StudioFilterMultiSelectControlProps,
  StudioFilterToggleControlProps,
  StudioFilterSliderControlProps,
} from './StudioFilterWidget/StudioFilterWidget';

// ─── StudioPivotWidget ────────────────────────────────────────────────────────
export { StudioPivotWidget } from './StudioPivotWidget/StudioPivotWidget';
export type { StudioPivotWidgetProps } from './StudioPivotWidget/StudioPivotWidget';

// ─── StudioMapWidget ──────────────────────────────────────────────────────────
export { StudioMapWidget } from './StudioMapWidget';
export type { StudioMapWidgetProps } from './StudioMapWidget';

// ─── StudioDataDrawer ─────────────────────────────────────────────────────────
export { StudioDataDrawer } from './StudioDataDrawer/StudioDataDrawer';

// ─── StudioComposeDrawer ──────────────────────────────────────────────────────
export { StudioComposeDrawer } from './StudioComposeDrawer/StudioComposeDrawer';
export type { StudioComposeDrawerProps } from './StudioComposeDrawer/StudioComposeDrawer';
export { InlineFormulaBar } from './StudioComposeDrawer/InlineFormulaBar';
export type { InlineFormulaBarProps } from './StudioComposeDrawer/InlineFormulaBar';

// ─── StudioFiltersDrawer ──────────────────────────────────────────────────────
export { StudioFiltersDrawer } from './StudioFiltersDrawer/StudioFiltersDrawer';

// ─── StudioDrilldownDrawer ────────────────────────────────────────────────────
export { StudioDrilldownDrawer } from './StudioDrilldownDrawer/StudioDrilldownDrawer';
export type { StudioDrilldownDrawerProps } from './StudioDrilldownDrawer/StudioDrilldownDrawer';

// ─── StudioExpressionFieldDialog ──────────────────────────────────────────────
export { StudioExpressionFieldDialog } from './StudioExpressionFieldDialog/StudioExpressionFieldDialog';
export type { StudioExpressionFieldDialogProps } from './StudioExpressionFieldDialog/StudioExpressionFieldDialog';

// ─── Context / Provider ───────────────────────────────────────────────────────
export {
  StudioProvider,
  useStudioController,
  useStudioSelector,
  useStudioState,
  useStudioFeatures,
  useStudioUIConfig,
  useStudioLocaleText,
  CanvasScrollContext,
} from './context/StudioContext';
export type { StudioProviderProps } from './context/StudioContext';
export type { StudioLocaleText } from './internals/StudioUIConfigContext';
export { DEFAULT_STUDIO_LOCALE_TEXT } from './internals/StudioUIConfigContext';

// ─── Locales ─────────────────────────────────────────────────────────────────
export { ptBRLocaleText } from './locales/ptBR';

// ─── Selectors ────────────────────────────────────────────────────────────────
export {
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
  selectWidgets,
  selectMode,
  selectShell,
  selectActivePageId,
  selectPages,
  selectDashboard,
  selectActivePage,
  selectPartitionedFilters,
  makeSelectActiveInteractiveFilter,
  makeSelectExpressionFieldsForSource,
  makeSelectExpressionFieldsForSources,
} from './context/selectors';
export type { PartitionedFilters } from './context/selectors';

// ─── DrawerPanel (composable sidebar panel) ───────────────────────────────────
export { DrawerPanel } from './Studio/DrawerPanel';
export type { DrawerPanelProps } from './Studio/DrawerPanel';
export {
  useDrawerSubheader,
  DrawerSubheaderContext,
  DRAWER_WIDTH,
  COLLAPSED_WIDTH,
} from './Studio/DrawerPanelContext';
export type { DrawerSubheaderContextValue } from './Studio/DrawerPanelContext';

// ─── TabbedSidebar (alternative tabbed sidebar layout) ────────────────────────
export { TabbedSidebar } from './Studio/TabbedSidebar';
export type { TabbedSidebarProps, TabbedSidebarPanel } from './Studio/TabbedSidebar';

// ─── Keyboard shortcuts hook ──────────────────────────────────────────────────
export { useStudioKeyboardShortcuts } from './internals/useStudioKeyboardShortcuts';

// ─── Widget utilities (composable API helpers) ────────────────────────────────
export { WIDGET_TYPES, createDefaultWidget } from './internals/widgetUtils';

// ─── Controller ───────────────────────────────────────────────────────────────
export { StudioController, createStudioController } from './store/StudioController';
export { createDefaultStudioState } from './models';

// ─── State persistence ────────────────────────────────────────────────────────
export {
  serializeState,
  deserializeState,
  migrateState,
} from './store/statePersistence';
export type { SerializedStudioState, MigrationResult } from './store/statePersistence';

// ─── Models / domain types ────────────────────────────────────────────────────
export type {
  StudioState,
  StudioMode,
  StudioPage,
  StudioPageTheme,
  StudioDashboardState,
  StudioShellState,
  StudioDrawer,
  StudioWidget,
  StudioWidgetKind,
  StudioWidgetConfig,
  StudioDataSource,
  StudioDataField,
  StudioRelationship,
  StudioFilterState,
  StudioFilterOperator,
  StudioMetricRef,
  StudioKpiAggregation,
  StudioGridSummaryAggregation,
  StudioGridColumnAggFn,
  StudioGridColumn,
  normalizeGridColumn,
  StudioNumberFormat,
  StudioChartType,
  StudioChartSeries,
  StudioBarLayout,
  StudioExpressionField,
  StudioExpression,
  StudioValueExpression,
  StudioFunctionExpression,
  StudioFieldExpression,
  StudioJoinFieldExpression,
  StudioExpressionOperator,
  StudioFilterWidgetType,
  // Async adapter types
  StudioFilterNode,
  StudioQueryDescriptor,
  StudioQueryResult,
  StudioDataSourceAdapter,
  StudioFeatureFlags,
  StudioChartAnnotation,
  StudioDateRangePreset,
} from './models';

// ─── Utility types ────────────────────────────────────────────────────────────
export type { RelativeDateValue, RelativeDateUnit } from './internals/filterTypes';

// ─── Dashboard date range ──────────────────────────────────────────────────────
export { computeDateRangePreset } from './store/StudioController';

// ─── Schema version ───────────────────────────────────────────────────────────
export { CURRENT_SCHEMA_VERSION } from './store/statePersistence';

// ─── Brand ───────────────────────────────────────────────────────────────────
export { StudioWordmark } from './icons/StudioWordmark';
export type { StudioWordmarkProps } from './icons/StudioWordmark';

// ─── AI / Chat ────────────────────────────────────────────────────────────────
export { StudioChatPanel } from './StudioChatPanel/StudioChatPanel';
export type {
  StudioChatPanelProps,
  StudioChatPanelSlotProps,
} from './StudioChatPanel/StudioChatPanel';
export { createStudioChatAdapter } from './StudioChatPanel/studioAdapter';
export type { StudioAIConfig } from './StudioChatPanel/studioAdapter';
export { buildAISystemPrompt } from './internals/buildAISystemPrompt';
export { STUDIO_AI_TOOLS } from './StudioChatPanel/studioAITools';
export type { StudioAIToolName } from './StudioChatPanel/studioAITools';

// ─── Server adapter utilities ─────────────────────────────────────────────────
export { createBatchingAdapter } from './server/createBatchingAdapter';
export type { BatchingAdapterOptions } from './server/createBatchingAdapter';
export { createSimpleAdapter } from './server/createSimpleAdapter';
export type { SimpleAdapterOptions } from './server/createSimpleAdapter';
