---
title: Studio - Localization
description: Localize all built-in strings in the Studio UI or override individual tokens.
---

# Studio - Localization

<p class="description">Localize all built-in strings in the Studio UI or override individual tokens.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

All user-visible strings in Studio are driven by a `localeText` prop on the `<Studio>` and `<StudioDashboard>` components.
Pass a full translation object or a partial override to change any subset of strings.
Tokens you do not provide fall back to the English defaults.

## Built-in translations

Studio ships with the following built-in translations:

| Import name | Locale  | Language             |
| :---------- | :------ | :------------------- |
| `enUS`      | `en-US` | English (default)    |
| `ptBR`      | `pt-BR` | Brazilian Portuguese |
| `fr`        | `fr-FR` | French               |
| `de`        | `de-DE` | German               |
| `es`        | `es-ES` | Spanish              |

### `localeText` prop

Pass a locale's `localeText` directly to the component:

```tsx
import { Studio, ptBRLocaleText } from '@mui/x-studio';

<Studio localeText={ptBRLocaleText} initialState={myState} />;
```

For the newer `fr`, `de`, and `es` locales:

```tsx
import { Studio, frLocaleText } from '@mui/x-studio';

<Studio localeText={frLocaleText} initialState={myState} />;
```

### Theme-level locale

Use `getStudioLocalization()` with MUI's `createTheme()` to apply a locale to your entire theme, consistent with other MUI X packages:

```tsx
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { ptBR } from '@mui/x-studio';

const theme = createTheme(ptBR);

<ThemeProvider theme={theme}>
  <Studio initialState={myState} />
</ThemeProvider>;
```

You can combine multiple MUI X locales in a single `createTheme()` call:

```tsx
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { ptBR as datePtBR } from '@mui/x-date-pickers/locales';
import { ptBR as studioPtBR } from '@mui/x-studio';

const theme = createTheme(studioPtBR, datePtBR);
```

## Partial override

You do not need to provide every string. Pass only the tokens you want to change:

```tsx
<Studio
  localeText={{
    filtersDrawerTitle: 'Refine',
    widgetNoData: 'Nothing to show here',
  }}
/>
```

## All string tokens

The full `StudioLocaleText` interface lists every token you can override.
Defaults are the English strings shown in the right column.

### Drawer titles

| Token                | Default     |
| :------------------- | :---------- |
| `dataDrawerTitle`    | `'Data'`    |
| `composeDrawerTitle` | `'Compose'` |
| `filtersDrawerTitle` | `'Filters'` |

### Date range presets

| Token                         | Default            |
| :---------------------------- | :----------------- |
| `dateRangePresetAllTime`      | `'All time'`       |
| `dateRangePresetYTD`          | `'YTD'`            |
| `dateRangePresetThisMonth`    | `'This month'`     |
| `dateRangePresetLast3Months`  | `'Last 3 months'`  |
| `dateRangePresetLast12Months` | `'Last 12 months'` |

### Quick filter date range bar

| Token                    | Default        |
| :----------------------- | :------------- |
| `dateRangeBarFieldLabel` | `'Date range'` |
| `filterFieldLabel`       | `'Field'`      |

### Filters panel

| Token                             | Default                                                    |
| :-------------------------------- | :--------------------------------------------------------- |
| `filterSearchPlaceholder`         | `'Search filters…'`                                        |
| `filtersSectionPageFiltersTitle`  | `'Page filters'`                                           |
| `filtersSectionNoFilters`         | `'No filters applied.'`                                    |
| `filtersSectionNoMatchingFilters` | `'No matching filters.'`                                   |
| `filtersAddFilterTooltip`         | `'Add filter'`                                             |
| `filtersSavedViewsTitle`          | `'Saved views'`                                            |
| `filtersSaveViewTooltip`          | `'Save current page filters as a named view'`              |
| `filtersSaveViewButton`           | `'Save'`                                                   |
| `filtersSaveViewPlaceholder`      | `'View name'`                                              |
| `filtersDeleteViewTooltip`        | `'Delete view'`                                            |
| `filtersNoSavedViews`             | `'No saved views. Apply page filters and save them here.'` |
| `filtersAddDataSourceHint`        | `'Add a data source and widgets first.'`                   |
| `filtersDrawerRenameViewTooltip`  | `'Rename view'`                                            |

### Widget states

| Token                      | Default                                                            |
| :------------------------- | :----------------------------------------------------------------- |
| `widgetConfigureChartHint` | `'Use the Setup tab to configure this chart.'`                     |
| `widgetConfigureGaugeHint` | `'Use the Setup tab to choose a gauge value field.'`               |
| `widgetConfigurePivotHint` | `'Use the Setup tab to configure row, column, and value fields.'`  |
| `widgetConfigureMapHint`   | `'Use the Setup tab to choose a country field and a value field.'` |
| `widgetNoData`             | `'No data to display.'`                                            |
| `widgetLoadError`          | `'Failed to load data'`                                            |

### Quick filter bar

| Token                       | Default                    |
| :-------------------------- | :------------------------- |
| `quickFilterBarOpenFilters` | `'Open filters panel'`     |
| `quickFilterBarClearAll`    | `'Clear all page filters'` |
| `quickFilterBarFiltered`    | `'Filtered'`               |

### Widget card actions

| Token                              | Default                          |
| :--------------------------------- | :------------------------------- |
| `widgetEditTooltip`                | `'Edit widget'`                  |
| `widgetExportCsvTooltip`           | `'Export as CSV'`                |
| `widgetExportPngTooltip`           | `'Export as PNG'`                |
| `widgetExpandTooltip`              | `'Expand chart'`                 |
| `widgetMoveToPageLabel`            | `'Move to page'`                 |
| `widgetDuplicateTooltip`           | `'Duplicate widget'`             |
| `widgetDeleteTooltip`              | `'Delete widget'`                |
| `widgetAiAssistantTooltip`         | `'AI assistant'`                 |
| `widgetAiInsightTooltip`           | `'AI insight'`                   |
| `widgetDetectAnomalyTooltip`       | `'Detect anomalies'`             |
| `widgetHideAnomalyTooltip`         | `'Hide anomalies'`               |
| `widgetExplainAnomalyTooltip`      | `'Explain anomalies'`            |
| `widgetCardCloseExpandedAriaLabel` | `'Close expanded chart'`         |
| `widgetCardExportPngAriaLabel`     | `'Export expanded chart as PNG'` |
| `numberFieldIncreaseAriaLabel`     | `'Increase'`                     |
| `numberFieldDecreaseAriaLabel`     | `'Decrease'`                     |

### Widget edit dialog

| Token                            | Default                         |
| :------------------------------- | :------------------------------ |
| `widgetEditDialogTabSetup`       | `'Setup'`                       |
| `widgetEditDialogTabFilters`     | `'Filters'`                     |
| `widgetEditDialogTabFormat`      | `'Format'`                      |
| `widgetEditDialogCloseAriaLabel` | `'Close edit dialog'`           |
| `widgetUntitledLabel`            | `(kindLabel: string) => string` |

