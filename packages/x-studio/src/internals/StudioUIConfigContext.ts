'use client';
import * as React from 'react';
import type {
  StudioFeatureFlags,
  KpiFeatureFlags,
  ChartFeatureFlags,
  GridFeatureFlags,
  StudioCustomWidgetDef,
} from '../models';
import type { StudioAIConfig } from '../components/StudioChatPanel/studioBackendAdapter';
import {
  BUILT_IN_GEOGRAPHY_DEFINITIONS,
  type StudioMapGeographyDefinition,
} from '../components/widgets/StudioMapWidget/geographyLoaders';

// ── Locale text ─────────────────────────────────────────────────────────────

/**
 * All translatable string tokens used by the Studio UI.
 * Pass a `Partial<StudioLocaleText>` to `<Studio localeText={…} />` to override
 * any subset of strings. Tokens not included in the partial fall back to
 * `DEFAULT_STUDIO_LOCALE_TEXT`.
 */
export interface StudioLocaleText {
  // ── Drawer titles ──────────────────────────────────────────────────────────
  dataDrawerTitle: string;
  composeDrawerTitle: string;
  filtersDrawerTitle: string;

  // ── Date range presets ─────────────────────────────────────────────────────
  dateRangePresetAllTime: string;
  dateRangePresetYTD: string;
  dateRangePresetThisMonth: string;
  dateRangePresetLast3Months: string;
  dateRangePresetLast12Months: string;

  // ── Filters drawer ─────────────────────────────────────────────────────────
  filterSearchPlaceholder: string;
  filtersSectionPageFiltersTitle: string;
  filtersSectionNoFilters: string;
  filtersSectionNoMatchingFilters: string;
  filtersAddFilterTooltip: string;
  filtersSavedViewsTitle: string;
  filtersSaveViewTooltip: string;
  filtersSaveViewButton: string;
  filtersSaveViewPlaceholder: string;
  filtersDeleteViewTooltip: string;
  filtersNoSavedViews: string;
  filtersAddDataSourceHint: string;

  // ── Widget empty / error states ────────────────────────────────────────────
  widgetConfigureChartHint: string;
  widgetConfigureGaugeHint: string;
  widgetConfigurePivotHint: string;
  widgetConfigureMapHint: string;
  widgetNoData: string;
  widgetLoadError: string;

  // ── Quick filter bar ───────────────────────────────────────────────────────
  quickFilterBarOpenFilters: string;
  quickFilterBarClearAll: string;
  quickFilterBarFiltered: string;
  dateRangeBarFieldLabel: string;

  // ── Widget card actions ────────────────────────────────────────────────────
  widgetEditTooltip: string;
  widgetExportCsvTooltip: string;
  widgetExportPngTooltip: string;
  widgetExpandTooltip: string;
  widgetMoveToPageLabel: string;
  widgetDuplicateTooltip: string;
  widgetDeleteTooltip: string;
  widgetAiAssistantTooltip: string;
  widgetAiInsightTooltip: string;
  widgetDetectAnomalyTooltip: string;
  widgetHideAnomalyTooltip: string;
  widgetExplainAnomalyTooltip: string;

  // ── Widget edit dialog ─────────────────────────────────────────────────────
  widgetEditDialogTabSetup: string;
  widgetEditDialogTabFilters: string;
  widgetEditDialogTabFormat: string;
  widgetEditDialogCloseAriaLabel: string;
  /**
   * Returns the title for an unconfigured widget, e.g. "Untitled Chart".
   * @param kindLabel
   */
  widgetUntitledLabel: (kindLabel: string) => string;

  // ── AI assistant ───────────────────────────────────────────────────────────
  aiAssistantOpenTooltip: string;
  aiAssistantCloseTooltip: string;

  // ── Drawer panel / sidebar ────────────────────────────────────────────────
  drawerPanelCloseAriaLabel: string;
  sidebarPanelsAriaLabel: string;

  // ── NumberField ───────────────────────────────────────────────────────────
  numberFieldIncreaseAriaLabel: string;
  numberFieldDecreaseAriaLabel: string;

  // ── Widget card (expanded state) ──────────────────────────────────────────
  widgetCardCloseExpandedAriaLabel: string;
  widgetCardExportPngAriaLabel: string;

  // ── Natural language widget creation ──────────────────────────────────────
  aiCreateWidgetLabel: string;
  aiCreateWidgetPlaceholder: string;
  aiCreateWidgetButton: string;
  aiCreateWidgetLoading: string;
  aiCreateWidgetError: string;

  // ── AI dashboard summary panel ─────────────────────────────────────────────
  aiSummaryTitle: string;
  aiSummarizeTooltip: string;
  aiRegenerateTooltip: string;
  aiCopyTooltip: string;
  aiCopiedTooltip: string;
  aiCloseTooltip: string;

  // ── Widget type names (used in picker, dialog titles, empty states) ────────
  widgetKindGrid: string;
  widgetKindChart: string;
  widgetKindKpi: string;
  widgetKindText: string;
  widgetKindFilter: string;
  widgetKindPivot: string;
  widgetKindMap: string;

  // ── Data type labels ───────────────────────────────────────────────────────
  dataTypeString: string;
  dataTypeNumber: string;
  dataTypeBoolean: string;
  dataTypeDate: string;
  dataTypeDatetime: string;

  // ── Compose drawer / widget picker ─────────────────────────────────────────
  composeDrawerTabSetup: string;
  composeChooseWidgetType: string;
  composeNoDataSources: string;
  composeOnThisPage: string;
  /**
   * Returns the label for the "add widget" button, e.g. "Add Chart widget".
   * @param widgetTypeLabel
   */
  composeAddWidgetLabel: (widgetTypeLabel: string) => string;
  composeCloseAriaLabel: string;
  composeBackToWidgetTypesAriaLabel: string;
  composeCancel: string;

