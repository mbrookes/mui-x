// Moved to `@mui/x-studio-schema`. Re-exported here — scoped to just the names
// that live in the schema package's own `baseTypes.ts` module — so existing deep
// imports (`../models/baseTypes`) keep working without surfacing the entire
// schema package (data/widget/expression/state/AI-protocol types included).
export type {
  StudioMode,
  StudioDrawer,
  BuiltinStudioWidgetKind,
  StudioWidgetKind,
  StudioFilterWidgetType,
  StudioCrossFilterMode,
  StudioChartType,
  StudioBarLayout,
  StudioNumberFormat,
  StudioKpiAggregation,
  StudioGridSummaryAggregation,
  StudioFilterOperator,
} from '@mui/x-studio-schema';