### AI assistant

| Token                       | Default                        |
| :-------------------------- | :----------------------------- |
| `aiAssistantOpenTooltip`    | `'Open AI assistant'`          |
| `aiAssistantCloseTooltip`   | `'Close AI assistant'`         |
| `drawerPanelCloseAriaLabel` | `'Close widget configuration'` |
| `sidebarPanelsAriaLabel`    | `'Sidebar panels'`             |

### Natural language widget creation

| Token                       | Default                                        |
| :-------------------------- | :--------------------------------------------- |
| `aiCreateWidgetLabel`       | `'Describe a widget'`                          |
| `aiCreateWidgetPlaceholder` | `'e.g. Bar chart showing revenue by country…'` |
| `aiCreateWidgetButton`      | `'Create'`                                     |
| `aiCreateWidgetLoading`     | `'Creating…'`                                  |
| `aiCreateWidgetError`       | `'Failed to create widget'`                    |

### AI dashboard summary panel

These tokens are retained as public API for consumers who call `generateDashboardSummary` programmatically and build their own summary UI.

| Token                 | Default                 |
| :-------------------- | :---------------------- |
| `aiSummaryTitle`      | `'Dashboard Summary'`   |
| `aiSummarizeTooltip`  | `'Summarise dashboard'` |
| `aiRegenerateTooltip` | `'Regenerate'`          |
| `aiCopyTooltip`       | `'Copy'`                |
| `aiCopiedTooltip`     | `'Copied!'`             |
| `aiCloseTooltip`      | `'Close'`               |

### Widget type names

| Token              | Default         |
| :----------------- | :-------------- |
| `widgetKindGrid`   | `'Table'`       |
| `widgetKindChart`  | `'Chart'`       |
| `widgetKindKpi`    | `'KPI'`         |
| `widgetKindText`   | `'Text'`        |
| `widgetKindFilter` | `'Filter'`      |
| `widgetKindPivot`  | `'Pivot Table'` |
| `widgetKindMap`    | `'Map'`         |

### Data type labels

| Token              | Default         |
| :----------------- | :-------------- |
| `dataTypeString`   | `'Text'`        |
| `dataTypeNumber`   | `'Number'`      |
| `dataTypeBoolean`  | `'Boolean'`     |
| `dataTypeDate`     | `'Date'`        |
| `dataTypeDatetime` | `'Date & Time'` |

### Compose drawer / widget picker

| Token                               | Default                                                            |
| :---------------------------------- | :----------------------------------------------------------------- |
| `composeDrawerTabSetup`             | `'Setup'`                                                          |
| `composeChooseWidgetType`           | `'Choose a widget type'`                                           |
| `composeNoDataSources`              | `'No data sources available yet. Only text widgets can be added.'` |
| `composeOnThisPage`                 | `'On this page'`                                                   |
| `composeAddWidgetLabel`             | `(widgetTypeLabel: string) => string`                              |
| `composeCloseAriaLabel`             | `'Close'`                                                          |
| `composeBackToWidgetTypesAriaLabel` | `'Back to widget types'`                                           |
| `composeCancel`                     | `'Cancel'`                                                         |

### Format panel

| Token                              | Default                                   |
| :--------------------------------- | :---------------------------------------- |
| `formatAutoTitle`                  | `'Auto-generated title'`                  |
| `formatResetTitle`                 | `'Reset to auto-generated title'`         |
| `formatAutoSubtitle`               | `'Auto-generated subtitle'`               |
| `formatResetSubtitle`              | `'Reset to auto-generated subtitle'`      |
| `formatPanelCompactNumbers`        | `'Compact numbers'`                       |
| `formatPanelWidgetTitleLabel`      | `'Widget title'`                          |
| `formatPanelWidgetTitleHelperText` | `'Shown in the widget header'`            |
| `formatPanelSubtitleLabel`         | `'Subtitle'`                              |
| `formatPanelSubtitleHelperText`    | `'Optional line shown beneath the title'` |

### Text format panel

| Token                            | Default          |
| :------------------------------- | :--------------- |
| `textFormatFontFamilyLabel`      | `'Font family'`  |
| `textFormatFontSizeLabel`        | `'Font size'`    |
| `textFormatColorLabel`           | `'Color'`        |
| `textFormatColorPlaceholder`     | `'Default'`      |
| `textFormatAlignLeftAriaLabel`   | `'Align left'`   |
| `textFormatAlignCenterAriaLabel` | `'Align center'` |
| `textFormatAlignRightAriaLabel`  | `'Align right'`  |

### Data drawer

| Token                         | Default                                                                           |
| :---------------------------- | :-------------------------------------------------------------------------------- |
| `dataDrawerNoSources`         | `'No data sources configured. Add a widget from the canvas to load sample data.'` |
| `dataDrawerViewLineage`       | `'View data lineage'`                                                             |
| `dataDrawerLineageTitle`      | `'Data lineage'`                                                                  |
| `dataDrawerLineageHelper`     | `'Click a node to preview its data. Click an edge to inspect join key fields.'`   |
| `dataDrawerRowsLabel`         | `'rows'`                                                                          |
| `dataDrawerFieldsLabel`       | `'fields'`                                                                        |
| `dataDrawerBackAriaLabel`     | `'Back to lineage graph'`                                                         |
| `dataDrawerCloseAriaLabel`    | `'Close data lineage'`                                                            |
| `dataDrawerEditTooltip`       | `'Edit'`                                                                          |
| `dataDrawerDeleteTooltip`     | `'Delete'`                                                                        |
| `dataDrawerViewSourceTooltip` | `'View source data'`                                                              |

### Relationship management

| Token                               | Default                     |
| :---------------------------------- | :-------------------------- |
| `relationshipEditTooltip`           | `'Edit'`                    |
| `relationshipRemoveTooltip`         | `'Remove'`                  |
| `relationshipCancel`                | `'Cancel'`                  |
| `relationshipTypeManyToOne`         | `'Many-to-one'`             |
| `relationshipTypeOneToOne`          | `'One-to-one'`              |
| `relationshipTypeManyToMany`        | `'Many-to-many'`            |
| `relationshipTypeLabel`             | `'Type'`                    |
| `relationshipJoinFieldLabel`        | `'Join field'`              |
| `relationshipJunctionTableLabel`    | `'Junction (bridge) table'` |
| `relationshipJunctionSourceLabel`   | `'Junction source'`         |
| `relationshipJunctionSourceFkLabel` | `'→ Source FK'`             |
| `relationshipJunctionTargetFkLabel` | `'→ Target FK'`             |

### Filter conditions and values