  // ── Format panel ──────────────────────────────────────────────────────────
  formatAutoTitle: string;
  formatResetTitle: string;
  formatAutoSubtitle: string;
  formatResetSubtitle: string;
  formatPanelCompactNumbers: string;
  formatPanelWidgetTitleLabel: string;
  formatPanelWidgetTitleHelperText: string;
  formatPanelSubtitleLabel: string;
  formatPanelSubtitleHelperText: string;

  // ── Text format panel ─────────────────────────────────────────────────────
  textFormatFontFamilyLabel: string;
  textFormatFontSizeLabel: string;
  textFormatColorLabel: string;
  textFormatColorPlaceholder: string;
  textFormatAlignLeftAriaLabel: string;
  textFormatAlignCenterAriaLabel: string;
  textFormatAlignRightAriaLabel: string;

  // ── Data drawer ────────────────────────────────────────────────────────────
  dataDrawerNoSources: string;
  dataDrawerViewLineage: string;
  dataDrawerLineageTitle: string;
  dataDrawerLineageHelper: string;
  /** Singular/plural label for the row count displayed in the data drawer, e.g. "rows". */
  dataDrawerRowsLabel: string;
  /** Singular/plural label for the field count displayed in the data drawer, e.g. "fields". */
  dataDrawerFieldsLabel: string;
  dataDrawerBackAriaLabel: string;
  dataDrawerCloseAriaLabel: string;
  dataDrawerEditTooltip: string;
  dataDrawerDeleteTooltip: string;
  dataDrawerViewSourceTooltip: string;

  // ── Relationship management ────────────────────────────────────────────────
  relationshipEditTooltip: string;
  relationshipRemoveTooltip: string;
  relationshipCancel: string;
  relationshipTypeManyToOne: string;
  relationshipTypeOneToOne: string;
  relationshipTypeManyToMany: string;
  relationshipTypeLabel: string;
  relationshipJoinFieldLabel: string;
  relationshipJunctionTableLabel: string;
  relationshipJunctionSourceLabel: string;
  relationshipJunctionSourceFkLabel: string;
  relationshipJunctionTargetFkLabel: string;

  // ── Filter conditions & values ─────────────────────────────────────────────
  filterConditionAnd: string;
  filterConditionOr: string;
  filterOperatorLabel: string;
  filterRemoveSecondCondition: string;
  filterAbsoluteDate: string;
  filterRelativeDate: string;
  filterLinkToField: string;
  filterRemoveFieldLink: string;
  filterBooleanTrue: string;
  filterBooleanFalse: string;
  filterRemoveAriaLabel: string;
  filterInteractiveSectionTitle: string;
  filterCrossSectionTitle: string;
  filterClearFilter: string;
  filterClearInteractiveAriaLabel: string;
  filterClearAllCrossFilters: string;
  filterRemoveCrossFilter: string;
  filterSearchValues: string;
  filterSelectField: string;
  filterValueLabel: string;
  filterValueHelper: string;
  filterValueAmountLabel: string;
  filterSelectParent: string;
  filterSourceLabel: string;
  filterMetricRowLabel: string;
  filterMetricHelperText: string;
  filterFieldLabel: string;
  filterRankByLabel: string;

  // ── Expression field dialog ────────────────────────────────────────────────
  exprNodeTypeField: string;
  exprNodeTypeLiteral: string;
  exprNodeTypeFunction: string;
  exprDataTypeNumber: string;
  exprDataTypeText: string;
  exprDataTypeBoolean: string;
  exprBooleanTrue: string;
  exprBooleanFalse: string;
  exprExpandTooltip: string;
  exprCollapseTooltip: string;
  exprRemoveInputTooltip: string;
  exprCancel: string;
  exprSave: string;
  exprAddField: string;
  expressionNameLabel: string;
  expressionNameHelperText: string;
  expressionNamePlaceholder: string;
  expressionDescriptionLabel: string;
  expressionDescriptionHelperText: string;
  expressionDescriptionPlaceholder: string;
  expressionPrecisionLabel: string;
  expressionPrecisionHelperText: string;

  // ── Shared aggregation function labels ─────────────────────────────────────
  aggFnSum: string;
  aggFnCount: string;
  aggFnCountRows: string;
  aggFnAverage: string;
  aggFnMin: string;
  aggFnMax: string;

  // ── Shared time granularity labels ────────────────────────────────────────
  timeGranNone: string;
  timeGranDay: string;
  timeGranWeek: string;
  timeGranMonth: string;
  timeGranQuarter: string;
  timeGranYear: string;

  // ── Shared sort direction labels ───────────────────────────────────────────
  sortAscendingAriaLabel: string;
  sortDescendingAriaLabel: string;

  // ── Chart setup panel ─────────────────────────────────────────────────────
  chartSetupValueFieldLabel: string;
  chartSetupValueFieldHelperText: string;
  chartSetupAggregationLabel: string;
  chartSetupMinLabel: string;
  chartSetupMaxLabel: string;
  chartSetupGroupByLabel: string;
  chartSetupSortByLabel: string;
  chartSetupSortCategory: string;
  chartSetupSortValue: string;
  chartSetupSortNone: string;
  chartSetupSortPercent: string;
  chartSetupSortDirectionAriaLabel: string;
  chartSetupAnnotationsTitle: string;
  chartSetupInteractionsTitle: string;
  chartSetupInteractionsDescription: string;
  chartSetupAddSeries: string;
  chartSetupNoMoreFields: string;
  chartSetupRemoveSeries: string;
  chartSetupAddReferenceLine: string;
  chartSetupRemoveAnnotation: string;
  chartSetupNoReferenceLines: string;
  chartSetupDualYAxis: string;
  chartSetupReferenceLineValueLabel: string;
  chartSetupReferenceLineLabelLabel: string;
  chartSetupYFieldLabel: string;
  chartSetupYFieldHelperText: string;
  chartSetupColorByLabel: string;
  chartSetupColorByHelperText: string;
  chartSetupSizeByLabel: string;
  chartSetupSizeByHelperText: string;
  chartSetupMinRadiusLabel: string;
  chartSetupMaxRadiusLabel: string;
  chartSetupFunnelValueHelperText: string;
  chartSetupHeatmapRowAxisLabel: string;
  chartSetupHeatmapRowAxisHelperText: string;
  chartSetupHeatmapValueLabel: string;
  chartSetupHeatmapValueHelperText: string;
  chartSetupHeatmapColourSchemeLabel: string;
  chartSetupArcLabelLabel: string;
  chartSetupMinAngleLabel: string;
  chartSetupMinAngleHelperText: string;
  chartSetupGanttLabelFieldLabel: string;
  chartSetupGanttLabelFieldHelperText: string;
  chartSetupGanttStartDateLabel: string;
  chartSetupGanttStartDateHelperText: string;
  chartSetupGanttEndDateLabel: string;
  chartSetupGanttEndDateHelperText: string;
  chartSetupGanttColourByLabel: string;
  chartSetupGanttColourByHelperText: string;

