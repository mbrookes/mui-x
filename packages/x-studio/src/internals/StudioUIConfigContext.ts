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
   * @param {string} kindLabel The localized widget-kind name (e.g. "Chart").
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

  // ── Widget type descriptions (shown in compose drawer widget picker) ───────
  widgetKindTextDescription: string;
  widgetKindKpiDescription: string;
  widgetKindChartDescription: string;
  widgetKindGridDescription: string;
  widgetKindFilterDescription: string;
  widgetKindPivotDescription: string;
  widgetKindMapDescription: string;
  /** Fallback description for consumer-defined custom widget types. */
  composeCustomWidgetDescription: string;

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
   * @param {string} widgetTypeLabel The localized widget-type name (e.g. "Chart").
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
  textFormatDefaultFont: string;
  textFormatSerifFont: string;
  textFormatMonospaceFont: string;
  textFormatDefaultSize: string;
  textFormatAlignmentLabel: string;

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
  dataDrawerAddCalculatedField: string;
  dataDrawerNoData: (sourceLabel: string) => string;
  dataDrawerMoreRows: (count: number) => string;
  dataDrawerMoreColumns: (count: number) => string;
  dataDrawerViewSourceLink: string;
  dataDrawerMorePreviewRows: (count: number) => string;
  lineageTypePrefix: (type: string) => string;
  lineageJoinDetail: (
    srcSource: string,
    srcField: string,
    tgtSource: string,
    tgtField: string,
  ) => string;
  lineageViaDetail: (via: string) => string;
  lineagePreviewAriaLabel: (label: string) => string;
  lineageNoRelationships: string;

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
  relationshipAddTitle: string;
  relationshipEditTitle: string;
  relationshipSourceManyLabel: string;
  relationshipSourceLabel: string;
  relationshipTargetOneLabel: string;
  relationshipTargetLabel: string;
  relationshipUpdate: string;
  relationshipAdd: string;
  relationshipSectionTitle: string;
  relationshipAddButton: string;
  relationshipNone: string;
  relationshipVia: (junctionLabel: string) => string;

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
  filterMetricCurrentValue: string;
  filterSelectionNoValues: string;
  filterSelectionAll: string;
  filterSelectionSelectedCount: (count: number) => string;
  filterSectionNoInteractiveFilters: string;
  filterSectionNoCrossFilters: string;
  filterSectionSelectedCount: (count: number) => string;
  filterSectionValueDisplay: (fieldLabel: string, value: string) => string;
  filterSectionSourcePrefix: (widgetTitle: string) => string;
  filterBodyAddCondition: string;
  filterBodyNarrowOptions: string;
  filterModeFilter: string;
  filterModeSelect: string;
  filterModeRank: string;
  filterRelativeUnitSeconds: string;
  filterRelativeUnitMinutes: string;
  filterRelativeUnitHours: string;
  filterRelativeUnitDays: string;
  filterRelativeUnitWeeks: string;
  filterRelativeUnitMonths: string;
  filterRelativeUnitYears: string;
  filterDatePreset7Days: string;
  filterDatePreset30Days: string;
  filterDatePreset3Months: string;
  filterDatePreset12Months: string;
  filterDatePreset1Year: string;
  filterRelativeDateAgo: string;
  filterRelativeDateFromNow: string;
  filterDateLabel: string;
  filterRankAggSumLabel: string;
  filterRankAggAvgLabel: string;
  filterRankAggMaxLabel: string;
  filterRankAggMinLabel: string;
  filterRankTop: string;
  filterRankBottom: string;

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
  crossFilterModeHighlight: string;
  crossFilterModeFilter: string;
  crossFilterModeNone: string;

  // ── Chart setup panel ─────────────────────────────────────────────────────
  chartTypePickerLabel: string;
  chartTypeBarGrouped: string;
  chartTypeBarStacked: string;
  chartTypeBar100: string;
  chartTypeBarHorizontal: string;
  chartTypeBarStackedHorizontal: string;
  chartTypeBar100Horizontal: string;
  chartTypeLine: string;
  chartTypeArea: string;
  chartTypeAreaStacked: string;
  chartTypeArea100: string;
  chartTypeScatter: string;
  chartTypeMixed: string;
  chartTypeHeatmap: string;
  chartTypeFunnel: string;
  chartTypeGantt: string;
  chartTypeSankey: string;
  chartTypePie: string;
  chartTypeDonut: string;
  chartTypeGauge: string;
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
  chartSetupSankeySourceLabel: string;
  chartSetupSankeySourceHelperText: string;
  chartSetupSankeyTargetLabel: string;
  chartSetupSankeyTargetHelperText: string;
  chartSetupSankeyValueHelperText: string;
  chartSetupSankeyLinkColorLabel: string;
  chartSetupSankeyLinkColorSource: string;
  chartSetupSankeyLinkColorTarget: string;
  chartSetupSankeyShowValuesLabel: string;
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
  chartSetupXFieldNumericLabel: string;
  chartSetupXFieldCategoryVertLabel: string;
  chartSetupXFieldCategoryHorizLabel: string;
  chartSetupXFieldHorizontalHelperText: string;
  chartSetupXFieldGroupVertHelperText: string;
  chartSetupXFieldGroupHorizHelperText: string;
  chartSetupYMeasureFieldsLabel: string;
  chartSetupXMeasureFieldsLabel: string;
  chartSetupYMeasureFieldLabel: string;
  chartSetupXMeasureFieldLabel: string;
  chartSetupNoDataAlert: string;
  chartSetupSeriesLabel: (index: number) => string;
  chartSetupSeriesNumericHorizHelperText: string;
  chartSetupSeriesNumericSumHelperText: string;
  chartSetupMixedSeriesBar: string;
  chartSetupMixedSeriesLine: string;
  chartSetupCalculatedField: string;
  chartSetupCategoryFieldLabel: string;
  chartSetupRemoveSplitByTooltip: string;
  chartSetupInnerRingLabel: string;
  chartSetupSplitByLabel: string;
  chartSetupArcLabelsTitle: string;
  chartSetupSplitByHelperText: string;
  chartSetupSplitByDisabledHelperText: string;
  chartSetupInnerRingHelperText: string;

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
  kpiSetupDateRangeLabel: string;
  kpiSetupDateRangeFieldLabel: string;
  kpiSetupCompPeriodLabel: string;
  kpiSetupDateAggEarliest: string;
  kpiSetupDateAggLatest: string;
  kpiSetupFillAreaLabel: string;
  kpiSetupCumulativeLabel: string;
  kpiSetupAutoDateFilterPrefix: string;
  kpiSetupCalculatedField: string;
  kpiSetupTargetHelperText: string;
  kpiSetupInvertColours: string;

  // ── KPI widget ─────────────────────────────────────────────────────────────
  kpiGrandTotalTooltip: string;
  kpiGranularityAutoLabel: string;
  kpiWidgetComparisonTargetLabel: string;

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
  gridSetupChooseSourceHelper: string;
  gridSetupNoSourceAlert: string;
  gridSetupColumnsTitle: string;
  gridSetupColumnOptionsAriaLabel: (label: string) => string;
  gridSetupColumnGroupLabel: string;
  gridSetupColumnRemove: string;
  gridSetupColumnAggNone: string;
  gridSetupColumnAggUnique: string;
  gridSetupColumnAggSummaryTooltip: string;
  gridSetupColumnAggLabel: (isGroupBy: boolean, aggLabel: string) => string;
  gridSetupColumnSetAggTooltip: string;
  gridSetupAddColumn: string;
  gridSetupCalculatedColumn: string;
  gridSetupAddRule: string;
  gridSetupCFContains: string;
  gridSetupCFIsEmpty: string;
  gridSetupCFNotEmpty: string;
  gridSetupCFStyleRed: string;
  gridSetupCFStyleGreen: string;
  gridSetupCFStyleYellow: string;
  gridSetupCFStyleBlue: string;
  gridSetupCFStyleBold: string;

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
  mapSetupLegendAlignLabel: string;
  mapSetupLegendAlignStart: string;
  mapSetupLegendAlignCenter: string;
  mapSetupLegendAlignEnd: string;
  mapFormatLegendAlignLeft: string;
  mapFormatLegendAlignRight: string;
  mapSetupRegionFieldLabel: string;
  mapSetupRegionFieldHelperText: string;

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
  inlineFormulaBarAutoHelperText: string;
  inlineFormulaBarCancelButton: string;
  inlineFormulaBarAddButton: string;
  inlineFormulaBarFieldOperandLabel: string;
  inlineFormulaBarNumberOperandLabel: string;
  inlineFormulaBarOperandTypeAriaLabel: (label: string) => string;
  inlineFormulaBarButtonLabel: string;
  inlineFormulaBarOperandALabel: string;
  inlineFormulaBarOperandBLabel: string;

  // ── Field detail view ─────────────────────────────────────────────────────
  fieldDetailRowSourceId: string;
  fieldDetailRowName: string;
  fieldDetailRowDescription: string;
  fieldDetailRowDataType: string;
  fieldDetailRowCalculationType: string;
  fieldDetailRowNoCalculation: string;
  fieldDetailRowFormat: string;
  fieldDetailNumberFormatLabel: string;
  fieldDetailNumberFormatDefault: string;
  fieldDetailFormatInteger: string;
  fieldDetailFormatDecimal: string;
  fieldDetailFormatPercent: string;
  fieldDetailFormatCurrency: string;

  // ── Filters drawer ─────────────────────────────────────────────────────────────
  filtersDrawerRenameViewTooltip: string;
  filtersSectionWidgetTitle: (title: string) => string;
  filtersRenameViewAriaLabel: string;
  filtersRenameViewButtonAriaLabel: (name: string) => string;
  filtersDeleteViewAriaLabel: (name: string) => string;

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
  filterSetupSliderRangeHelperText: string;

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
  pageConfigPaddingNone: string;
  pageConfigPaddingSmall: string;
  pageConfigPaddingMedium: string;
  pageConfigPaddingLarge: string;

  // ── AI insight panel ──────────────────────────────────────────────────────
  insightTypeSummary: string;
  insightTypeAnalysis: string;
  insightTypeForecast: string;
  insightTypeAnomaly: string;
  insightTypeCorrelation: string;

  // ── Filter widget controls ────────────────────────────────────────────────
  filterWidgetClearAriaLabel: string;
  filterWidgetSelectAllLabel: string;
  filterWidgetClearAllLabel: string;
  filterWidgetAllLabel: string;
  filterWidgetNoOptionsLabel: string;
  /** Returns a label like "3 selected" for the multi-select control. */
  filterWidgetSelectedCount: (count: number) => string;
  filterWidgetExcludeLabel: string;
  filterWidgetExcludingLabel: string;
  filterWidgetDateFromLabel: string;
  filterWidgetDateToLabel: string;
  filterWidgetNoFieldConfigured: string;

  // ── Date range bar ────────────────────────────────────────────────────────
  dateRangePresetAriaLabel: string;

  // ── Data source field select ──────────────────────────────────────────────
  dataSourceClearFieldAriaLabel: string;
  dataSourceAddCalculatedField: string;

  // ── Widget filter row ─────────────────────────────────────────────────────
  widgetFilterFieldHelperText: string;
  drawerPanelOpenAriaLabel: (title: string) => string;
  drawerPanelCloseNamedAriaLabel: (title: string) => string;
  sidebarPanelToggleAriaLabel: (isActive: boolean, label: string) => string;
  addWidgetGroupAriaLabel: (groupLabel: string) => string;
  addWidgetSelectAriaLabel: (label: string) => string;
  formatPanelNoSubtitlePlaceholder: string;

  // ── Widget filters panel (always-on widget-level conditions) ──────────────
  widgetFiltersPanelNoSource: string;
  widgetFiltersPanelDescription: string;
  widgetFiltersPanelNoFilters: string;
  widgetFiltersPanelAddButton: string;

  // ── Expression field preview ───────────────────────────────────────────────
  /** Returns label like "Preview (measure over 1,000 rows)" */
  expressionPreviewMeasureLabel: (count: number) => string;
  /** Returns label like "Preview (first 100 rows)" */
  expressionPreviewFirstRowsLabel: (count: number) => string;

  // ── Pivot widget ──────────────────────────────────────────────────────────
  /** Returns e.g. "12 rows × 5 columns" */
  pivotRowsColumnsLabel: (rowCount: number, colCount: number) => string;

  // ── Gantt chart ───────────────────────────────────────────────────────────
  /** Returns e.g. "+3 more rows not shown: increase widget height to see all" */
  ganttHiddenRowsLabel: (count: number) => string;

  // ── Color input ───────────────────────────────────────────────────────────
  /** Returns e.g. "Clear background colour" */
  colorInputClearAriaLabel: (label: string) => string;

  // ── KPI widget ─────────────────────────────────────────────────────────────
  /** Label shown when the trend delta is infinite (no previous data) */
  kpiTrendNewLabel: string;
  /** Returns e.g. "Target: 5000" */
  kpiTrendTargetTooltip: (value: number | string) => string;
  /** Returns e.g. "Previous period: Q1 2024" */
  kpiTrendPreviousPeriodTooltip: (period: string) => string;
  /** Hint shown when a time field is needed to display the trend */
  kpiTrendNoDateFilterHint: string;
  /** Hint shown when a time field is needed to display the sparkline */
  kpiSparklineNoTimeFieldHint: string;

  // ── Chart widget ──────────────────────────────────────────────────────────
  /** Error shown when a mixed chart has fewer than 2 measure fields */
  chartMixedRequiresFieldsHint: string;
  /** Fallback series label when no field label is available */
  chartDefaultSeriesLabel: string;

  // ── Map widget ────────────────────────────────────────────────────────────
  /** Returns the unconfigured-map hint, e.g. "Use the Setup tab to choose a country field and a value field." */
  widgetConfigureMapFieldHint: (fieldLabel: string) => string;

  // ── Pivot table ───────────────────────────────────────────────────────────
  pivotCornerHeaderAriaLabel: string;
  /** Label shown for empty/null pivot dimension values */
  pivotBlankValueLabel: string;
  /** Label shown for the totals row/column */
  pivotTotalLabel: string;

  // ── Expression field dialog ───────────────────────────────────────────────
  /** Dialog title when editing an existing calculated field */
  exprDialogEditTitle: string;
  /** Dialog title when creating a new calculated field */
  exprDialogNewTitle: string;

  // ── AI chat suggestions ───────────────────────────────────────────────────
  /** e.g. "Bar chart: Revenue by Country" */
  aiSuggestionBarChart: (numericLabel: string, catLabel: string) => string;
  /** e.g. "KPI: total Revenue" */
  aiSuggestionKpi: (fieldLabel: string) => string;
  /** e.g. "Table from Orders" */
  aiSuggestionTable: (sourceLabel: string) => string;
  /** e.g. 'Change "Revenue" to line chart' */
  aiSuggestionChangeToLine: (widgetTitle: string) => string;
  /** e.g. 'Add sparkline to "Total Orders"' */
  aiSuggestionAddSparkline: (widgetTitle: string) => string;
  aiSuggestionAddDateFilter: string;
  aiSuggestionAddPage: string;
  aiSuggestionSummarisePage: string;
  aiSuggestionWhatDataAvailable: string;
  /** Default name for a new AI chat thread */
  chatNewConversationName: string;
  /** Tooltip on the thread-switcher button */
  chatSwitchConversationTooltip: string;
  /** Tooltip on the mic button when voice input is inactive */
  chatVoiceInputStart: string;
  /** Tooltip on the mic button when voice input is active (click to stop) */
  chatVoiceInputStop: string;
  /** Tooltip/aria-label shown when SpeechRecognition is not available */
  chatVoiceInputNotSupported: string;
  /** Tooltip shown on the copy-message button before copying */
  chatMessageCopyTooltip: string;
  /** Tooltip shown on the copy-message button after copying (for ~2 s) */
  chatMessageCopiedTooltip: string;
  /** aria-label on the copy-message icon button */
  chatMessageCopyAriaLabel: string;
  /** Tooltip / aria-label on the retry-message icon button */
  chatMessageRetryTooltip: string;

  // ── Chart cross-source error messages ────────────────────────────────────
  chartUnsupportedFieldNotFound: string;
  chartUnsupportedMixedCrossSource: string;
  chartUnsupportedScatterCrossSource: string;
  chartUnsupportedDefault: string;
  /** Label for the forecast trend series in the chart legend */
  chartForecastSeriesLabel: string;

  // ── Grid summary row aggregation labels ──────────────────────────────────
  gridSummaryLabelSum: string;
  gridSummaryLabelAvg: string;
  gridSummaryLabelCount: string;
  gridSummaryLabelCountDistinct: string;
  gridSummaryLabelMin: string;
  gridSummaryLabelMax: string;

  // ── Auto-generated widget titles (inferWidgetTitles) ─────────────────────
  /** Fallback when no source: e.g. "Chart" */
  widgetAutoTitleChart: string;
  /** Fallback: e.g. "KPI" */
  widgetAutoTitleKpi: string;
  /** Fallback: e.g. "Table" */
  widgetAutoTitleTable: string;
  /** Fallback: e.g. "Filter" */
  widgetAutoTitleFilter: string;
  /** Fallback: e.g. "Pivot Table" */
  widgetAutoTitlePivot: string;
  /** Fallback: e.g. "Map" */
  widgetAutoTitleMap: string;
  /** Fallback: e.g. "Widget" */
  widgetAutoTitleDefault: string;
  /** Glue word for scatter/pivot/map: "Revenue vs Units", "Row by Col" */
  widgetAutoTitleVs: string;
  widgetAutoTitleBy: string;
  /** Suffix in chart subtitle: "split by Category" */
  widgetAutoTitleSplitBy: string;
  /** Glue word for map: "Total Revenue by Country" */
  widgetAutoTitleByCountry: string;
  /** Suffix on source-named fallback: e.g. "Orders chart" */
  widgetAutoTitleSourceSuffixChart: string;
  widgetAutoTitleSourceSuffixKpi: string;
  widgetAutoTitleSourceSuffixPivot: string;
  widgetAutoTitleSourceSuffixMap: string;
  /** Label prefix for filter widget title: "Filter: {field}" */
  widgetAutoTitleFilterPrefix: string;
  /** KPI aggregation prefixes */
  widgetAggPrefixSum: string;
  widgetAggPrefixAvg: string;
  widgetAggPrefixCount: string;
  widgetAggPrefixMin: string;
  widgetAggPrefixMax: string;
  widgetAggPrefixCountDistinct: string;
  /** Time-grouping prefixes for chart auto-titles */
  widgetGroupByPrefixDay: string;
  widgetGroupByPrefixWeek: string;
  widgetGroupByPrefixMonth: string;
  widgetGroupByPrefixQuarter: string;
  widgetGroupByPrefixYear: string;
  /** "+N more" in field list summaries */
  widgetAutoTitleMoreFields: (count: number) => string;

  // ── Date filter labels ────────────────────────────────────────────────────
  /** "Last 7 days", "Last 1 month" */
  dateFilterLast: (amount: number, unit: string) => string;
  /** "Next 7 days", "Next 1 month" */
  dateFilterNext: (amount: number, unit: string) => string;
  /** "From {date}" in a between filter with only a start date */
  dateFilterFrom: (date: string) => string;
  /** "Up to {label}" for a relative ≤ filter */
  dateFilterUpTo: (label: string) => string;
  /** "Since {date}" for an absolute ≥ filter */
  dateFilterSince: (date: string) => string;
  /** "Until {date}" for an absolute ≤ filter */
  dateFilterUntil: (date: string) => string;
  /** Singular/plural unit labels used in relative date filters */
  dateFilterUnitYear: string;
  dateFilterUnitYears: string;
  dateFilterUnitMonth: string;
  dateFilterUnitMonths: string;
  dateFilterUnitWeek: string;
  dateFilterUnitWeeks: string;
  dateFilterUnitDay: string;
  dateFilterUnitDays: string;
  dateFilterUnitHour: string;
  dateFilterUnitHours: string;
  dateFilterUnitMinute: string;
  dateFilterUnitMinutes: string;
  dateFilterUnitSecond: string;
  dateFilterUnitSeconds: string;

  // ── Expression field dialog — measure checkbox ────────────────────────────
  exprMeasureLabel: string;
  exprMeasureHelperText: string;
  exprDimensionHelperText: string;

  // ── Chart color scheme options ────────────────────────────────────────────
  chartColorSchemePrimary: string;
  chartColorSchemeSuccess: string;
  chartColorSchemeWarning: string;
  chartColorSchemeError: string;

  // ── Widget delete confirmation dialog ─────────────────────────────────────
  /** Title of the confirmation dialog shown before deleting a widget */
  widgetDeleteConfirmTitle: string;
  /** Body message in the delete confirmation dialog */
  widgetDeleteConfirmMessage: string;
  /** Label for the confirm / destructive button */
  widgetDeleteConfirmOk: string;
  /** Label for the cancel button */
  widgetDeleteConfirmCancel: string;
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

  // Widget type descriptions
  widgetKindTextDescription: 'Title, subtitle, and body copy',
  widgetKindKpiDescription: 'Single metric with aggregation',
  widgetKindChartDescription: 'Visualise data with a configurable chart',
  widgetKindGridDescription: 'Data grid with sorting & filtering',
  widgetKindFilterDescription: 'Interactive filter control for view mode',
  widgetKindPivotDescription: 'Cross-tabulation with row/column dimensions',
  widgetKindMapDescription: 'Choropleth world map by country',
  composeCustomWidgetDescription: 'Custom widget',

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
  textFormatDefaultFont: 'Default (theme)',
  textFormatSerifFont: 'Serif',
  textFormatMonospaceFont: 'Monospace',
  textFormatDefaultSize: 'Default',
  textFormatAlignmentLabel: 'Alignment',

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
  dataDrawerAddCalculatedField: 'Add calculated field',
  dataDrawerNoData: (sourceLabel) => `No data available for ${sourceLabel}.`,
  dataDrawerMoreRows: (count) => `${count} more ${count === 1 ? 'row' : 'rows'}`,
  dataDrawerMoreColumns: (count) => `${count} more ${count === 1 ? 'column' : 'columns'}`,
  dataDrawerViewSourceLink: 'View source data →',
  dataDrawerMorePreviewRows: (count) => `+${count} more`,
  lineageTypePrefix: (type) => `Type: ${type}`,
  lineageJoinDetail: (srcSource, srcField, tgtSource, tgtField) =>
    `Join: ${srcSource}.${srcField} = ${tgtSource}.${tgtField}`,
  lineageViaDetail: (via) => `Via: ${via}`,
  lineagePreviewAriaLabel: (label) => `Preview ${label}`,
  lineageNoRelationships: 'No relationships defined between sources',

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
  relationshipAddTitle: 'Add relationship',
  relationshipEditTitle: 'Edit relationship',
  relationshipSourceManyLabel: 'Many side',
  relationshipSourceLabel: 'Source',
  relationshipTargetOneLabel: 'One side',
  relationshipTargetLabel: 'Target',
  relationshipUpdate: 'Update',
  relationshipAdd: 'Add',
  relationshipSectionTitle: 'Relationships',
  relationshipAddButton: 'Add',
  relationshipNone: 'No relationships configured.',
  relationshipVia: (junctionLabel) => `via ${junctionLabel}`,

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
  filterMetricCurrentValue: 'Current value:',
  filterSelectionNoValues: 'No values found.',
  filterSelectionAll: 'All',
  filterSelectionSelectedCount: (count) => `${count} selected`,
  filterSectionNoInteractiveFilters:
    'No interactive filters active. Use filter widgets on the canvas to set filters.',
  filterSectionNoCrossFilters:
    'No cross-filters active. Click on chart elements or select grid rows to create cross-filters.',
  filterSectionSelectedCount: (count) => `${count} selected`,
  filterSectionValueDisplay: (fieldLabel, value) => `${fieldLabel} = ${value}`,
  filterSectionSourcePrefix: (widgetTitle) => `From: ${widgetTitle}`,
  filterBodyAddCondition: 'Add condition',
  filterBodyNarrowOptions: 'Narrow options based on:',
  filterModeFilter: 'Filter',
  filterModeSelect: 'Select',
  filterModeRank: 'Rank',
  filterRelativeUnitSeconds: 'seconds',
  filterRelativeUnitMinutes: 'minutes',
  filterRelativeUnitHours: 'hours',
  filterRelativeUnitDays: 'days',
  filterRelativeUnitWeeks: 'weeks',
  filterRelativeUnitMonths: 'months',
  filterRelativeUnitYears: 'years',
  filterDatePreset7Days: '7 days',
  filterDatePreset30Days: '30 days',
  filterDatePreset3Months: '3 months',
  filterDatePreset12Months: '12 months',
  filterDatePreset1Year: '1 year',
  filterRelativeDateAgo: 'ago',
  filterRelativeDateFromNow: 'from now',
  filterDateLabel: 'Date',
  filterRankAggSumLabel: 'Sum of all series',
  filterRankAggAvgLabel: 'Average of all series',
  filterRankAggMaxLabel: 'Max of all series',
  filterRankAggMinLabel: 'Min of all series',
  filterRankTop: 'Top',
  filterRankBottom: 'Bottom',

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
  crossFilterModeHighlight: 'Highlight',
  crossFilterModeFilter: 'Filter',
  crossFilterModeNone: 'None',

  // Chart setup panel
  chartTypePickerLabel: 'Chart type',
  chartTypeBarGrouped: 'Bar (grouped)',
  chartTypeBarStacked: 'Bar (stacked)',
  chartTypeBar100: 'Bar (100%)',
  chartTypeBarHorizontal: 'Bar (horizontal)',
  chartTypeBarStackedHorizontal: 'Bar (stacked, horizontal)',
  chartTypeBar100Horizontal: 'Bar (100%, horizontal)',
  chartTypeLine: 'Line',
  chartTypeArea: 'Area',
  chartTypeAreaStacked: 'Area (stacked)',
  chartTypeArea100: 'Area (100%)',
  chartTypeScatter: 'Scatter',
  chartTypeMixed: 'Mixed (bar + line)',
  chartTypeHeatmap: 'Heatmap',
  chartTypeFunnel: 'Funnel',
  chartTypeGantt: 'Gantt / Timeline',
  chartTypeSankey: 'Sankey',
  chartTypePie: 'Pie',
  chartTypeDonut: 'Donut',
  chartTypeGauge: 'Gauge',
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
  chartSetupSankeySourceLabel: 'Source (from) field',
  chartSetupSankeySourceHelperText: 'Categorical field for the start node of each flow',
  chartSetupSankeyTargetLabel: 'Target (to) field',
  chartSetupSankeyTargetHelperText: 'Categorical field for the end node of each flow',
  chartSetupSankeyValueHelperText: 'Numeric field summed per source → target link',
  chartSetupSankeyLinkColorLabel: 'Link colour',
  chartSetupSankeyLinkColorSource: 'From source node',
  chartSetupSankeyLinkColorTarget: 'From target node',
  chartSetupSankeyShowValuesLabel: 'Show values on links',
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
  chartSetupXFieldNumericLabel: 'X field (numeric)',
  chartSetupXFieldCategoryVertLabel: 'Y / Category field',
  chartSetupXFieldCategoryHorizLabel: 'X / Category field',
  chartSetupXFieldHorizontalHelperText: 'Plotted on the horizontal axis',
  chartSetupXFieldGroupVertHelperText: 'Groups data along the vertical axis',
  chartSetupXFieldGroupHorizHelperText: 'Groups data along the horizontal axis',
  chartSetupYMeasureFieldsLabel: 'Y / Measure fields',
  chartSetupXMeasureFieldsLabel: 'X / Measure fields',
  chartSetupYMeasureFieldLabel: 'Y / Measure field',
  chartSetupXMeasureFieldLabel: 'X / Measure field',
  chartSetupNoDataAlert: 'No data fields available for chart configuration.',
  chartSetupSeriesLabel: (index) => `Series ${index + 1}`,
  chartSetupSeriesNumericHorizHelperText: 'Numeric field plotted along the horizontal axis',
  chartSetupSeriesNumericSumHelperText: 'Numeric field summed or averaged per category',
  chartSetupMixedSeriesBar: 'Bar',
  chartSetupMixedSeriesLine: 'Line',
  chartSetupCalculatedField: 'Calculated field…',
  chartSetupCategoryFieldLabel: 'Category field',
  chartSetupRemoveSplitByTooltip: 'Remove extra measure fields to enable split-by',
  chartSetupInnerRingLabel: 'Inner ring category',
  chartSetupSplitByLabel: 'Split by (series field)',
  chartSetupArcLabelsTitle: 'Arc labels',
  chartSetupSplitByHelperText: 'Divides data into a separate series per value',
  chartSetupSplitByDisabledHelperText: 'Not available when multiple measure fields are configured',
  chartSetupInnerRingHelperText: 'Adds a concentric inner ring grouped by this field',

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
  kpiSetupDateRangeLabel: 'Date range',
  kpiSetupDateRangeFieldLabel: 'Date field',
  kpiSetupCompPeriodLabel: 'Comparison period',
  kpiSetupDateAggEarliest: 'Earliest',
  kpiSetupDateAggLatest: 'Latest',
  kpiSetupFillAreaLabel: 'Fill area',
  kpiSetupCumulativeLabel: 'Cumulative (running total)',
  kpiSetupAutoDateFilterPrefix: 'Using date filter:',
  kpiSetupCalculatedField: 'Calculated field…',
  kpiSetupTargetHelperText:
    'Reference value for the target line on the sparkline. When Trend is also enabled, the delta badge compares the current value against this target.',
  kpiSetupInvertColours: 'Invert colours (lower is better)',

  // KPI widget
  kpiGrandTotalTooltip:
    'Grand total \u2014 active filter widgets are not applied to this KPI. Enable Cross-filter mode in KPI settings to respect them.',
  kpiGranularityAutoLabel: 'Auto',
  kpiWidgetComparisonTargetLabel: 'target',

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
  gridSetupChooseSourceHelper: 'Choose a data source to configure columns',
  gridSetupNoSourceAlert:
    "Select a data source above to configure this table's columns and settings.",
  gridSetupColumnsTitle: 'Columns',
  gridSetupColumnOptionsAriaLabel: (label) => `Options for ${label}`,
  gridSetupColumnGroupLabel: '(group)',
  gridSetupColumnRemove: 'Remove',
  gridSetupColumnAggNone: 'None',
  gridSetupColumnAggUnique: 'Unique',
  gridSetupColumnAggSummaryTooltip: 'Set summary / remove',
  gridSetupColumnAggLabel: (isGroupBy, aggLabel) =>
    `${isGroupBy ? 'Aggregate' : 'Summary'}: ${aggLabel}`,
  gridSetupColumnSetAggTooltip: 'Set aggregation',
  gridSetupAddColumn: 'Add column',
  gridSetupCalculatedColumn: 'Calculated column…',
  gridSetupAddRule: 'Add rule',
  gridSetupCFContains: 'contains',
  gridSetupCFIsEmpty: 'is empty',
  gridSetupCFNotEmpty: 'not empty',
  gridSetupCFStyleRed: 'Red',
  gridSetupCFStyleGreen: 'Green',
  gridSetupCFStyleYellow: 'Yellow',
  gridSetupCFStyleBlue: 'Blue',
  gridSetupCFStyleBold: 'Bold',

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
  mapSetupLegendAlignLabel: 'Legend alignment',
  mapSetupLegendAlignStart: 'Top',
  mapSetupLegendAlignCenter: 'Middle',
  mapSetupLegendAlignEnd: 'Bottom',
  mapFormatLegendAlignLeft: 'Left',
  mapFormatLegendAlignRight: 'Right',
  mapSetupRegionFieldLabel: 'Region field',
  mapSetupRegionFieldHelperText:
    'A field containing region identifiers matching the geography feature IDs.',

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
  inlineFormulaBarAutoHelperText: 'Auto-generated from the formula \u2014 edit to customise',
  inlineFormulaBarCancelButton: 'Cancel',
  inlineFormulaBarAddButton: 'Add',
  inlineFormulaBarFieldOperandLabel: 'Field',
  inlineFormulaBarNumberOperandLabel: 'Number',
  inlineFormulaBarOperandTypeAriaLabel: (label) => `${label} type`,
  inlineFormulaBarButtonLabel: 'Formula',
  inlineFormulaBarOperandALabel: 'A',
  inlineFormulaBarOperandBLabel: 'B',

  // Field detail view
  fieldDetailRowSourceId: 'Source ID',
  fieldDetailRowName: 'Name',
  fieldDetailRowDescription: 'Description',
  fieldDetailRowDataType: 'Data Type',
  fieldDetailRowCalculationType: 'Calculation Type',
  fieldDetailRowNoCalculation: 'No Calculation',
  fieldDetailRowFormat: 'Format',
  fieldDetailNumberFormatLabel: 'Number Format',
  fieldDetailNumberFormatDefault: 'Default',
  fieldDetailFormatInteger: 'Integer',
  fieldDetailFormatDecimal: 'Decimal',
  fieldDetailFormatPercent: 'Percent',
  fieldDetailFormatCurrency: 'Currency',

  // Filters drawer
  filtersDrawerRenameViewTooltip: 'Rename view',
  filtersSectionWidgetTitle: (title) => `Widget: ${title}`,
  filtersRenameViewAriaLabel: 'Rename saved view',
  filtersRenameViewButtonAriaLabel: (name) => `Rename view "${name}"`,
  filtersDeleteViewAriaLabel: (name) => `Delete view "${name}"`,

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
  filterSetupSliderRangeHelperText: 'Slider range (leave blank to auto-detect from data)',

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
  pageConfigPaddingNone: 'None',
  pageConfigPaddingSmall: 'Small (8px)',
  pageConfigPaddingMedium: 'Medium (16px)',
  pageConfigPaddingLarge: 'Large (24px)',

  // AI insight panel
  insightTypeSummary: 'Summary',
  insightTypeAnalysis: 'Analysis',
  insightTypeForecast: 'Forecast',
  insightTypeAnomaly: 'Anomaly Explanation',
  insightTypeCorrelation: 'Correlation Analysis',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Clear filter',
  filterWidgetSelectAllLabel: 'Select all',
  filterWidgetClearAllLabel: 'Clear all',
  filterWidgetAllLabel: 'All',
  filterWidgetNoOptionsLabel: 'No options found',
  filterWidgetSelectedCount: (count) => `${count} selected`,
  filterWidgetExcludeLabel: 'Exclude selected',
  filterWidgetExcludingLabel: '\u2298 Excluding selected',
  filterWidgetDateFromLabel: 'From',
  filterWidgetDateToLabel: 'To',
  filterWidgetNoFieldConfigured: 'No field configured. Select a field in the Compose panel.',

  // Date range bar
  dateRangePresetAriaLabel: 'Date range preset',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Clear field',
  dataSourceAddCalculatedField: 'Add calculated field…',

  // Widget filter row
  widgetFilterFieldHelperText: 'Field this filter applies to',
  drawerPanelOpenAriaLabel: (title) => `Open ${title} panel`,
  drawerPanelCloseNamedAriaLabel: (title) => `Close ${title} panel`,
  sidebarPanelToggleAriaLabel: (isActive, label) =>
    isActive ? `Close ${label} panel` : `Open ${label} panel`,
  addWidgetGroupAriaLabel: (groupLabel) => `${groupLabel} widgets`,
  addWidgetSelectAriaLabel: (label) => `Select widget: ${label}`,
  formatPanelNoSubtitlePlaceholder: 'No subtitle',

  // Widget filters panel
  widgetFiltersPanelNoSource: 'This widget has no data source.',
  widgetFiltersPanelDescription:
    'Always-on conditions applied to this widget\u2019s data before any interactive filters.',
  widgetFiltersPanelNoFilters: 'No filters, all data is shown.',
  widgetFiltersPanelAddButton: 'Add filter',

  // Expression field preview
  expressionPreviewMeasureLabel: (count) => `Preview (measure over ${count.toLocaleString()} rows)`,
  expressionPreviewFirstRowsLabel: (count) => `Preview (first ${count.toLocaleString()} rows)`,

  // Pivot widget
  pivotRowsColumnsLabel: (rowCount, colCount) => `${rowCount} rows \u00d7 ${colCount} columns`,

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} more rows not shown: increase widget height to see all`,

  // Color input
  colorInputClearAriaLabel: (label) => `Clear ${label.toLowerCase()}`,

  // KPI widget
  kpiTrendNewLabel: 'New',
  kpiTrendTargetTooltip: (value) => `Target: ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Previous period: ${period}`,
  kpiTrendNoDateFilterHint: 'Add a date filter to show the trend.',
  kpiSparklineNoTimeFieldHint: 'Add a date filter or select a time field to show a sparkline.',

  // Chart widget
  chartMixedRequiresFieldsHint: 'Mixed chart requires 2 or more measure fields.',
  chartDefaultSeriesLabel: 'Value',

  // Map widget
  widgetConfigureMapFieldHint: (fieldLabel) =>
    `Use the Setup tab to choose a ${fieldLabel.toLowerCase()} and a value field.`,

  // Pivot table
  pivotCornerHeaderAriaLabel: 'Row / column header',
  pivotBlankValueLabel: '(blank)',
  pivotTotalLabel: 'Total',

  // Expression field dialog
  exprDialogEditTitle: 'Edit Calculated Field',
  exprDialogNewTitle: 'New Calculated Field',

  // AI chat suggestions
  aiSuggestionBarChart: (numericLabel, catLabel) => `Bar chart: ${numericLabel} by ${catLabel}`,
  aiSuggestionKpi: (fieldLabel) => `KPI: total ${fieldLabel}`,
  aiSuggestionTable: (sourceLabel) => `Table from ${sourceLabel}`,
  aiSuggestionChangeToLine: (widgetTitle) => `Change \u201c${widgetTitle}\u201d to line chart`,
  aiSuggestionAddSparkline: (widgetTitle) => `Add sparkline to \u201c${widgetTitle}\u201d`,
  aiSuggestionAddDateFilter: 'Add a date filter',
  aiSuggestionAddPage: 'Add a new page',
  aiSuggestionSummarisePage: 'Summarise page',
  aiSuggestionWhatDataAvailable: 'What data is available?',
  chatNewConversationName: 'New conversation',
  chatSwitchConversationTooltip: 'Switch conversation',
  chatVoiceInputStart: 'Start voice input',
  chatVoiceInputStop: 'Stop voice input',
  chatVoiceInputNotSupported: 'Voice input is not supported in this browser',
  chatMessageCopyTooltip: 'Copy',
  chatMessageCopiedTooltip: 'Copied!',
  chatMessageCopyAriaLabel: 'Copy message',
  chatMessageRetryTooltip: 'Retry',

  // Chart cross-source error messages
  chartUnsupportedFieldNotFound:
    'This chart configuration uses fields that are not available on the widget source or a directly related source.',
  chartUnsupportedMixedCrossSource:
    'This chart configuration mixes cross-source fields in a way that does not have a single safe aggregation grain yet.',
  chartUnsupportedScatterCrossSource:
    'Scatter charts do not support cross-source field combinations yet.',
  chartUnsupportedDefault: 'This chart configuration is not supported yet.',
  chartForecastSeriesLabel: 'Forecast',

  // Grid summary row aggregation labels
  gridSummaryLabelSum: 'Total:',
  gridSummaryLabelAvg: 'Avg:',
  gridSummaryLabelCount: 'Count:',
  gridSummaryLabelCountDistinct: 'Unique:',
  gridSummaryLabelMin: 'Min:',
  gridSummaryLabelMax: 'Max:',

  // Auto-generated widget titles
  widgetAutoTitleChart: 'Chart',
  widgetAutoTitleKpi: 'KPI',
  widgetAutoTitleTable: 'Table',
  widgetAutoTitleFilter: 'Filter',
  widgetAutoTitlePivot: 'Pivot Table',
  widgetAutoTitleMap: 'Map',
  widgetAutoTitleDefault: 'Widget',
  widgetAutoTitleVs: 'vs',
  widgetAutoTitleBy: 'by',
  widgetAutoTitleSplitBy: 'split by',
  widgetAutoTitleByCountry: 'by Country',
  widgetAutoTitleSourceSuffixChart: 'chart',
  widgetAutoTitleSourceSuffixKpi: 'KPI',
  widgetAutoTitleSourceSuffixPivot: 'pivot',
  widgetAutoTitleSourceSuffixMap: 'map',
  widgetAutoTitleFilterPrefix: 'Filter',
  widgetAggPrefixSum: 'Total',
  widgetAggPrefixAvg: 'Average',
  widgetAggPrefixCount: 'Count of',
  widgetAggPrefixMin: 'Min',
  widgetAggPrefixMax: 'Max',
  widgetAggPrefixCountDistinct: 'Distinct',
  widgetGroupByPrefixDay: 'Daily',
  widgetGroupByPrefixWeek: 'Weekly',
  widgetGroupByPrefixMonth: 'Monthly',
  widgetGroupByPrefixQuarter: 'Quarterly',
  widgetGroupByPrefixYear: 'Yearly',
  widgetAutoTitleMoreFields: (count) => `+${count} more`,

  // Date filter labels
  dateFilterLast: (amount, unit) => `Last ${amount} ${unit}`,
  dateFilterNext: (amount, unit) => `Next ${amount} ${unit}`,
  dateFilterFrom: (date) => `From ${date}`,
  dateFilterUpTo: (label) => `Up to ${label}`,
  dateFilterSince: (date) => `Since ${date}`,
  dateFilterUntil: (date) => `Until ${date}`,
  dateFilterUnitYear: 'year',
  dateFilterUnitYears: 'years',
  dateFilterUnitMonth: 'month',
  dateFilterUnitMonths: 'months',
  dateFilterUnitWeek: 'week',
  dateFilterUnitWeeks: 'weeks',
  dateFilterUnitDay: 'day',
  dateFilterUnitDays: 'days',
  dateFilterUnitHour: 'hour',
  dateFilterUnitHours: 'hours',
  dateFilterUnitMinute: 'minute',
  dateFilterUnitMinutes: 'minutes',
  dateFilterUnitSecond: 'second',
  dateFilterUnitSeconds: 'seconds',

  // Expression field dialog — measure checkbox
  exprMeasureLabel: 'Measure (aggregate)',
  exprMeasureHelperText: 'Computes a single value over the full dataset (e.g. total revenue).',
  exprDimensionHelperText: 'Computes a value per row (e.g. price \u00d7 quantity).',

  // Chart color scheme options
  chartColorSchemePrimary: 'Primary (blue)',
  chartColorSchemeSuccess: 'Success (green)',
  chartColorSchemeWarning: 'Warning (orange)',
  chartColorSchemeError: 'Error (red)',

  // Widget delete confirmation dialog
  widgetDeleteConfirmTitle: 'Delete widget?',
  widgetDeleteConfirmMessage: 'This widget will be permanently removed from the page.',
  widgetDeleteConfirmOk: 'Delete',
  widgetDeleteConfirmCancel: 'Cancel',
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
  // Serialize the identifying keys so the memo only recomputes when the set of
  // registered widget kinds actually changes (a simple-expression dep keeps both
  // exhaustive-deps and use-memo happy without disabling them).
  const widgetKindsKey = JSON.stringify(customWidgets?.map((d) => d.kind));
  return React.useMemo(
    () => new Map((customWidgets ?? []).map((d) => [d.kind, d])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- widgetKindsKey is a deep-equality proxy for customWidgets
    [widgetKindsKey],
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
  // Serialize the override keys so the merged map is only rebuilt when the set of
  // consumer-provided geographies changes (a simple-expression dep keeps both
  // exhaustive-deps and use-memo happy without disabling them).
  const geographyKeysKey = JSON.stringify(Object.keys(geographies ?? {}));
  return React.useMemo(
    () => ({ ...BUILT_IN_GEOGRAPHY_DEFINITIONS, ...geographies }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geographyKeysKey is a deep-equality proxy for geographies
    [geographyKeysKey],
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