| Token                             | Default                      |
| :-------------------------------- | :--------------------------- |
| `filterConditionAnd`              | `'AND'`                      |
| `filterConditionOr`               | `'OR'`                       |
| `filterOperatorLabel`             | `'Operator'`                 |
| `filterRemoveSecondCondition`     | `'Remove second condition'`  |
| `filterAbsoluteDate`              | `'Absolute date'`            |
| `filterRelativeDate`              | `'Relative date'`            |
| `filterBooleanTrue`               | `'True'`                     |
| `filterBooleanFalse`              | `'False'`                    |
| `filterRemoveAriaLabel`           | `'Remove filter'`            |
| `filterInteractiveSectionTitle`   | `'Interactive filters'`      |
| `filterCrossSectionTitle`         | `'Cross-filters'`            |
| `filterClearFilter`               | `'Clear filter'`             |
| `filterClearInteractiveAriaLabel` | `'Clear interactive filter'` |
| `filterClearAllCrossFilters`      | `'Clear all cross-filters'`  |
| `filterRemoveCrossFilter`         | `'Remove cross-filter'`      |
| `filterSearchValues`              | `'Search values…'`           |
| `filterSelectField`               | `'Select a field…'`          |
| `filterValueLabel`                | `'Value'`                    |
| `filterValueHelper`               | `'Value to compare against'` |
| `filterValueAmountLabel`          | `'Amount'`                   |
| `filterSelectParent`              | `'Select parent filter…'`    |
| `filterFieldLabel`                | `'Field'`                    |
| `filterRankByLabel`               | `'Rank by'`                  |

### Expression field dialog

| Token                              | Default                                                              |
| :--------------------------------- | :------------------------------------------------------------------- |
| `exprNodeTypeField`                | `'Field'`                                                            |
| `exprNodeTypeLiteral`              | `'Literal'`                                                          |
| `exprNodeTypeFunction`             | `'Function'`                                                         |
| `exprDataTypeNumber`               | `'Number'`                                                           |
| `exprDataTypeText`                 | `'Text'`                                                             |
| `exprDataTypeBoolean`              | `'Boolean'`                                                          |
| `exprBooleanTrue`                  | `'True'`                                                             |
| `exprBooleanFalse`                 | `'False'`                                                            |
| `exprExpandTooltip`                | `'Expand'`                                                           |
| `exprCollapseTooltip`              | `'Collapse'`                                                         |
| `exprRemoveInputTooltip`           | `'Remove input'`                                                     |
| `exprCancel`                       | `'Cancel'`                                                           |
| `exprSave`                         | `'Save'`                                                             |
| `exprAddField`                     | `'Add Field'`                                                        |
| `expressionNameLabel`              | `'Name'`                                                             |
| `expressionNameHelperText`         | `'Used as the field label in pickers and grid columns'`              |
| `expressionNamePlaceholder`        | `'e.g. Profit, Revenue per Unit'`                                    |
| `expressionDescriptionLabel`       | `'Description'`                                                      |
| `expressionDescriptionHelperText`  | `'Optional. Shown as a tooltip in field pickers'`                    |
| `expressionDescriptionPlaceholder` | `'Optional: describe what this field computes'`                      |
| `expressionPrecisionLabel`         | `'Precision'`                                                        |
| `expressionPrecisionHelperText`    | `'Decimal places (0–10) used when formatting this calculated field'` |

### Aggregation functions

| Token            | Default          |
| :--------------- | :--------------- |
| `aggFnSum`       | `'Sum'`          |
| `aggFnCount`     | `'Count'`        |
| `aggFnCountRows` | `'Count (rows)'` |
| `aggFnAverage`   | `'Average'`      |
| `aggFnMin`       | `'Min'`          |
| `aggFnMax`       | `'Max'`          |

### Time granularity

| Token             | Default               |
| :---------------- | :-------------------- |
| `timeGranNone`    | `'None (raw values)'` |
| `timeGranDay`     | `'Day'`               |
| `timeGranWeek`    | `'Week'`              |
| `timeGranMonth`   | `'Month'`             |
| `timeGranQuarter` | `'Quarter'`           |
| `timeGranYear`    | `'Year'`              |

### Sort direction

| Token                     | Default        |
| :------------------------ | :------------- |
| `sortAscendingAriaLabel`  | `'Ascending'`  |
| `sortDescendingAriaLabel` | `'Descending'` |

### Chart setup panel

| Token                                 | Default                                                                         |
| :------------------------------------ | :------------------------------------------------------------------------------ |
| `chartSetupValueFieldLabel`           | `'Value field'`                                                                 |
| `chartSetupValueFieldHelperText`      | `'Numeric field to aggregate'`                                                  |
| `chartSetupAggregationLabel`          | `'Aggregation'`                                                                 |
| `chartSetupMinLabel`                  | `'Min'`                                                                         |
| `chartSetupMaxLabel`                  | `'Max'`                                                                         |
| `chartSetupGroupByLabel`              | `'Group by'`                                                                    |
| `chartSetupSortByLabel`               | `'Sort by'`                                                                     |
| `chartSetupSortCategory`              | `'Category'`                                                                    |
| `chartSetupSortValue`                 | `'Value'`                                                                       |
| `chartSetupSortNone`                  | `'None'`                                                                        |
| `chartSetupSortPercent`               | `'Percent'`                                                                     |
| `chartSetupSortDirectionAriaLabel`    | `'Sort direction'`                                                              |
| `chartSetupAnnotationsTitle`          | `'Annotations'`                                                                 |
| `chartSetupInteractionsTitle`         | `'Interactions'`                                                                |
| `chartSetupInteractionsDescription`   | `'When other widgets are clicked, this chart…'`                                 |
| `chartSetupAddSeries`                 | `'Add series'`                                                                  |
| `chartSetupNoMoreFields`              | `'No more fields to add'`                                                       |
| `chartSetupRemoveSeries`              | `'Remove series'`                                                               |
| `chartSetupAddReferenceLine`          | `'Add reference line'`                                                          |
| `chartSetupRemoveAnnotation`          | `'Remove annotation'`                                                           |
| `chartSetupNoReferenceLines`          | `'No reference lines. Click + to add one.'`                                     |
| `chartSetupDualYAxis`                 | `'Dual Y axis (line series on right axis)'`                                     |
| `chartSetupReferenceLineValueLabel`   | `'Value'`                                                                       |
| `chartSetupReferenceLineLabelLabel`   | `'Label'`                                                                       |
| `chartSetupYFieldLabel`               | `'Y field (numeric)'`                                                           |
| `chartSetupYFieldHelperText`          | `'Numeric field plotted on the vertical axis'`                                  |
| `chartSetupColorByLabel`              | `'Color by (optional)'`                                                         |
| `chartSetupColorByHelperText`         | `'Splits points into colour-coded series per category'`                         |
| `chartSetupSizeByLabel`               | `'Size by (optional)'`                                                          |
| `chartSetupSizeByHelperText`          | `'Numeric field that controls bubble radius (produces a bubble chart)'`         |
| `chartSetupMinRadiusLabel`            | `'Min radius'`                                                                  |
| `chartSetupMaxRadiusLabel`            | `'Max radius'`                                                                  |
| `chartSetupFunnelValueHelperText`     | `'Numeric field summed per stage — stages are sorted by value (largest first)'` |
| `chartSetupHeatmapRowAxisLabel`       | `'Row axis field'`                                                              |
| `chartSetupHeatmapRowAxisHelperText`  | `'Categorical field for the vertical (row) axis, e.g. hour of day'`             |
| `chartSetupHeatmapValueLabel`         | `'Value / colour field'`                                                        |
| `chartSetupHeatmapValueHelperText`    | `'Numeric field summed per cell to determine colour intensity'`                 |
| `chartSetupHeatmapColourSchemeLabel`  | `'Colour scheme'`                                                               |
| `chartSetupArcLabelLabel`             | `'Arc label'`                                                                   |
| `chartSetupMinAngleLabel`             | `'Minimum angle (°)'`                                                           |
| `chartSetupMinAngleHelperText`        | `"Slices smaller than this angle (degrees) won't show a label"`                 |
| `chartSetupGanttLabelFieldLabel`      | `'Label field'`                                                                 |
| `chartSetupGanttLabelFieldHelperText` | `'Field shown as the row label on the Y axis (e.g. task or order name)'`        |
| `chartSetupGanttStartDateLabel`       | `'Start date field'`                                                            |
| `chartSetupGanttStartDateHelperText`  | `'Date / datetime field for the start of each bar'`                             |
| `chartSetupGanttEndDateLabel`         | `'End date field'`                                                              |
| `chartSetupGanttEndDateHelperText`    | `'Date / datetime field for the end of each bar'`                               |
| `chartSetupGanttColourByLabel`        | `'Colour by (optional)'`                                                        |
| `chartSetupGanttColourByHelperText`   | `'Categorical field used to colour-code bars (e.g. status or category)'`        |