  // ── KPI setup panel ────────────────────────────────────────────────────────
  kpiSetupChartLine: string;
  kpiSetupChartBar: string;
  kpiSetupChartGauge: string;
  kpiSetupCompPrevPeriod: string;
  kpiSetupCompPrevCalendarPeriod: string;
  kpiSetupCompSameLastYear: string;
  kpiSetupInteractionsTitle: string;
  kpiSetupInteractionsDescription: string;
  kpiSetupTimeFieldLabel: string;
  kpiSetupGranularityLabel: string;
  kpiSetupPlotTypeLabel: string;
  kpiSetupMinLabel: string;
  kpiSetupMaxLabel: string;
  kpiSetupValueFieldLabel: string;
  kpiSetupValueFieldHelperText: string;
  kpiSetupSparklineLabel: string;
  kpiSetupTargetLabel: string;
  kpiSetupTrendLabel: string;
  kpiSetupCompPeriodLabel: string;

  // ── KPI widget ─────────────────────────────────────────────────────────────
  kpiGrandTotalTooltip: string;

  // ── Grid setup panel ──────────────────────────────────────────────────────
  gridSetupDataSourceLabel: string;
  gridSetupDataSourcePlaceholder: string;
  gridSetupAllColumnsAdded: string;
  gridSetupCrossFilterFieldLabel: string;
  gridSetupCrossFilterFieldHelper: string;
  gridSetupGroupByLabel: string;
  gridSetupGroupByHelper: string;
  gridSetupDefaultSortLabel: string;
  gridSetupHeightLabel: string;
  gridSetupConditionalFormattingTitle: string;
  gridSetupConditionalCustom: string;
  gridSetupRemoveRuleAriaLabel: string;
  gridSetupInteractionsTitle: string;
  gridSetupInteractionsDescription: string;

  // ── Map setup panel ────────────────────────────────────────────────────────
  mapSetupMapTypeLabel: string;
  mapSetupValueFieldLabel: string;
  mapSetupColourSchemeLabel: string;
  mapSetupLegendPositionLabel: string;
  mapSetupScaleFromZeroLabel: string;
  mapSetupClickableLabel: string;
  mapSetupCrossFilterLabel: string;
  mapSetupColorBlues: string;
  mapSetupColorReds: string;
  mapSetupColorGreens: string;
  mapSetupColorOranges: string;
  mapSetupColorPurples: string;
  mapSetupLegendBottom: string;
  mapSetupLegendTop: string;
  mapSetupLegendLeft: string;
  mapSetupLegendRight: string;
  mapSetupLegendHidden: string;

  // ── Pivot setup panel ─────────────────────────────────────────────────────
  pivotSetupDescription: string;
  pivotSetupRowFieldLabel: string;
  pivotSetupRowFieldHelper: string;
  pivotSetupColFieldLabel: string;
  pivotSetupColFieldHelper: string;
  pivotSetupValueFieldLabel: string;
  pivotSetupValueFieldHelper: string;
  pivotSetupShowTotals: string;
  pivotSetupAggregationLabel: string;

  // ── Inline formula bar ────────────────────────────────────────────────────
  inlineFormulaBarAddTooltip: string;
  inlineFormulaBarCloseAriaLabel: string;
  inlineFormulaBarLabelLabel: string;

  // ── Filters drawer ─────────────────────────────────────────────────────────────
  filtersDrawerRenameViewTooltip: string;

  // ── Filter setup panel ────────────────────────────────────────────────────
  filterSetupControlTypeLabel: string;
  filterSetupMultiSelect: string;
  filterSetupMultiSelectDescription: string;
  filterSetupToggleChips: string;
  filterSetupToggleChipsDescription: string;
  filterSetupDateRange: string;
  filterSetupDateRangeDescription: string;
  filterSetupSlider: string;
  filterSetupSliderDescription: string;
  filterSetupMinLabel: string;
  filterSetupMaxLabel: string;
  filterSetupStepLabel: string;
  filterSetupSelectFieldAlert: string;

  // ── Text setup panel ──────────────────────────────────────────────────────
  textSetupTitleLabel: string;
  textSetupTitleHelper: string;
  textSetupSubtitleLabel: string;
  textSetupSubtitleHelper: string;
  textSetupBodyLabel: string;
  textSetupBodyHelper: string;

  // ── Page config panel ─────────────────────────────────────────────────────
  pageConfigPageSectionTitle: string;
  pageConfigCardsSectionTitle: string;
  pageConfigBackgroundColourLabel: string;
  pageConfigBackgroundColourPlaceholder: string;
  pageConfigCardBackgroundLabel: string;
  pageConfigCardBackgroundPlaceholder: string;
  pageConfigPaddingLabel: string;
  pageConfigCornerRadiusLabel: string;
  pageConfigCardBorderLabel: string;
  pageConfigBorderColourLabel: string;
  pageConfigBorderColourPlaceholder: string;
  pageConfigBorderWidthLabel: string;
}

