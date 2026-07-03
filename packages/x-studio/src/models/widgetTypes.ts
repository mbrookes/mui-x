// Moved to `@mui/x-studio-schema`. Re-exported here — scoped to just the names
// that live in the schema package's own `widgetTypes.ts` module — so existing
// deep imports (`../models/widgetTypes`) keep working without surfacing the
// entire schema package.
export type {
  StudioConditionalFormatStyle,
  StudioConditionalFormat,
  StudioGridColumn,
  StudioChartSeries,
  StudioChartAnnotation,
  StudioWidgetForecast,
  StudioGridConfig,
  StudioChartConfig,
  StudioKpiConfig,
  StudioTextConfig,
  StudioFilterWidgetConfig,
  StudioPivotConfig,
  StudioMapConfig,
  StudioSharedWidgetConfig,
  StudioWidgetConfig,
  StudioWidget,
  StudioPageTheme,
  StudioPage,
} from '@mui/x-studio-schema';