### KPI setup panel

| Token                             | Default                                                              |
| :-------------------------------- | :------------------------------------------------------------------- |
| `kpiSetupChartLine`               | `'Line'`                                                             |
| `kpiSetupChartBar`                | `'Bar'`                                                              |
| `kpiSetupChartGauge`              | `'Gauge'`                                                            |
| `kpiSetupCompPrevPeriod`          | `'Previous period (matching duration)'`                              |
| `kpiSetupCompPrevCalendarPeriod`  | `'Previous calendar period'`                                         |
| `kpiSetupCompSameLastYear`        | `'Same period last year'`                                            |
| `kpiSetupInteractionsTitle`       | `'Interactions'`                                                     |
| `kpiSetupInteractionsDescription` | `'When other widgets are clicked, this KPI…'`                        |
| `kpiSetupTimeFieldLabel`          | `'Time field'`                                                       |
| `kpiSetupGranularityLabel`        | `'Granularity'`                                                      |
| `kpiSetupPlotTypeLabel`           | `'Plot type'`                                                        |
| `kpiSetupMinLabel`                | `'Min'`                                                              |
| `kpiSetupMaxLabel`                | `'Max'`                                                              |
| `kpiSetupValueFieldLabel`         | `'Value field'`                                                      |
| `kpiSetupValueFieldHelperText`    | `'Field to aggregate'`                                               |
| `kpiSetupSparklineLabel`          | `'Sparkline'`                                                        |
| `kpiSetupTargetLabel`             | `'Target'`                                                           |
| `kpiSetupTrendLabel`              | `'Trend'`                                                            |
| `kpiSetupCompPeriodLabel`         | `'Comparison period'`                                                |
| `kpiGrandTotalTooltip`            | `'Grand total — active filter widgets are not applied to this KPI…'` |

### Grid setup panel

| Token                                 | Default                                                          |
| :------------------------------------ | :--------------------------------------------------------------- |
| `gridSetupDataSourceLabel`            | `'Data source'`                                                  |
| `gridSetupDataSourcePlaceholder`      | `'Select a data source…'`                                        |
| `gridSetupAllColumnsAdded`            | `'All available columns added'`                                  |
| `gridSetupCrossFilterFieldLabel`      | `'Cross-filter field'`                                           |
| `gridSetupCrossFilterFieldHelper`     | `'Field applied to other widgets when a row is selected…'`       |
| `gridSetupGroupByLabel`               | `'Group by'`                                                     |
| `gridSetupGroupByHelper`              | `'Collapse rows into groups — set per-column aggregation below'` |
| `gridSetupDefaultSortLabel`           | `'Default sort'`                                                 |
| `gridSetupHeightLabel`                | `'Height (px)'`                                                  |
| `gridSetupConditionalFormattingTitle` | `'Conditional formatting'`                                       |
| `gridSetupConditionalCustom`          | `'Custom'`                                                       |
| `gridSetupRemoveRuleAriaLabel`        | `'Remove rule'`                                                  |
| `gridSetupInteractionsTitle`          | `'Interactions'`                                                 |
| `gridSetupInteractionsDescription`    | `'When other widgets are clicked, this table…'`                  |

### Map setup panel

| Token                         | Default                              |
| :---------------------------- | :----------------------------------- |
| `mapSetupMapTypeLabel`        | `'Map type'`                         |
| `mapSetupValueFieldLabel`     | `'Value field (optional for count)'` |
| `mapSetupColourSchemeLabel`   | `'Colour scheme'`                    |
| `mapSetupLegendPositionLabel` | `'Legend position'`                  |
| `mapSetupScaleFromZeroLabel`  | `'Scale from zero'`                  |
| `mapSetupClickableLabel`      | `'Clickable (filter source)'`        |
| `mapSetupCrossFilterLabel`    | `'Respond to cross-filters'`         |
| `mapSetupColorBlues`          | `'Blues'`                            |
| `mapSetupColorReds`           | `'Reds'`                             |
| `mapSetupColorGreens`         | `'Greens'`                           |
| `mapSetupColorOranges`        | `'Oranges'`                          |
| `mapSetupColorPurples`        | `'Purples'`                          |
| `mapSetupLegendBottom`        | `'Bottom'`                           |
| `mapSetupLegendTop`           | `'Top'`                              |
| `mapSetupLegendLeft`          | `'Left'`                             |
| `mapSetupLegendRight`         | `'Right'`                            |
| `mapSetupLegendHidden`        | `'Hidden'`                           |

### Pivot setup panel

| Token                        | Default                                                                                |
| :--------------------------- | :------------------------------------------------------------------------------------- |
| `pivotSetupDescription`      | `'Build a cross-tabulation by choosing a row field, column field, and value measure.'` |
| `pivotSetupRowFieldLabel`    | `'Row field'`                                                                          |
| `pivotSetupRowFieldHelper`   | `'Categorical field shown as row groups on the left'`                                  |
| `pivotSetupColFieldLabel`    | `'Column field'`                                                                       |
| `pivotSetupColFieldHelper`   | `'Categorical field spread across column headers'`                                     |
| `pivotSetupValueFieldLabel`  | `'Value field'`                                                                        |
| `pivotSetupValueFieldHelper` | `'Numeric field aggregated into each cell'`                                            |
| `pivotSetupShowTotals`       | `'Show totals row and column'`                                                         |
| `pivotSetupAggregationLabel` | `'Aggregation'`                                                                        |

