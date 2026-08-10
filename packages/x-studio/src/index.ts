// ─── Studio (root component) ──────────────────────────────────────────────────
export { Studio } from './components/Studio/Studio';
export type { StudioProps, StudioHandle, StudioSlots } from './components/Studio/Studio';
// Exported so a host overriding `narrowLayoutMediaQuery` can widen or narrow the default rather
// than having to restate it, and so the value is quotable in docs without being duplicated.
export { DEFAULT_NARROW_LAYOUT_MEDIA_QUERY } from './components/Studio/layoutMediaQueries';

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
export type { GeographyLoader, StudioMapGeographyDefinition } from '@mui/x-studio-core/engine';

// ─── StudioDataDrawer ─────────────────────────────────────────────────────────
export { StudioDataDrawer } from './components/StudioDataDrawer/StudioDataDrawer';
export type { StudioDataDrawerProps } from './components/StudioDataDrawer/StudioDataDrawer';

// ─── StudioComposeDrawer ──────────────────────────────────────────────────────
export { StudioComposeDrawer } from './components/StudioComposeDrawer/StudioComposeDrawer';
export type { StudioComposeDrawerProps } from './components/StudioComposeDrawer/StudioComposeDrawer';
export { InlineFormulaBar } from './components/StudioComposeDrawer/InlineFormulaBar';
export type { InlineFormulaBarProps } from './components/StudioComposeDrawer/InlineFormulaBar';
export { DataSourceFieldSelect } from './components/StudioComposeDrawer/DataSourceFieldSelect';
export type {
  DataSourceFieldEntry,
  DataSourceFieldSelectCalculatedFieldContext,
} from './components/StudioComposeDrawer/DataSourceFieldSelect';

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
  useStudioIsDirty,
  useStudioState,
  useStudioFeatures,
  useStudioUIConfig,
  useStudioLocaleText,
  useStudioLocale,
  useStudioGeographies,
  useCustomWidgetMap,
  CanvasScrollContext,
} from './context/StudioContext';
export type { StudioProviderProps } from './context/StudioContext';
export type { StudioLocaleText, ResolvedStudioFeatures } from './internals/StudioUIConfigContext';
export { DEFAULT_STUDIO_LOCALE_TEXT } from './internals/StudioUIConfigContext';

// ─── Locales ─────────────────────────────────────────────────────────────────
export { ptBRLocaleText, ptBR } from '@mui/x-studio-core/locales';
export { enUS } from '@mui/x-studio-core/locales';
export { frLocaleText, fr } from '@mui/x-studio-core/locales';
export { deLocaleText, de } from '@mui/x-studio-core/locales';
export { esLocaleText, es } from '@mui/x-studio-core/locales';
export type { Localization } from '@mui/x-studio-core/locales';
export { getStudioLocalization } from '@mui/x-studio-core/locales';

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
export { WIDGET_TYPES } from './internals/widgetPresentation';
export { createDefaultWidget } from '@mui/x-studio-core/engine';

// ─── Controller ───────────────────────────────────────────────────────────────
export { StudioController, createStudioController } from '@mui/x-studio-core/store';
export { createDefaultStudioState, normalizeGridColumn } from './models';

// ─── State persistence ────────────────────────────────────────────────────────
export { serializeState, deserializeState, migrateState } from '@mui/x-studio-schema';
export type {
  SerializedStudioState,
  SerializedStudioSession,
  SerializedStudioSnapshot,
  MigrationResult,
} from '@mui/x-studio-schema';

// ─── Semantic model (ADR 0004) ────────────────────────────────────────────────
// The definitions layer — joins, calculated columns, measures — with an identity of its own, so a
// host can supply one governed model across dashboards instead of each document redeclaring it.
export {
  DEFAULT_SEMANTIC_MODEL_ID,
  createDefaultSemanticModel,
  resolveSemanticModel,
  isSemanticModelExternal,
} from '@mui/x-studio-schema';
export type { StudioSemanticModel } from '@mui/x-studio-schema';

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
  StudioKpiAggregation,
  StudioGridSummaryAggregation,
  StudioGridColumn,
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
  StudioWidgetForecast,
} from './models';

// ─── Utility types ────────────────────────────────────────────────────────────
export type { RelativeDateValue, RelativeDateUnit } from '@mui/x-studio-core/engine';

// ─── Dashboard date range ──────────────────────────────────────────────────────
export { computeDateRangePreset } from '@mui/x-studio-core/store';

// ─── Schema version ───────────────────────────────────────────────────────────
export { CURRENT_SCHEMA_VERSION } from '@mui/x-studio-schema';

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
export { useSpeechRecognition } from './components/StudioChatPanel/useSpeechRecognition';
export type { UseSpeechRecognitionReturn } from './components/StudioChatPanel/useSpeechRecognition';
// AI protocol types — the minimal set the UI needs to consume SSE responses and accept config.
// StudioAISkill (with server-side execute) and skill implementations live in @mui/x-studio-ai-middleware.
export type {
  StateMutation,
  MutationEnvelope,
  SerializableSkill,
  StudioAIToolName,
  StudioAIState,
  StudioAIChatThread,
} from '@mui/x-studio-core/models';
// ─── Server adapter utilities ─────────────────────────────────────────────────
export { createBatchingAdapter } from '@mui/x-studio-core/adapter';
export type { BatchingAdapterOptions } from '@mui/x-studio-core/adapter';
export { createSimpleAdapter } from '@mui/x-studio-core/adapter';
export type { SimpleAdapterOptions } from '@mui/x-studio-core/adapter';