/** Default English locale text for all Studio UI strings. */
export const DEFAULT_STUDIO_LOCALE_TEXT: StudioLocaleText = {
  // Drawer titles
  dataDrawerTitle: 'Data',
  composeDrawerTitle: 'Compose',
  filtersDrawerTitle: 'Filters',

  // Date range presets
  dateRangePresetAllTime: 'All time',
  dateRangePresetYTD: 'YTD',
  dateRangePresetThisMonth: 'This month',
  dateRangePresetLast3Months: 'Last 3 months',
  dateRangePresetLast12Months: 'Last 12 months',

  // Filters drawer
  filterSearchPlaceholder: 'Search filters\u2026',
  filtersSectionPageFiltersTitle: 'Page filters',
  filtersSectionNoFilters: 'No filters applied.',
  filtersSectionNoMatchingFilters: 'No matching filters.',
  filtersAddFilterTooltip: 'Add filter',
  filtersSavedViewsTitle: 'Saved views',
  filtersSaveViewTooltip: 'Save current page filters as a named view',
  filtersSaveViewButton: 'Save',
  filtersSaveViewPlaceholder: 'View name',
  filtersDeleteViewTooltip: 'Delete view',
  filtersNoSavedViews: 'No saved views. Apply page filters and save them here.',
  filtersAddDataSourceHint: 'Add a data source and widgets first.',

  // Widget states
  widgetConfigureChartHint: 'Use the Setup tab to configure this chart.',
  widgetConfigureGaugeHint: 'Use the Setup tab to choose a gauge value field.',
  widgetConfigurePivotHint: 'Use the Setup tab to configure row, column, and value fields.',
  widgetConfigureMapHint: 'Use the Setup tab to choose a country field and a value field.',
  widgetNoData: 'No data to display.',
  widgetLoadError: 'Failed to load data',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Open filters panel',
  quickFilterBarClearAll: 'Clear all page filters',
  quickFilterBarFiltered: 'Filtered',
  dateRangeBarFieldLabel: 'Date range',

  // Widget card actions
  widgetEditTooltip: 'Edit widget',
  widgetExportCsvTooltip: 'Export as CSV',
  widgetExportPngTooltip: 'Export as PNG',
  widgetExpandTooltip: 'Expand chart',
  widgetMoveToPageLabel: 'Move to page',
  widgetDuplicateTooltip: 'Duplicate widget',
  widgetDeleteTooltip: 'Delete widget',
  widgetAiAssistantTooltip: 'AI assistant',
  widgetAiInsightTooltip: 'AI insight',
  widgetDetectAnomalyTooltip: 'Detect anomalies',
  widgetHideAnomalyTooltip: 'Hide anomalies',
  widgetExplainAnomalyTooltip: 'Explain anomalies',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Setup',
  widgetEditDialogTabFilters: 'Filters',
  widgetEditDialogTabFormat: 'Format',
  widgetEditDialogCloseAriaLabel: 'Close edit dialog',
  widgetUntitledLabel: (kindLabel) => `Untitled ${kindLabel}`,

  // AI assistant
  aiAssistantOpenTooltip: 'Open AI assistant',
  aiAssistantCloseTooltip: 'Close AI assistant',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Close widget configuration',
  sidebarPanelsAriaLabel: 'Sidebar panels',

  // NumberField
  numberFieldIncreaseAriaLabel: 'Increase',
  numberFieldDecreaseAriaLabel: 'Decrease',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Close expanded chart',
  widgetCardExportPngAriaLabel: 'Export expanded chart as PNG',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Describe a widget',
  aiCreateWidgetPlaceholder:
    'e.g. Bar chart showing revenue by country, KPI for total orders\u2026',
  aiCreateWidgetButton: 'Create',
  aiCreateWidgetLoading: 'Creating\u2026',
  aiCreateWidgetError: 'Failed to create widget',

  // AI dashboard summary panel
  aiSummaryTitle: 'Dashboard Summary',
  aiSummarizeTooltip: 'Summarise dashboard',
  aiRegenerateTooltip: 'Regenerate',
  aiCopyTooltip: 'Copy',
  aiCopiedTooltip: 'Copied!',
  aiCloseTooltip: 'Close',

  // Widget type names
  widgetKindGrid: 'Table',
  widgetKindChart: 'Chart',
  widgetKindKpi: 'KPI',
  widgetKindText: 'Text',
  widgetKindFilter: 'Filter',
  widgetKindPivot: 'Pivot Table',
  widgetKindMap: 'Map',

  // Data type labels
  dataTypeString: 'Text',
  dataTypeNumber: 'Number',
  dataTypeBoolean: 'Boolean',
  dataTypeDate: 'Date',
  dataTypeDatetime: 'Date & Time',

  // Compose drawer / widget picker
  composeDrawerTabSetup: 'Setup',
  composeChooseWidgetType: 'Choose a widget type or drag onto the page',
  composeNoDataSources: 'No data sources available yet. Only text widgets can be added.',
  composeOnThisPage: 'On this page',
  composeAddWidgetLabel: (widgetTypeLabel) => `Add ${widgetTypeLabel} widget`,
  composeCloseAriaLabel: 'Close',
  composeBackToWidgetTypesAriaLabel: 'Back to widget types',
  composeCancel: 'Cancel',

  // Format panel
  formatAutoTitle: 'Auto-generated title',
  formatResetTitle: 'Reset to auto-generated title',
  formatAutoSubtitle: 'Auto-generated subtitle',
  formatResetSubtitle: 'Reset to auto-generated subtitle',
  formatPanelCompactNumbers: 'Compact numbers',
  formatPanelWidgetTitleLabel: 'Widget title',
  formatPanelWidgetTitleHelperText: 'Shown in the widget header',
  formatPanelSubtitleLabel: 'Subtitle',
  formatPanelSubtitleHelperText: 'Optional line shown beneath the title',

  // Text format panel
  textFormatFontFamilyLabel: 'Font family',
  textFormatFontSizeLabel: 'Font size',
  textFormatColorLabel: 'Color',
  textFormatColorPlaceholder: 'Default',
  textFormatAlignLeftAriaLabel: 'Align left',
  textFormatAlignCenterAriaLabel: 'Align center',
  textFormatAlignRightAriaLabel: 'Align right',

  // Data drawer
  dataDrawerNoSources:
    'No data sources configured. Add a widget from the canvas to load sample data.',
  dataDrawerViewLineage: 'View data lineage',
  dataDrawerLineageTitle: 'Data lineage',
  dataDrawerLineageHelper:
    'Click a node to preview its data. Click an edge to inspect join key fields.',
  dataDrawerRowsLabel: 'rows',
  dataDrawerFieldsLabel: 'fields',
  dataDrawerBackAriaLabel: 'Back to lineage graph',
  dataDrawerCloseAriaLabel: 'Close data lineage',
  dataDrawerEditTooltip: 'Edit',
  dataDrawerDeleteTooltip: 'Delete',
  dataDrawerViewSourceTooltip: 'View source data',

  // Relationship management
  relationshipEditTooltip: 'Edit',
  relationshipRemoveTooltip: 'Remove',
  relationshipCancel: 'Cancel',
  relationshipTypeManyToOne: 'Many-to-one',
  relationshipTypeOneToOne: 'One-to-one',
  relationshipTypeManyToMany: 'Many-to-many',
  relationshipTypeLabel: 'Type',
  relationshipJoinFieldLabel: 'Join field',
  relationshipJunctionTableLabel: 'Junction (bridge) table',
  relationshipJunctionSourceLabel: 'Junction source',
  relationshipJunctionSourceFkLabel: '\u2192 Source FK',
  relationshipJunctionTargetFkLabel: '\u2192 Target FK',

  // Filter conditions & values
  filterConditionAnd: 'AND',
  filterConditionOr: 'OR',
  filterOperatorLabel: 'Operator',
  filterRemoveSecondCondition: 'Remove second condition',
  filterAbsoluteDate: 'Absolute date',
  filterRelativeDate: 'Relative date',
  filterLinkToField: 'Link to field',
  filterRemoveFieldLink: 'Remove field link',
  filterBooleanTrue: 'True',
  filterBooleanFalse: 'False',
  filterRemoveAriaLabel: 'Remove filter',
  filterInteractiveSectionTitle: 'Interactive filters',
  filterCrossSectionTitle: 'Cross-filters',
  filterClearFilter: 'Clear filter',
  filterClearInteractiveAriaLabel: 'Clear interactive filter',
  filterClearAllCrossFilters: 'Clear all cross-filters',
  filterRemoveCrossFilter: 'Remove cross-filter',
  filterSearchValues: 'Search values\u2026',
  filterSelectField: 'Select a field\u2026',
  filterValueLabel: 'Value',
  filterValueHelper: 'Value to compare against',
  filterValueAmountLabel: 'Amount',
  filterSelectParent: 'Select parent filter\u2026',
  filterSourceLabel: 'Source',
  filterMetricRowLabel: 'Metric row',
  filterMetricHelperText: 'Identifies the row in the business metrics table',
  filterFieldLabel: 'Field',
  filterRankByLabel: 'Rank by',

  // Expression field dialog
  exprNodeTypeField: 'Field',
  exprNodeTypeLiteral: 'Literal',
  exprNodeTypeFunction: 'Function',
  exprDataTypeNumber: 'Number',
  exprDataTypeText: 'Text',
  exprDataTypeBoolean: 'Boolean',
  exprBooleanTrue: 'True',
  exprBooleanFalse: 'False',
  exprExpandTooltip: 'Expand',
  exprCollapseTooltip: 'Collapse',
  exprRemoveInputTooltip: 'Remove input',
  exprCancel: 'Cancel',
  exprSave: 'Save',
  exprAddField: 'Add Field',
  expressionNameLabel: 'Name',
  expressionNameHelperText: 'Used as the field label in pickers and grid columns',
  expressionNamePlaceholder: 'e.g. Profit, Revenue per Unit',
  expressionDescriptionLabel: 'Description',
  expressionDescriptionHelperText: 'Optional. Shown as a tooltip in field pickers',
  expressionDescriptionPlaceholder: 'Optional: describe what this field computes',
  expressionPrecisionLabel: 'Precision',
  expressionPrecisionHelperText:
    'Decimal places (0\u201310) used when formatting this calculated field',

  // Shared aggregation function labels
  aggFnSum: 'Sum',
  aggFnCount: 'Count',
  aggFnCountRows: 'Count (rows)',
  aggFnAverage: 'Average',
  aggFnMin: 'Min',
  aggFnMax: 'Max',

  // Shared time granularity labels
  timeGranNone: 'None (raw values)',
  timeGranDay: 'Day',
  timeGranWeek: 'Week',
  timeGranMonth: 'Month',
  timeGranQuarter: 'Quarter',
  timeGranYear: 'Year',

  // Shared sort direction labels
  sortAscendingAriaLabel: 'Ascending',
  sortDescendingAriaLabel: 'Descending',

  // Chart setup panel
  chartSetupValueFieldLabel: 'Value field',
  chartSetupValueFieldHelperText: 'Numeric field to aggregate',
  chartSetupAggregationLabel: 'Aggregation',
  chartSetupMinLabel: 'Min',
  chartSetupMaxLabel: 'Max',
  chartSetupGroupByLabel: 'Group by',
  chartSetupSortByLabel: 'Sort by',
  chartSetupSortCategory: 'Category',
  chartSetupSortValue: 'Value',
  chartSetupSortNone: 'None',
  chartSetupSortPercent: 'Percent',
  chartSetupSortDirectionAriaLabel: 'Sort direction',
  chartSetupAnnotationsTitle: 'Annotations',
  chartSetupInteractionsTitle: 'Interactions',
  chartSetupInteractionsDescription: 'When other widgets are clicked, this chart\u2026',
  chartSetupAddSeries: 'Add series',
  chartSetupNoMoreFields: 'No more fields to add',
  chartSetupRemoveSeries: 'Remove series',
  chartSetupAddReferenceLine: 'Add reference line',
  chartSetupRemoveAnnotation: 'Remove annotation',
  chartSetupNoReferenceLines: 'No reference lines. Click + to add one.',
  chartSetupDualYAxis: 'Dual Y axis (line series on right axis)',
  chartSetupReferenceLineValueLabel: 'Value',
  chartSetupReferenceLineLabelLabel: 'Label',
  chartSetupYFieldLabel: 'Y field (numeric)',
  chartSetupYFieldHelperText: 'Numeric field plotted on the vertical axis',
  chartSetupColorByLabel: 'Color by (optional)',
  chartSetupColorByHelperText: 'Splits points into colour-coded series per category',
  chartSetupSizeByLabel: 'Size by (optional)',
  chartSetupSizeByHelperText: 'Numeric field that controls bubble radius (produces a bubble chart)',
  chartSetupMinRadiusLabel: 'Min radius',
  chartSetupMaxRadiusLabel: 'Max radius',
  chartSetupFunnelValueHelperText:
    'Numeric field summed per stage \u2014 stages are sorted by value (largest first)',
  chartSetupHeatmapRowAxisLabel: 'Row axis field',
  chartSetupHeatmapRowAxisHelperText:
    'Categorical field for the vertical (row) axis, e.g. hour of day',
  chartSetupHeatmapValueLabel: 'Value / colour field',
  chartSetupHeatmapValueHelperText: 'Numeric field summed per cell to determine colour intensity',
  chartSetupHeatmapColourSchemeLabel: 'Colour scheme',
  chartSetupArcLabelLabel: 'Arc label',
  chartSetupMinAngleLabel: 'Minimum angle (\u00b0)',
  chartSetupMinAngleHelperText: 'Slices smaller than this angle (degrees) won\u2019t show a label',
  chartSetupGanttLabelFieldLabel: 'Label field',
  chartSetupGanttLabelFieldHelperText:
    'Field shown as the row label on the Y axis (e.g. task or order name)',
  chartSetupGanttStartDateLabel: 'Start date field',
  chartSetupGanttStartDateHelperText: 'Date / datetime field for the start of each bar',
  chartSetupGanttEndDateLabel: 'End date field',
  chartSetupGanttEndDateHelperText: 'Date / datetime field for the end of each bar',
  chartSetupGanttColourByLabel: 'Colour by (optional)',
  chartSetupGanttColourByHelperText:
    'Categorical field used to colour-code bars (e.g. status or category)',

  // KPI setup panel
  kpiSetupChartLine: 'Line',
  kpiSetupChartBar: 'Bar',
  kpiSetupChartGauge: 'Gauge',
  kpiSetupCompPrevPeriod: 'Previous period (matching duration)',
  kpiSetupCompPrevCalendarPeriod: 'Previous calendar period',
  kpiSetupCompSameLastYear: 'Same period last year',
  kpiSetupInteractionsTitle: 'Interactions',
  kpiSetupInteractionsDescription: 'When other widgets are clicked, this KPI\u2026',
  kpiSetupTimeFieldLabel: 'Time field',
  kpiSetupGranularityLabel: 'Granularity',
  kpiSetupPlotTypeLabel: 'Plot type',
  kpiSetupMinLabel: 'Min',
  kpiSetupMaxLabel: 'Max',
  kpiSetupValueFieldLabel: 'Value field',
  kpiSetupValueFieldHelperText: 'Field to aggregate',
  kpiSetupSparklineLabel: 'Sparkline',
  kpiSetupTargetLabel: 'Target',
  kpiSetupTrendLabel: 'Trend',
  kpiSetupCompPeriodLabel: 'Comparison period',

  // KPI widget
  kpiGrandTotalTooltip:
    'Grand total \u2014 active filter widgets are not applied to this KPI. Enable Cross-filter mode in KPI settings to respect them.',

  // Grid setup panel
  gridSetupDataSourceLabel: 'Data source',
  gridSetupDataSourcePlaceholder: 'Select a data source\u2026',
  gridSetupAllColumnsAdded: 'All available columns added',
  gridSetupCrossFilterFieldLabel: 'Cross-filter field',
  gridSetupCrossFilterFieldHelper:
    'Field applied to other widgets when a row is selected; defaults to the first visible column',
  gridSetupGroupByLabel: 'Group by',
  gridSetupGroupByHelper: 'Collapse rows into groups \u2014 set per-column aggregation below',
  gridSetupDefaultSortLabel: 'Default sort',
  gridSetupHeightLabel: 'Height (px)',
  gridSetupConditionalFormattingTitle: 'Conditional formatting',
  gridSetupConditionalCustom: 'Custom',
  gridSetupRemoveRuleAriaLabel: 'Remove rule',
  gridSetupInteractionsTitle: 'Interactions',
  gridSetupInteractionsDescription: 'When other widgets are clicked, this table\u2026',

  // Map setup panel
  mapSetupMapTypeLabel: 'Map type',
  mapSetupValueFieldLabel: 'Value field (optional for count)',
  mapSetupColourSchemeLabel: 'Colour scheme',
  mapSetupLegendPositionLabel: 'Legend position',
  mapSetupScaleFromZeroLabel: 'Scale from zero',
  mapSetupClickableLabel: 'Clickable (filter source)',
  mapSetupCrossFilterLabel: 'Respond to cross-filters',
  mapSetupColorBlues: 'Blues',
  mapSetupColorReds: 'Reds',
  mapSetupColorGreens: 'Greens',
  mapSetupColorOranges: 'Oranges',
  mapSetupColorPurples: 'Purples',
  mapSetupLegendBottom: 'Bottom',
  mapSetupLegendTop: 'Top',
  mapSetupLegendLeft: 'Left',
  mapSetupLegendRight: 'Right',
  mapSetupLegendHidden: 'Hidden',

  // Pivot setup panel
  pivotSetupDescription:
    'Build a cross-tabulation by choosing a row field, column field, and value measure.',
  pivotSetupRowFieldLabel: 'Row field',
  pivotSetupRowFieldHelper: 'Categorical field shown as row groups on the left',
  pivotSetupColFieldLabel: 'Column field',
  pivotSetupColFieldHelper: 'Categorical field spread across column headers',
  pivotSetupValueFieldLabel: 'Value field',
  pivotSetupValueFieldHelper: 'Numeric field aggregated into each cell',
  pivotSetupShowTotals: 'Show totals row and column',
  pivotSetupAggregationLabel: 'Aggregation',

  // Inline formula bar
  inlineFormulaBarAddTooltip: 'Add a calculated formula field',
  inlineFormulaBarCloseAriaLabel: 'Close formula bar',
  inlineFormulaBarLabelLabel: 'Label',

  // Filters drawer
  filtersDrawerRenameViewTooltip: 'Rename view',

  // Filter setup panel
  filterSetupControlTypeLabel: 'Control type',
  filterSetupMultiSelect: 'Multi-select',
  filterSetupMultiSelectDescription: 'Dropdown with checkboxes for categorical values',
  filterSetupToggleChips: 'Toggle chips',
  filterSetupToggleChipsDescription: 'Inline chip buttons for categorical values',
  filterSetupDateRange: 'Date range',
  filterSetupDateRangeDescription: 'From / to date pickers',
  filterSetupSlider: 'Slider',
  filterSetupSliderDescription: 'Range slider for numeric or date fields',
  filterSetupMinLabel: 'Min',
  filterSetupMaxLabel: 'Max',
  filterSetupStepLabel: 'Step',
  filterSetupSelectFieldAlert: 'Select a field to configure the filter control.',

  // Text setup panel
  textSetupTitleLabel: 'Title',
  textSetupTitleHelper: 'Heading displayed at the top of the widget',
  textSetupSubtitleLabel: 'Subtitle',
  textSetupSubtitleHelper: 'Smaller text below the heading',
  textSetupBodyLabel: 'Body',
  textSetupBodyHelper: 'Main content of the widget; supports plain text',

  // Page config panel
  pageConfigPageSectionTitle: 'Page',
  pageConfigCardsSectionTitle: 'Cards',
  pageConfigBackgroundColourLabel: 'Background colour',
  pageConfigBackgroundColourPlaceholder: 'e.g. #f5f5f5',
  pageConfigCardBackgroundLabel: 'Card background',
  pageConfigCardBackgroundPlaceholder: 'e.g. #ffffff',
  pageConfigPaddingLabel: 'Padding',
  pageConfigCornerRadiusLabel: 'Corner radius (px)',
  pageConfigCardBorderLabel: 'Card border',
  pageConfigBorderColourLabel: 'Border colour',
  pageConfigBorderColourPlaceholder: 'e.g. #e0e0e0',
  pageConfigBorderWidthLabel: 'Border width (px)',
};