### Inline formula bar

| Token                            | Default                            |
| :------------------------------- | :--------------------------------- |
| `inlineFormulaBarAddTooltip`     | `'Add a calculated formula field'` |
| `inlineFormulaBarCloseAriaLabel` | `'Close formula bar'`              |
| `inlineFormulaBarLabelLabel`     | `'Label'`                          |

### Filter setup panel

| Token                               | Default                                             |
| :---------------------------------- | :-------------------------------------------------- |
| `filterSetupControlTypeLabel`       | `'Control type'`                                    |
| `filterSetupMultiSelect`            | `'Multi-select'`                                    |
| `filterSetupMultiSelectDescription` | `'Dropdown with checkboxes for categorical values'` |
| `filterSetupToggleChips`            | `'Toggle chips'`                                    |
| `filterSetupToggleChipsDescription` | `'Inline chip buttons for categorical values'`      |
| `filterSetupDateRange`              | `'Date range'`                                      |
| `filterSetupDateRangeDescription`   | `'From / to date pickers'`                          |
| `filterSetupSlider`                 | `'Slider'`                                          |
| `filterSetupSliderDescription`      | `'Range slider for numeric or date fields'`         |
| `filterSetupMinLabel`               | `'Min'`                                             |
| `filterSetupMaxLabel`               | `'Max'`                                             |
| `filterSetupStepLabel`              | `'Step'`                                            |
| `filterSetupSelectFieldAlert`       | `'Select a field to configure the filter control.'` |

### Text setup panel

| Token                     | Default                                             |
| :------------------------ | :-------------------------------------------------- |
| `textSetupTitleLabel`     | `'Title'`                                           |
| `textSetupTitleHelper`    | `'Heading displayed at the top of the widget'`      |
| `textSetupSubtitleLabel`  | `'Subtitle'`                                        |
| `textSetupSubtitleHelper` | `'Smaller text below the heading'`                  |
| `textSetupBodyLabel`      | `'Body'`                                            |
| `textSetupBodyHelper`     | `'Main content of the widget; supports plain text'` |

### Page config panel

| Token                                   | Default                |
| :-------------------------------------- | :--------------------- |
| `pageConfigPageSectionTitle`            | `'Page'`               |
| `pageConfigCardsSectionTitle`           | `'Cards'`              |
| `pageConfigBackgroundColourLabel`       | `'Background colour'`  |
| `pageConfigBackgroundColourPlaceholder` | `'e.g. #f5f5f5'`       |
| `pageConfigCardBackgroundLabel`         | `'Card background'`    |
| `pageConfigCardBackgroundPlaceholder`   | `'e.g. #ffffff'`       |
| `pageConfigPaddingLabel`                | `'Padding'`            |
| `pageConfigCornerRadiusLabel`           | `'Corner radius (px)'` |
| `pageConfigCardBorderLabel`             | `'Card border'`        |
| `pageConfigBorderColourLabel`           | `'Border colour'`      |
| `pageConfigBorderColourPlaceholder`     | `'e.g. #e0e0e0'`       |
| `pageConfigBorderWidthLabel`            | `'Border width (px)'`  |

### AI insight types

| Token                    | Default         |
| :----------------------- | :-------------- |
| `insightTypeSummary`     | `'Summary'`     |
| `insightTypeAnalysis`    | `'Analysis'`    |
| `insightTypeForecast`    | `'Forecast'`    |
| `insightTypeAnomaly`     | `'Anomaly'`     |
| `insightTypeCorrelation` | `'Correlation'` |

### AI chat suggestions

These are the pre-filled suggestion chips shown when the AI chat panel is first opened.

| Token                           | Default                                          |
| :------------------------------ | :----------------------------------------------- |
| `aiSuggestionBarChart`          | `(numericLabel, catLabel) => string`             |
| `aiSuggestionKpi`               | `(fieldLabel) => string`                         |
| `aiSuggestionTable`             | `(sourceLabel) => string`                        |
| `aiSuggestionChangeToLine`      | `(widgetTitle) => string`                        |
| `aiSuggestionAddSparkline`      | `(widgetTitle) => string`                        |
| `aiSuggestionAddDateFilter`     | `'Add a date filter to show the trend'`          |
| `aiSuggestionAddPage`           | `'Add a new page'`                               |
| `aiSuggestionSummarisePage`     | `'Summarise this page'`                          |
| `aiSuggestionWhatDataAvailable` | `'What data is available?'`                      |
| `chatNewConversationName`       | `'New conversation'`                             |
| `chatSwitchConversationTooltip` | `'Switch conversation'`                          |
| `chatVoiceInputStart`           | `'Start voice input'`                            |
| `chatVoiceInputStop`            | `'Stop voice input'`                             |
| `chatVoiceInputNotSupported`    | `'Voice input is not supported in this browser'` |

### Chart cross-source error messages

| Token                                | Default                                                              |
| :----------------------------------- | :------------------------------------------------------------------- |
| `chartUnsupportedFieldNotFound`      | `'One or more fields are not available in the current data source'`  |
| `chartUnsupportedMixedCrossSource`   | `'Mixed charts cannot combine fields from different data sources'`   |
| `chartUnsupportedScatterCrossSource` | `'Scatter charts cannot combine fields from different data sources'` |
| `chartUnsupportedDefault`            | `'This chart configuration is not supported'`                        |
| `chartForecastSeriesLabel`           | `'Forecast'`                                                         |

### Chart color schemes

| Token                     | Default     |
| :------------------------ | :---------- |
| `chartColorSchemePrimary` | `'Primary'` |
| `chartColorSchemeSuccess` | `'Success'` |
| `chartColorSchemeWarning` | `'Warning'` |
| `chartColorSchemeError`   | `'Error'`   |

### Cross-filter mode

| Token                      | Default       |
| :------------------------- | :------------ |
| `crossFilterModeHighlight` | `'Highlight'` |
| `crossFilterModeFilter`    | `'Filter'`    |
| `crossFilterModeNone`      | `'None'`      |

### Filter widget controls

These tokens are used in the interactive filter widgets on the dashboard (multi-select, date range, slider).

| Token                           | Default                     |
| :------------------------------ | :-------------------------- |
| `filterWidgetClearAriaLabel`    | `'Clear filter'`            |
| `filterWidgetSelectAllLabel`    | `'Select all'`              |
| `filterWidgetClearAllLabel`     | `'Clear all'`               |
| `filterWidgetAllLabel`          | `'All'`                     |
| `filterWidgetNoOptionsLabel`    | `'No options'`              |
| `filterWidgetSelectedCount`     | `(count: number) => string` |
| `filterWidgetExcludeLabel`      | `'Exclude'`                 |
| `filterWidgetExcludingLabel`    | `'Excluding'`               |
| `filterWidgetDateFromLabel`     | `'From'`                    |
| `filterWidgetDateToLabel`       | `'To'`                      |
| `filterWidgetNoFieldConfigured` | `'No field configured'`     |

