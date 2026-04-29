// ─── Studio (root component) ──────────────────────────────────────────────────
export { Studio } from './Studio/Studio';
export type { StudioProps, StudioHandle, StudioSlots } from './Studio/Studio';

// ─── StudioCanvas ─────────────────────────────────────────────────────────────
export { StudioCanvas } from './StudioCanvas/StudioCanvas';

// ─── StudioWidgetCard ─────────────────────────────────────────────────────────
export { StudioWidgetCard } from './StudioWidgetCard/StudioWidgetCard';
export type { StudioWidgetCardProps } from './StudioWidgetCard/StudioWidgetCard';

// ─── StudioGridWidget ─────────────────────────────────────────────────────────
export { StudioGridWidget } from './StudioGridWidget/StudioGridWidget';
export type { StudioGridWidgetProps } from './StudioGridWidget/StudioGridWidget';

// ─── StudioChartWidget ────────────────────────────────────────────────────────
export { StudioChartWidget, CHART_MIN_HEIGHT } from './StudioChartWidget/StudioChartWidget';
export type { StudioChartWidgetProps } from './StudioChartWidget/StudioChartWidget';

// ─── StudioKpiWidget ──────────────────────────────────────────────────────────
export { StudioKpiWidget } from './StudioKpiWidget/StudioKpiWidget';
export type { StudioKpiWidgetProps } from './StudioKpiWidget/StudioKpiWidget';

// ─── StudioTextWidget ─────────────────────────────────────────────────────────
export { StudioTextWidget } from './StudioTextWidget/StudioTextWidget';
export type { StudioTextWidgetProps } from './StudioTextWidget/StudioTextWidget';

// ─── StudioDataDrawer ─────────────────────────────────────────────────────────
export { StudioDataDrawer } from './StudioDataDrawer/StudioDataDrawer';

// ─── StudioComposeDrawer ──────────────────────────────────────────────────────
export { StudioComposeDrawer } from './StudioComposeDrawer/StudioComposeDrawer';

// ─── StudioFiltersDrawer ──────────────────────────────────────────────────────
export { StudioFiltersDrawer } from './StudioFiltersDrawer/StudioFiltersDrawer';

// ─── StudioExpressionFieldDialog ──────────────────────────────────────────────
export { StudioExpressionFieldDialog } from './StudioExpressionFieldDialog/StudioExpressionFieldDialog';
export type { StudioExpressionFieldDialogProps } from './StudioExpressionFieldDialog/StudioExpressionFieldDialog';

// ─── FieldTypeIcon ────────────────────────────────────────────────────────────
export { FieldTypeIcon } from './FieldTypeIcon/FieldTypeIcon';

// ─── Context / Provider ───────────────────────────────────────────────────────
export { StudioProvider, useStudioController, useStudioSelector, useStudioState, CanvasScrollContext } from './context/StudioContext';
export type { StudioProviderProps } from './context/StudioContext';

// ─── Controller ───────────────────────────────────────────────────────────────
export { StudioController, createStudioController } from './store/StudioController';
export { createDefaultStudioState } from './models/studio';

// ─── State persistence ────────────────────────────────────────────────────────
export {
  serializeState,
  deserializeState,
  migrateState,
  stateToJson,
  jsonToState,
  downloadState,
  uploadState,
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
  StudioNumberFormat,
  StudioChartType,
  StudioChartSeries,
  StudioBarLayout,
  StudioExpressionField,
  StudioExpression,
  StudioValueExpression,
  StudioFunctionExpression,
  StudioFieldExpression,
  StudioExpressionOperator,
} from './models/studio';

// ─── Utility types ────────────────────────────────────────────────────────────
export type { FieldType } from './FieldTypeIcon/FieldTypeIcon';
export type { RelativeDateValue, RelativeDateUnit } from './internals/filterTypes';

// ─── Schema version ───────────────────────────────────────────────────────────
export { CURRENT_SCHEMA_VERSION } from './store/statePersistence';