// ── Config context ──────────────────────────────────────────────────────────

export interface StudioUIConfig {
  /**
   * Controls how the table widget's data source is determined.
   * - `'explicit'` (default): a data source picker is shown at the top of the
   *   table setup panel — the user must choose a source before adding columns.
   * - `'implicit'`: no source picker is shown. The source is inferred from the
   *   first column the user adds (Tableau / Power BI style). Removing all
   *   columns resets the source so a different one can be chosen.
   */
  tableSourceMode: 'explicit' | 'implicit';
  /** Runtime feature flags controlling which UI features are available. */
  featureFlags: StudioFeatureFlags;
  /**
   * Locale text overrides. Any tokens not provided fall back to the English defaults.
   * Pass the full `StudioLocaleText` object (e.g. `ptBRLocaleText`) or a partial
   * override to change individual strings.
   */
  localeText: StudioLocaleText;
  /**
   * AI/LLM configuration for the natural language widget creator and AI chat assistant.
   * When provided, the "Describe a widget" prompt appears in the compose drawer.
   * Set to `null` to disable AI features even if the config object exists.
   */
  aiConfig?: StudioAIConfig | null;
  /**
   * Consumer-defined custom widget kinds.
   * Widgets registered here appear in the widget picker and are rendered on the canvas.
   * See {@link StudioCustomWidgetDef} for the registration shape.
   */
  customWidgets?: StudioCustomWidgetDef[];
  /**
   * Additional map geography definitions to register alongside the built-in `'world'`,
   * `'usa'`, and `'europe'` geographies.
   *
   * Each entry defines how to load the topology, how to normalise raw data values to
   * feature IDs, and how the geography appears in the Map Setup panel (label, field
   * label, and help text).
   *
   * @example
   * ```tsx
   * const geographies = {
   *   'uk-counties': {
   *     label: 'United Kingdom',
   *     fieldLabel: 'County field',
   *     fieldHint: 'A field containing UK county names.',
   *     loader: async () => { ... },
   *     normalizer: (v) => String(v).trim().toLowerCase(),
   *   },
   * };
   * <Studio geographies={geographies} />
   * ```
   */
  geographies?: Record<string, StudioMapGeographyDefinition>;
}