### Widget-level filter conditions panel

These tokens appear in the **Filters** tab of the widget edit dialog when adding always-on conditions to a widget.

| Token                           | Default                                                                                         |
| :------------------------------ | :---------------------------------------------------------------------------------------------- |
| `widgetFiltersPanelNoSource`    | `'Select a data source first.'`                                                                 |
| `widgetFiltersPanelDescription` | `'These filters are always applied to this widget, regardless of page or interactive filters.'` |
| `widgetFiltersPanelNoFilters`   | `'No conditions added yet.'`                                                                    |
| `widgetFiltersPanelAddButton`   | `'Add condition'`                                                                               |

### Grid summary row

Tokens used by `computeGridSummary` and `aggregationLabel` for the summary row at the bottom of tables.

| Token                           | Default      |
| :------------------------------ | :----------- |
| `gridSummaryLabelSum`           | `'Sum'`      |
| `gridSummaryLabelAvg`           | `'Avg'`      |
| `gridSummaryLabelCount`         | `'Count'`    |
| `gridSummaryLabelCountDistinct` | `'Distinct'` |
| `gridSummaryLabelMin`           | `'Min'`      |
| `gridSummaryLabelMax`           | `'Max'`      |

### Auto-generated widget titles

Studio auto-generates widget titles and subtitles when none has been set. Override these tokens to change the grammar for your language.

#### Fallback titles (no data source configured)

| Token                    | Default         |
| :----------------------- | :-------------- |
| `widgetAutoTitleChart`   | `'Chart'`       |
| `widgetAutoTitleKpi`     | `'KPI'`         |
| `widgetAutoTitleTable`   | `'Table'`       |
| `widgetAutoTitleFilter`  | `'Filter'`      |
| `widgetAutoTitlePivot`   | `'Pivot Table'` |
| `widgetAutoTitleMap`     | `'Map'`         |
| `widgetAutoTitleDefault` | `'Widget'`      |

#### Glue words and suffixes

| Token                              | Default             | Example usage                            |
| :--------------------------------- | :------------------ | :--------------------------------------- |
| `widgetAutoTitleVs`                | `'vs'`              | `"Revenue vs Units"` (scatter / pivot)   |
| `widgetAutoTitleBy`                | `'by'`              | `"Revenue by Category"` (bar chart)      |
| `widgetAutoTitleSplitBy`           | `'split by'`        | `"Revenue — split by Region"` (subtitle) |
| `widgetAutoTitleByCountry`         | `'by Country'`      | `"Total Revenue by Country"` (map)       |
| `widgetAutoTitleSourceSuffixChart` | `'chart'`           | `"Orders chart"` (source-only fallback)  |
| `widgetAutoTitleSourceSuffixKpi`   | `'KPI'`             | `"Orders KPI"`                           |
| `widgetAutoTitleSourceSuffixPivot` | `'pivot'`           | `"Orders pivot"`                         |
| `widgetAutoTitleSourceSuffixMap`   | `'map'`             | `"Orders map"`                           |
| `widgetAutoTitleFilterPrefix`      | `'Filter:'`         | `"Filter: Status"` (filter widget title) |
| `widgetAutoTitleMoreFields`        | `(count) => string` | `"+2 more"` (multi-field summaries)      |

#### KPI aggregation prefixes

Applied as a prefix to the value field label in the KPI title (e.g. `"Total Revenue"`, `"Average Age"`).

| Token                          | Default      |
| :----------------------------- | :----------- |
| `widgetAggPrefixSum`           | `'Total'`    |
| `widgetAggPrefixAvg`           | `'Average'`  |
| `widgetAggPrefixCount`         | `'Count of'` |
| `widgetAggPrefixMin`           | `'Min'`      |
| `widgetAggPrefixMax`           | `'Max'`      |
| `widgetAggPrefixCountDistinct` | `'Unique'`   |

#### Time-grouping prefixes (chart subtitle)

Prepended to the group-by field label when time granularity is active, e.g. `"Month of Order Date"`.

| Token                        | Default        |
| :--------------------------- | :------------- |
| `widgetGroupByPrefixDay`     | `'Day of'`     |
| `widgetGroupByPrefixWeek`    | `'Week of'`    |
| `widgetGroupByPrefixMonth`   | `'Month of'`   |
| `widgetGroupByPrefixQuarter` | `'Quarter of'` |
| `widgetGroupByPrefixYear`    | `'Year of'`    |

### Date filter labels

Used by `formatDateFilterLabel` and the Quick Filter date range bar to render human-readable filter summaries.

#### Relative date direction

| Token             | Example output                                 |
| :---------------- | :--------------------------------------------- |
| `dateFilterLast`  | `(amount, unit) => string` → `"Last 7 days"`   |
| `dateFilterNext`  | `(amount, unit) => string` → `"Next 3 months"` |
| `dateFilterFrom`  | `(date) => string` → `"From 1 Jan 2024"`       |
| `dateFilterUpTo`  | `(label) => string` → `"Up to last 7 days"`    |
| `dateFilterSince` | `(date) => string` → `"Since 1 Jan 2024"`      |
| `dateFilterUntil` | `(date) => string` → `"Until 31 Dec 2024"`     |

#### Singular and plural unit labels

These are passed as `unit` into `dateFilterLast` / `dateFilterNext` above.

| Token                   | Default     |
| :---------------------- | :---------- |
| `dateFilterUnitYear`    | `'year'`    |
| `dateFilterUnitYears`   | `'years'`   |
| `dateFilterUnitMonth`   | `'month'`   |
| `dateFilterUnitMonths`  | `'months'`  |
| `dateFilterUnitWeek`    | `'week'`    |
| `dateFilterUnitWeeks`   | `'weeks'`   |
| `dateFilterUnitDay`     | `'day'`     |
| `dateFilterUnitDays`    | `'days'`    |
| `dateFilterUnitHour`    | `'hour'`    |
| `dateFilterUnitHours`   | `'hours'`   |
| `dateFilterUnitMinute`  | `'minute'`  |
| `dateFilterUnitMinutes` | `'minutes'` |
| `dateFilterUnitSecond`  | `'second'`  |
| `dateFilterUnitSeconds` | `'seconds'` |

### Pivot table

| Token                        | Default                          |
| :--------------------------- | :------------------------------- |
| `pivotCornerHeaderAriaLabel` | `'Corner cell'`                  |
| `pivotBlankValueLabel`       | `'(blank)'`                      |
| `pivotTotalLabel`            | `'Total'`                        |
| `pivotRowsColumnsLabel`      | `(rowCount, colCount) => string` |

### Expression field preview

