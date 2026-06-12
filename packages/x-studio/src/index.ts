// ─── Studio (root component) ──────────────────────────────────────────────────
export { Studio } from './components/Studio/Studio';
export type { StudioProps, StudioHandle, StudioSlots } from './components/Studio/Studio';

// ─── StudioDashboard (embed-first entry point) ────────────────────────────────
export { StudioDashboard } from './components/Studio/StudioDashboard';
export type { StudioDashboardProps } from './components/Studio/StudioDashboard';

// ─── StudioCanvas ─────────────────────────────────────────────────────────────
export { StudioCanvas } from './components/StudioCanvas/StudioCanvas';
export type { StudioCanvasProps } from './components/StudioCanvas/StudioCanvas';
export { StudioDateRangeBar } from './components/StudioCanvas/StudioDateRangeBar';

// ─── StudioWidgetCard ─────────────────────────────────────────────────────────
export { StudioWidgetCard } from './components/StudioWidgetCard/StudioWidgetCard';
export type { StudioWidgetCardProps } from './components/StudioWidgetCard/StudioWidgetCard';

// ─── StudioWidgetEditDialog ───────────────────────────────────────────────────
export { StudioWidgetEditDialog } from './components/StudioWidgetEditDialog';
export type { StudioWidgetEditDialogProps } from './components/StudioWidgetEditDialog';

// ─── StudioNoDataOverlay ──────────────────────────────────────────────────────
export { StudioNoDataOverlay } from './internals/StudioNoDataOverlay';
export type { StudioNoDataOverlayProps } from './internals/StudioNoDataOverlay';

// ─── StudioGridWidget ─────────────────────────────────────────────────────────
export { StudioGridWidget } from './components/widgets/StudioGridWidget/StudioGridWidget';
export type { StudioGridWidgetProps } from './components/widgets/StudioGridWidget/StudioGridWidget';

// ─── StudioChartWidget ────────────────────────────────────────────────────────
export {
  StudioChartWidget,
  CHART_MIN_HEIGHT,
} from './components/widgets/StudioChartWidget/StudioChartWidget';
export type {
  StudioChartWidgetProps,
  StudioChartWidgetSlots,
  StudioChartWidgetSlotProps,
} from './components/widgets/StudioChartWidget/StudioChartWidget';

// ─── StudioKpiWidget ──────────────────────────────────────────────────────────
export { StudioKpiWidget } from './components/widgets/StudioKpiWidget/StudioKpiWidget';
export type {
  StudioKpiWidgetProps,
  StudioKpiWidgetSlots,
  StudioKpiWidgetSlotProps,
} from './components/widgets/StudioKpiWidget/StudioKpiWidget';

// ─── StudioTextWidget ─────────────────────────────────────────────────────────
export { StudioTextWidget } from './components/widgets/StudioTextWidget/StudioTextWidget';
export type { StudioTextWidgetProps } from './components/widgets/StudioTextWidget/StudioTextWidget';

// ─── StudioFilterWidget ───────────────────────────────────────────────────────
export { StudioFilterWidget } from './components/widgets/StudioFilterWidget/StudioFilterWidget';
export type {
  StudioFilterWidgetProps,
  StudioFilterWidgetSlots,
  StudioFilterWidgetSlotProps,
  StudioFilterDateRangeControlProps,
  StudioFilterMultiSelectControlProps,
  StudioFilterToggleControlProps,
  StudioFilterSliderControlProps,
} from './components/widgets/StudioFilterWidget/StudioFilterWidget';

// ─── StudioPivotWidget ────────────────────────────────────────────────────────
export { StudioPivotWidget } from './components/widgets/StudioPivotWidget/StudioPivotWidget';
export type { StudioPivotWidgetProps } from './components/widgets/StudioPivotWidget/StudioPivotWidget';

// ─── StudioMapWidget ──────────────────────────────────────────────────────────
export { StudioMapWidget } from './components/widgets/StudioMapWidget';
export type { StudioMapWidgetProps } from './components/widgets/StudioMapWidget';
export type {
  GeographyLoader,
  StudioMapGeographyDefinition,
} from './components/widgets/StudioMapWidget/geographyLoaders';

// ─── StudioDataDrawer ─────────────────────────────────────────────────────────
export { StudioDataDrawer } from './components/StudioDataDrawer/StudioDataDrawer';
export type { StudioDataDrawerProps } from './components/StudioDataDrawer/StudioDataDrawer';

// ─── StudioComposeDrawer ──────────────────────────────────────────────────────
export { StudioComposeDrawer } from './components/StudioComposeDrawer/StudioComposeDrawer';
export type { StudioComposeDrawerProps } from './components/StudioComposeDrawer/StudioComposeDrawer';
export { InlineFormulaBar } from './components/StudioComposeDrawer/InlineFormulaBar';
export type { InlineFormulaBarProps } from './components/StudioComposeDrawer/InlineFormulaBar';