/** Pre-built map from `kind` → `StudioCustomWidgetDef` for fast lookup. */
type CustomWidgetMap = ReadonlyMap<string, StudioCustomWidgetDef>;

export const StudioUIConfigContext = React.createContext<StudioUIConfig>({
  tableSourceMode: 'explicit',
  featureFlags: {},
  localeText: DEFAULT_STUDIO_LOCALE_TEXT,
});

/** Returns the resolved UI config including feature flags. */
export function useStudioUIConfig(): StudioUIConfig {
  return React.useContext(StudioUIConfigContext);
}

/** Returns the custom widget definitions indexed by kind for O(1) lookup. */
export function useCustomWidgetMap(): CustomWidgetMap {
  const { customWidgets } = useStudioUIConfig();
  return React.useMemo(
    () => new Map((customWidgets ?? []).map((d) => [d.kind, d])),
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- JSON.stringify proxy for deep equality
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(customWidgets?.map((d) => d.kind))],
  );
}

/**
 * Returns all geography definitions — built-ins merged with any consumer-provided
 * overrides from `<Studio geographies={…} />`.
 *
 * Consumer entries take precedence, so a consumer can override a built-in geography
 * by registering a definition under the same key (`'world'`, `'usa'`, `'europe'`).
 */
export function useStudioGeographies(): Record<string, StudioMapGeographyDefinition> {
  const { geographies } = useStudioUIConfig();
  return React.useMemo(
    () => ({ ...BUILT_IN_GEOGRAPHY_DEFINITIONS, ...geographies }),
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- JSON.stringify proxy for deep equality
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(Object.keys(geographies ?? {}))],
  );
}