| Token                             | Default                                                            |
| :-------------------------------- | :----------------------------------------------------------------- |
| `expressionPreviewMeasureLabel`   | `(count) => string` → `"Preview (measure over 1,000 rows)"`        |
| `expressionPreviewFirstRowsLabel` | `(count) => string` → `"Preview (first 100 rows)"`                 |
| `exprMeasureLabel`                | `'Measure'`                                                        |
| `exprMeasureHelperText`           | `'Aggregates multiple rows into a single value (e.g. SUM, COUNT)'` |
| `exprDimensionHelperText`         | `'Row-level value — used in group-by fields and table columns'`    |
| `exprDialogEditTitle`             | `'Edit calculated field'`                                          |
| `exprDialogNewTitle`              | `'New calculated field'`                                           |

### KPI widget

| Token                            | Default                                             |
| :------------------------------- | :-------------------------------------------------- |
| `kpiGranularityAutoLabel`        | `'Auto'`                                            |
| `kpiWidgetComparisonTargetLabel` | `'vs'`                                              |
| `kpiTrendNewLabel`               | `'New'`                                             |
| `kpiTrendTargetTooltip`          | `(value) => string` → `"Target: 5,000"`             |
| `kpiTrendPreviousPeriodTooltip`  | `(period) => string` → `"Previous period: Q1 2024"` |
| `kpiTrendNoDateFilterHint`       | `'Add a date filter to show the trend'`             |
| `kpiSparklineNoTimeFieldHint`    | `'Choose a time field to show the sparkline'`       |

### Chart and Gantt widget

| Token                          | Default                                                                             |
| :----------------------------- | :---------------------------------------------------------------------------------- |
| `chartMixedRequiresFieldsHint` | `'A mixed chart requires at least 2 measure fields'`                                |
| `chartDefaultSeriesLabel`      | `'Series'`                                                                          |
| `ganttHiddenRowsLabel`         | `(count) => string` → `"+3 more rows not shown: increase widget height to see all"` |

### Data drawer (additional tokens)

| Token                          | Default                                   |
| :----------------------------- | :---------------------------------------- |
| `dataDrawerAddCalculatedField` | `'Add calculated field'`                  |
| `dataDrawerNoData`             | `(sourceLabel) => string`                 |
| `dataDrawerMoreRows`           | `(count) => string` → `"+200 more rows"`  |
| `dataDrawerMoreColumns`        | `(count) => string` → `"+5 more columns"` |
| `dataDrawerViewSourceLink`     | `'View full data'`                        |
| `dataDrawerMorePreviewRows`    | `(count) => string`                       |

### Lineage graph

| Token                     | Default                                                |
| :------------------------ | :----------------------------------------------------- |
| `lineageTypePrefix`       | `(type) => string`                                     |
| `lineageJoinDetail`       | `(srcSource, srcField, tgtSource, tgtField) => string` |
| `lineageViaDetail`        | `(via) => string`                                      |
| `lineagePreviewAriaLabel` | `(label) => string`                                    |
| `lineageNoRelationships`  | `'No relationships defined yet.'`                      |

### Relationship management (additional tokens)

| Token                         | Default                     |
| :---------------------------- | :-------------------------- |
| `relationshipAddTitle`        | `'Add relationship'`        |
| `relationshipEditTitle`       | `'Edit relationship'`       |
| `relationshipSourceManyLabel` | `'Source (many)'`           |
| `relationshipSourceLabel`     | `'Source'`                  |
| `relationshipTargetOneLabel`  | `'Target (one)'`            |
| `relationshipTargetLabel`     | `'Target'`                  |
| `relationshipUpdate`          | `'Update'`                  |
| `relationshipAdd`             | `'Add'`                     |
| `relationshipSectionTitle`    | `'Relationships'`           |
| `relationshipAddButton`       | `'Add relationship'`        |
| `relationshipNone`            | `'None'`                    |
| `relationshipVia`             | `(junctionLabel) => string` |

### Filters drawer (additional tokens)

| Token                               | Default                                  |
| :---------------------------------- | :--------------------------------------- |
| `filtersSectionWidgetTitle`         | `(title) => string`                      |
| `filtersRenameViewAriaLabel`        | `'Rename view'`                          |
| `filtersRenameViewButtonAriaLabel`  | `(name) => string`                       |
| `filtersDeleteViewAriaLabel`        | `(name) => string`                       |
| `filterSectionNoInteractiveFilters` | `'No interactive filters on this page.'` |
| `filterSectionNoCrossFilters`       | `'No active cross-filters.'`             |
| `filterSectionSelectedCount`        | `(count) => string`                      |
| `filterSectionValueDisplay`         | `(fieldLabel, value) => string`          |
| `filterSectionSourcePrefix`         | `(widgetTitle) => string`                |
| `filterBodyAddCondition`            | `'Add condition'`                        |
| `filterBodyNarrowOptions`           | `'Narrow options based on:'`             |
| `filterModeFilter`                  | `'Filter'`                               |
| `filterModeSelect`                  | `'Select'`                               |
| `filterModeRank`                    | `'Rank'`                                 |
| `filterSelectionNoValues`           | `'No values found.'`                     |
| `filterSelectionAll`                | `'All'`                                  |
| `filterSelectionSelectedCount`      | `(count) => string`                      |

### Filter rank (Top-N / Bottom-N)

| Token                   | Default     |
| :---------------------- | :---------- |
| `filterRankTop`         | `'Top'`     |
| `filterRankBottom`      | `'Bottom'`  |
| `filterRankAggSumLabel` | `'Sum'`     |
| `filterRankAggAvgLabel` | `'Average'` |
| `filterRankAggMaxLabel` | `'Max'`     |
| `filterRankAggMinLabel` | `'Min'`     |

### Relative date filter

| Token                       | Default            |
| :-------------------------- | :----------------- |
| `filterRelativeUnitSeconds` | `'seconds'`        |
| `filterRelativeUnitMinutes` | `'minutes'`        |
| `filterRelativeUnitHours`   | `'hours'`          |
| `filterRelativeUnitDays`    | `'days'`           |
| `filterRelativeUnitWeeks`   | `'weeks'`          |
| `filterRelativeUnitMonths`  | `'months'`         |
| `filterRelativeUnitYears`   | `'years'`          |
| `filterDatePreset7Days`     | `'Last 7 days'`    |
| `filterDatePreset30Days`    | `'Last 30 days'`   |
| `filterDatePreset3Months`   | `'Last 3 months'`  |
| `filterDatePreset12Months`  | `'Last 12 months'` |
| `filterDatePreset1Year`     | `'Last 1 year'`    |
| `filterRelativeDateAgo`     | `'ago'`            |
| `filterRelativeDateFromNow` | `'from now'`       |
| `filterDateLabel`           | `'Date'`           |

### Grid setup panel (additional tokens)