// ─── StudioFiltersDrawer ──────────────────────────────────────────────────────
export { StudioFiltersDrawer } from './components/StudioFiltersDrawer/StudioFiltersDrawer';
export type { StudioFiltersDrawerProps } from './components/StudioFiltersDrawer/StudioFiltersDrawer';

// ─── StudioExpressionFieldDialog ──────────────────────────────────────────────
export { StudioExpressionFieldDialog } from './components/StudioExpressionFieldDialog/StudioExpressionFieldDialog';
export type { StudioExpressionFieldDialogProps } from './components/StudioExpressionFieldDialog/StudioExpressionFieldDialog';

// ─── Context / Provider ───────────────────────────────────────────────────────
export {
  StudioProvider,
  useStudioController,
  useStudioSelector,
  useStudioState,
  useStudioFeatures,
  useStudioUIConfig,
  useStudioLocaleText,
  useStudioGeographies,
  useCustomWidgetMap,
  CanvasScrollContext,
} from './context/StudioContext';
export type { StudioProviderProps } from './context/StudioContext';
export type { StudioLocaleText, ResolvedStudioFeatures } from './internals/StudioUIConfigContext';
export { DEFAULT_STUDIO_LOCALE_TEXT } from './internals/StudioUIConfigContext';

// ─── Locales ─────────────────────────────────────────────────────────────────
export { ptBRLocaleText, ptBR } from './locales/ptBR';
export { enUS } from './locales/enUS';
export type { Localization } from './locales/utils/getStudioLocalization';
export { getStudioLocalization } from './locales/utils/getStudioLocalization';

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
export { DrawerPanel } from './components/Studio/DrawerPanel';
export type { DrawerPanelProps } from './components/Studio/DrawerPanel';
export {
  useDrawerSubheader,
  DrawerSubheaderContext,
  DRAWER_WIDTH,
  COLLAPSED_WIDTH,
} from './components/Studio/DrawerPanelContext';
export type { DrawerSubheaderContextValue } from './components/Studio/DrawerPanelContext';

// ─── TabbedSidebar (alternative tabbed sidebar layout) ────────────────────────
export { TabbedSidebar } from './components/Studio/TabbedSidebar';
export type { TabbedSidebarProps, TabbedSidebarPanel } from './components/Studio/TabbedSidebar';

// ─── Keyboard shortcuts hook ──────────────────────────────────────────────────
export { useStudioKeyboardShortcuts } from './internals/useStudioKeyboardShortcuts';

// ─── Widget utilities (composable API helpers) ────────────────────────────────
export { WIDGET_TYPES, createDefaultWidget } from './internals/widgetUtils';

// ─── Controller ───────────────────────────────────────────────────────────────
export { StudioController, createStudioController } from './store/StudioController';
export { createDefaultStudioState } from './models';

// ─── State persistence ────────────────────────────────────────────────────────
export { serializeState, deserializeState, migrateState } from './store/statePersistence';
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
  KpiFeatureFlags,
  ChartFeatureFlags,
  GridFeatureFlags,
  BuiltinStudioWidgetKind,
  StudioChartAnnotation,
  StudioDateRangePreset,
  StudioCustomWidgetDef,
  StudioCustomWidgetProps,
  StudioCustomWidgetSetupPanelProps,
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
export { StudioChatPanel } from './components/StudioChatPanel/StudioChatPanel';
export type {
  StudioChatPanelProps,
  StudioChatPanelSlotProps,
} from './components/StudioChatPanel/StudioChatPanel';
export type { StudioAIConfig } from './components/StudioChatPanel/studioBackendAdapter';
export { createBackendChatAdapter } from './components/StudioChatPanel/studioBackendAdapter';
export { applyStateMutation } from './components/StudioChatPanel/applyStateMutation';
// AI protocol types — the minimal set the UI needs to consume SSE responses and accept config.
// StudioAISkill (with server-side execute) and skill implementations live in @mui/x-studio-ai-middleware.
export type { StateMutation, SerializableSkill, StudioAIToolName } from './models/aiTypes';
export {
  generateWidgetInsight,
  generateDashboardSummary,
  generateAnomalyExplanation,
} from './components/StudioChatPanel/generateInsight';
export type {
  StudioInsightOptions,
  StudioInsightResult,
} from './components/StudioChatPanel/generateInsight';

// ─── Server adapter utilities ─────────────────────────────────────────────────
export { createBatchingAdapter } from './server/createBatchingAdapter';
export type { BatchingAdapterOptions } from './server/createBatchingAdapter';
export { createSimpleAdapter } from './server/createSimpleAdapter';
export type { SimpleAdapterOptions } from './server/createSimpleAdapter';