/**
 * Returns the resolved locale text with consumer overrides merged over defaults.
 * Use this hook in any component that renders user-visible strings.
 */
export function useStudioLocaleText(): StudioLocaleText {
  const { localeText } = useStudioUIConfig();
  return localeText;
}

/**
 * Flat resolved feature flags — all nested sub-flags are unwound into top-level booleans.
 * This is the internal type returned by `useStudioFeatures()` and consumed by UI components.
 * The public API (`StudioFeatureFlags`) supports nested objects; resolution happens here.
 */
export interface ResolvedStudioFeatures {
  // ── Top-level flags ────────────────────────────────────────────────────────
  compose: boolean;
  filters: boolean;
  quickFilter: boolean;
  savedFilterViews: boolean;
  dataManagement: boolean;
  relationships: boolean;
  widgetFilters: boolean;
  aiChat: boolean;
  // ── Widget kind availability ───────────────────────────────────────────────
  grid: boolean;
  chart: boolean;
  kpi: boolean;
  text: boolean;
  filter: boolean;
  pivot: boolean;
  map: boolean;
  // ── KPI sub-flags ──────────────────────────────────────────────────────────
  kpiSparkline: boolean;
  kpiTrend: boolean;
  kpiTarget: boolean;
  kpiCalculatedFields: boolean;
  // ── Chart sub-flags ────────────────────────────────────────────────────────
  chartAnnotations: boolean;
  chartCalculatedFields: boolean;
  // ── Grid sub-flags ─────────────────────────────────────────────────────────
  gridGroupBy: boolean;
  gridSummary: boolean;
  gridConditionalFormats: boolean;
  gridCalculatedFields: boolean;
  // ── Global ─────────────────────────────────────────────────────────────────
  calculatedFields: boolean;
}