| Token                              | Default                                       |
| :--------------------------------- | :-------------------------------------------- |
| `gridSetupChooseSourceHelper`      | `'Choose a data source to configure columns'` |
| `gridSetupNoSourceAlert`           | `'No data source selected.'`                  |
| `gridSetupColumnsTitle`            | `'Columns'`                                   |
| `gridSetupColumnOptionsAriaLabel`  | `(label) => string`                           |
| `gridSetupColumnGroupLabel`        | `'Group'`                                     |
| `gridSetupColumnRemove`            | `'Remove column'`                             |
| `gridSetupColumnAggNone`           | `'None'`                                      |
| `gridSetupColumnAggUnique`         | `'Unique'`                                    |
| `gridSetupColumnAggSummaryTooltip` | `'Aggregation used in summary row'`           |
| `gridSetupColumnAggLabel`          | `(isGroupBy, aggLabel) => string`             |
| `gridSetupColumnSetAggTooltip`     | `'Set column aggregation'`                    |
| `gridSetupAddColumn`               | `'Add column'`                                |
| `gridSetupCalculatedColumn`        | `'Add calculated column'`                     |
| `gridSetupAddRule`                 | `'Add rule'`                                  |
| `gridSetupSortAscendingTooltip`    | `'Ascending'`                                 |
| `gridSetupSortDescendingTooltip`   | `'Descending'`                                |
| `gridSetupCFContains`              | `'Contains'`                                  |
| `gridSetupCFIsEmpty`               | `'Is empty'`                                  |
| `gridSetupCFNotEmpty`              | `'Is not empty'`                              |
| `gridSetupCFStyleRed`              | `'Red'`                                       |
| `gridSetupCFStyleGreen`            | `'Green'`                                     |
| `gridSetupCFStyleYellow`           | `'Yellow'`                                    |
| `gridSetupCFStyleBlue`             | `'Blue'`                                      |
| `gridSetupCFStyleBold`             | `'Bold'`                                      |

### Map setup panel (additional tokens)

| Token                           | Default                                      |
| :------------------------------ | :------------------------------------------- |
| `mapSetupAggregationLabel`      | `'Aggregation'`                              |
| `mapSetupRegionFieldLabel`      | `'Region field'`                             |
| `mapSetupRegionFieldHelperText` | `'Field containing country or region codes'` |

### Filter setup panel (additional tokens)

| Token                              | Default                             |
| :--------------------------------- | :---------------------------------- |
| `filterSetupFieldLabel`            | `'Field'`                           |
| `filterSetupSliderRangeHelperText` | `'Leave blank to use data min/max'` |

### Widget type descriptions

Shown in the compose drawer widget type picker.

| Token                            | Default                                                 |
| :------------------------------- | :------------------------------------------------------ |
| `widgetKindTextDescription`      | `'Heading and body text'`                               |
| `widgetKindKpiDescription`       | `'Single metric with sparkline and comparison period'`  |
| `widgetKindChartDescription`     | `'Bar, line, pie, scatter, and more'`                   |
| `widgetKindGridDescription`      | `'Tabular data with sorting and grouping'`              |
| `widgetKindFilterDescription`    | `'Interactive filter control for the page'`             |
| `widgetKindPivotDescription`     | `'Cross-tabulation with row, column, and value fields'` |
| `widgetKindMapDescription`       | `'Choropleth map coloured by a numeric field'`          |
| `composeCustomWidgetDescription` | `'Custom widget'`                                       |

### Compose drawer (additional tokens)

| Token                              | Default                       |
| :--------------------------------- | :---------------------------- |
| `drawerPanelOpenAriaLabel`         | `(title) => string`           |
| `drawerPanelCloseNamedAriaLabel`   | `(title) => string`           |
| `sidebarPanelToggleAriaLabel`      | `(isActive, label) => string` |
| `addWidgetGroupAriaLabel`          | `(groupLabel) => string`      |
| `addWidgetSelectAriaLabel`         | `(label) => string`           |
| `formatPanelNoSubtitlePlaceholder` | `'No subtitle'`               |

### Data source field select

| Token                           | Default         |
| :------------------------------ | :-------------- |
| `dataSourceClearFieldAriaLabel` | `'Clear field'` |

### Date range bar (additional tokens)

| Token                      | Default               |
| :------------------------- | :-------------------- |
| `dateRangePresetAriaLabel` | `'Date range preset'` |

### KPI setup panel (additional tokens)

| Token                          | Default                                                   |
| :----------------------------- | :-------------------------------------------------------- |
| `kpiSetupAggregationLabel`     | `'Aggregation'`                                           |
| `kpiSetupDateAggEarliest`      | `'Earliest'`                                              |
| `kpiSetupDateAggLatest`        | `'Latest'`                                                |
| `kpiSetupFillAreaLabel`        | `'Fill area'`                                             |
| `kpiSetupCumulativeLabel`      | `'Cumulative'`                                            |
| `kpiSetupAutoDateFilterPrefix` | `'Last'`                                                  |
| `kpiSetupCalculatedField`      | `'Add calculated field'`                                  |
| `kpiSetupTargetHelperText`     | `'Constant value or field for the target reference line'` |
| `kpiSetupInvertColours`        | `'Invert colours (below target = good)'`                  |

## Adding a custom translation

If your language is not yet available, create a full or partial translation object and contribute it upstream:

```ts
import type { StudioLocaleText } from '@mui/x-studio';

export const deLocaleText: Partial<StudioLocaleText> = {
  dataDrawerTitle: 'Daten',
  composeDrawerTitle: 'Bearbeiten',
  filtersDrawerTitle: 'Filter',
  // ...
};
```

Pass it the same way as the built-in translations:

```tsx
import { deLocaleText } from './locales/de';

<Studio localeText={deLocaleText} initialState={myState} />;
```

## `useStudioLocaleText` hook

When building custom widgets or composing custom Studio UIs, call `useStudioLocaleText()` to read the active locale text from context:

```tsx
import { useStudioLocaleText } from '@mui/x-studio';

function MyCustomWidget() {
  const localeText = useStudioLocaleText();
  return <p>{localeText.widgetNoData}</p>;
}
```

This ensures your custom components automatically pick up any locale overrides provided by the application.

## `StudioDashboard` support

`localeText` is also available on `StudioDashboard`:

```tsx
import { StudioDashboard } from '@mui/x-studio';
import { ptBRLocaleText } from '@mui/x-studio';

<StudioDashboard config={dashboardState} localeText={ptBRLocaleText} />;
```

## `DEFAULT_STUDIO_LOCALE_TEXT`

The English defaults are exported as `DEFAULT_STUDIO_LOCALE_TEXT`.
Use this object as the basis for a full translation to ensure you cover every token:

```ts
import { DEFAULT_STUDIO_LOCALE_TEXT, type StudioLocaleText } from '@mui/x-studio';

const myLocaleText: StudioLocaleText = {
  ...DEFAULT_STUDIO_LOCALE_TEXT,
  widgetNoData: 'Keine Daten',
  // override more tokens...
};
```

## See also

- [Customization overview](/x/react-studio/customization/slot-props/) — slots and slot props for component-level customisation
- [Theming](/x/react-studio/customization/theming/) — applying a custom MUI theme