/**
 * Resolves a sub-flag from a widget-kind flag that may be boolean or an object.
 * - `false` / `undefined parent` disabled → sub-flag is also disabled
 * - `true` or `undefined` → sub-flag defaults to `true`
 * - object → reads the specific sub-key, defaulting to `true`
 */
function resolveSubFlag<T extends object>(
  widgetFlag: boolean | T | undefined,
  subKey: keyof T,
): boolean {
  if (widgetFlag === false) {
    return false;
  }
  if (widgetFlag === undefined || widgetFlag === true) {
    return true;
  }
  return ((widgetFlag as T)[subKey] as boolean | undefined) ?? true;
}

/** Returns the active feature flags as a flat resolved object. All flags default to `true`. */
export function useStudioFeatures(): ResolvedStudioFeatures {
  const { featureFlags } = useStudioUIConfig();
  const { kpi, chart, grid } = featureFlags;
  return {
    compose: featureFlags.compose ?? true,
    filters: featureFlags.filters ?? true,
    quickFilter: featureFlags.quickFilter ?? false,
    savedFilterViews: featureFlags.savedFilterViews ?? true,
    dataManagement: featureFlags.dataManagement ?? true,
    relationships: featureFlags.relationships ?? true,
    widgetFilters: featureFlags.widgetFilters ?? true,
    aiChat: featureFlags.aiChat ?? true,
    // Widget kinds: enabled when the flag is not `false` (true, undefined, or an object all enable the kind)
    grid: grid !== false,
    chart: chart !== false,
    kpi: kpi !== false,
    text: featureFlags.text ?? true,
    filter: featureFlags.filter ?? true,
    pivot: featureFlags.pivot ?? true,
    map: featureFlags.map ?? true,
    // KPI sub-flags
    kpiSparkline: resolveSubFlag<KpiFeatureFlags>(kpi, 'sparkline'),
    kpiTrend: resolveSubFlag<KpiFeatureFlags>(kpi, 'trend'),
    kpiTarget: resolveSubFlag<KpiFeatureFlags>(kpi, 'target'),
    kpiCalculatedFields: resolveSubFlag<KpiFeatureFlags>(kpi, 'calculatedFields'),
    // Chart sub-flags
    chartAnnotations: resolveSubFlag<ChartFeatureFlags>(chart, 'annotations'),
    chartCalculatedFields: resolveSubFlag<ChartFeatureFlags>(chart, 'calculatedFields'),
    // Grid sub-flags
    gridGroupBy: resolveSubFlag<GridFeatureFlags>(grid, 'groupBy'),
    gridSummary: resolveSubFlag<GridFeatureFlags>(grid, 'summary'),
    gridConditionalFormats: resolveSubFlag<GridFeatureFlags>(grid, 'conditionalFormats'),
    gridCalculatedFields: resolveSubFlag<GridFeatureFlags>(grid, 'calculatedFields'),
    // Global
    calculatedFields: featureFlags.calculatedFields ?? true,
  };
}
