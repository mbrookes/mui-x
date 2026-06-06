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

### `localeText` prop

Pass a locale's `localeText` directly to the component:

```tsx
import { Studio, ptBRLocaleText } from '@mui/x-studio';

<Studio localeText={ptBRLocaleText} initialState={myState} />;
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

| Token                      | Default        |
| :------------------------- | :------------- |
| `dateRangeBarFieldLabel`   | `'Date range'` |
| `filterFieldLabel`         | `'Field'`      |

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

| Token                         | Default               |
| :---------------------------- | :-------------------- |
| `widgetEditTooltip`           | `'Edit widget'`       |
| `widgetExportCsvTooltip`      | `'Export as CSV'`     |
| `widgetExportPngTooltip`      | `'Export as PNG'`     |
| `widgetExpandTooltip`         | `'Expand chart'`      |
| `widgetMoveToPageLabel`       | `'Move to page'`      |
| `widgetDuplicateTooltip`      | `'Duplicate widget'`  |
| `widgetDeleteTooltip`         | `'Delete widget'`     |
| `widgetAiAssistantTooltip`    | `'AI assistant'`      |
| `widgetAiInsightTooltip`      | `'AI insight'`        |
| `widgetDetectAnomalyTooltip`  | `'Detect anomalies'`  |
| `widgetHideAnomalyTooltip`    | `'Hide anomalies'`    |
| `widgetExplainAnomalyTooltip` | `'Explain anomalies'` |

### Widget edit dialog

| Token                            | Default                                               |
| :------------------------------- | :---------------------------------------------------- |
| `widgetEditDialogTabSetup`       | `'Setup'`                                             |
| `widgetEditDialogTabFilters`     | `'Filters'`                                           |
| `widgetEditDialogTabFormat`      | `'Format'`                                            |
| `widgetEditDialogCloseAriaLabel` | `'Close edit dialog'`                                 |
| `widgetUntitledLabel`            | `(kindLabel: string) => string`                       |

### AI assistant

| Token                     | Default                |
| :------------------------ | :--------------------- |
| `aiAssistantOpenTooltip`  | `'Open AI assistant'`  |
| `aiAssistantCloseTooltip` | `'Close AI assistant'` |

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

| Token                               | Default                                                             |
| :---------------------------------- | :------------------------------------------------------------------ |
| `composeDrawerTabSetup`             | `'Setup'`                                                           |
| `composeChooseWidgetType`           | `'Choose a widget type'`                                            |
| `composeNoDataSources`              | `'No data sources available yet. Only text widgets can be added.'`  |
| `composeOnThisPage`                 | `'On this page'`                                                    |
| `composeAddWidgetLabel`             | `(widgetTypeLabel: string) => string`                               |
| `composeCloseAriaLabel`             | `'Close'`                                                           |
| `composeBackToWidgetTypesAriaLabel` | `'Back to widget types'`                                            |
| `composeCancel`                     | `'Cancel'`                                                          |

### Format panel

| Token                 | Default                              |
| :-------------------- | :----------------------------------- |
| `formatAutoTitle`     | `'Auto-generated title'`             |
| `formatResetTitle`    | `'Reset to auto-generated title'`    |
| `formatAutoSubtitle`  | `'Auto-generated subtitle'`          |
| `formatResetSubtitle` | `'Reset to auto-generated subtitle'` |

### Data drawer

| Token                      | Default                                                                           |
| :------------------------- | :-------------------------------------------------------------------------------- |
| `dataDrawerNoSources`      | `'No data sources configured. Add a widget from the canvas to load sample data.'` |
| `dataDrawerViewLineage`    | `'View data lineage'`                                                             |
| `dataDrawerLineageTitle`   | `'Data lineage'`                                                                  |
| `dataDrawerLineageHelper`  | `'Click a node to preview its data. Click an edge to inspect join key fields.'`   |
| `dataDrawerRowsLabel`      | `'rows'`                                                                          |
| `dataDrawerFieldsLabel`    | `'fields'`                                                                        |
| `dataDrawerBackAriaLabel`  | `'Back to lineage graph'`                                                         |
| `dataDrawerCloseAriaLabel` | `'Close data lineage'`                                                            |
| `dataDrawerEditTooltip`    | `'Edit'`                                                                          |
| `dataDrawerDeleteTooltip`  | `'Delete'`                                                                        |
| `dataDrawerViewSourceTooltip` | `'View source data'`                                                           |

### Relationship management

| Token                        | Default          |
| :--------------------------- | :--------------- |
| `relationshipEditTooltip`    | `'Edit'`         |
| `relationshipRemoveTooltip`  | `'Remove'`       |
| `relationshipCancel`         | `'Cancel'`       |
| `relationshipTypeManyToOne`  | `'Many-to-one'`  |
| `relationshipTypeOneToOne`   | `'One-to-one'`   |
| `relationshipTypeManyToMany` | `'Many-to-many'` |

### Filter conditions and values

| Token                           | Default                      |
| :------------------------------ | :--------------------------- |
| `filterConditionAnd`            | `'AND'`                      |
| `filterConditionOr`             | `'OR'`                       |
| `filterOperatorLabel`           | `'Operator'`                 |
| `filterRemoveSecondCondition`   | `'Remove second condition'`  |
| `filterAbsoluteDate`            | `'Absolute date'`            |
| `filterRelativeDate`            | `'Relative date'`            |
| `filterLinkToField`             | `'Link to field'`            |
| `filterRemoveFieldLink`         | `'Remove field link'`        |
| `filterBooleanTrue`             | `'True'`                     |
| `filterBooleanFalse`            | `'False'`                    |
| `filterRemoveAriaLabel`         | `'Remove filter'`            |
| `filterInteractiveSectionTitle` | `'Interactive filters'`      |
| `filterCrossSectionTitle`       | `'Cross-filters'`            |
| `filterClearFilter`             | `'Clear filter'`             |
| `filterClearAllCrossFilters`    | `'Clear all cross-filters'`  |
| `filterRemoveCrossFilter`       | `'Remove cross-filter'`      |
| `filterSearchValues`            | `'Search values…'`           |
| `filterSelectField`             | `'Select a field…'`          |
| `filterValueLabel`              | `'Value'`                    |
| `filterValueHelper`             | `'Value to compare against'` |
| `filterSelectParent`            | `'Select parent filter…'`    |
| `filterSourceLabel`             | `'Source'`                   |
| `filterMetricRowLabel`          | `'Metric row'`               |
| `filterFieldLabel`              | `'Field'`                    |
| `filterRankByLabel`             | `'Rank by'`                  |

### Expression field dialog

| Token                    | Default          |
| :----------------------- | :--------------- |
| `exprNodeTypeField`      | `'Field'`        |
| `exprNodeTypeLiteral`    | `'Literal'`      |
| `exprNodeTypeFunction`   | `'Function'`     |
| `exprDataTypeNumber`     | `'Number'`       |
| `exprDataTypeText`       | `'Text'`         |
| `exprDataTypeBoolean`    | `'Boolean'`      |
| `exprBooleanTrue`        | `'True'`         |
| `exprBooleanFalse`       | `'False'`        |
| `exprExpandTooltip`      | `'Expand'`       |
| `exprCollapseTooltip`    | `'Collapse'`     |
| `exprRemoveInputTooltip` | `'Remove input'` |
| `exprCancel`             | `'Cancel'`       |
| `exprSave`               | `'Save'`         |
| `exprAddField`           | `'Add Field'`    |

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

| Token                               | Default                                         |
| :---------------------------------- | :---------------------------------------------- |
| `chartSetupValueFieldLabel`         | `'Value field'`                                 |
| `chartSetupAggregationLabel`        | `'Aggregation'`                                 |
| `chartSetupMinLabel`                | `'Min'`                                         |
| `chartSetupMaxLabel`                | `'Max'`                                         |
| `chartSetupGroupByLabel`            | `'Group by'`                                    |
| `chartSetupSortByLabel`             | `'Sort by'`                                     |
| `chartSetupSortCategory`            | `'Category'`                                    |
| `chartSetupSortValue`               | `'Value'`                                       |
| `chartSetupSortNone`                | `'None'`                                        |
| `chartSetupSortPercent`             | `'Percent'`                                     |
| `chartSetupAnnotationsTitle`        | `'Annotations'`                                 |
| `chartSetupInteractionsTitle`       | `'Interactions'`                                |
| `chartSetupInteractionsDescription` | `'When other widgets are clicked, this chart…'` |
| `chartSetupAddSeries`               | `'Add series'`                                  |
| `chartSetupNoMoreFields`            | `'No more fields to add'`                       |
| `chartSetupRemoveSeries`            | `'Remove series'`                               |
| `chartSetupAddReferenceLine`        | `'Add reference line'`                          |
| `chartSetupRemoveAnnotation`        | `'Remove annotation'`                           |
| `chartSetupNoReferenceLines`        | `'No reference lines. Click + to add one.'`     |
| `chartSetupDualYAxis`               | `'Dual Y axis (line series on right axis)'`     |

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
| `kpiGrandTotalTooltip`            | `'Grand total — active filter widgets are not applied to this KPI…'` |

### Grid setup panel

| Token                                 | Default                                                          |
| :------------------------------------ | :--------------------------------------------------------------- |
| `gridSetupDataSourceLabel`            | `'Data source'`                                                  |
| `gridSetupAllColumnsAdded`            | `'All available columns added'`                                  |
| `gridSetupCrossFilterFieldLabel`      | `'Cross-filter field'`                                           |
| `gridSetupCrossFilterFieldHelper`     | `'Field applied to other widgets when a row is selected…'`       |
| `gridSetupGroupByLabel`               | `'Group by'`                                                     |
| `gridSetupGroupByHelper`              | `'Collapse rows into groups — set per-column aggregation below'` |
| `gridSetupDefaultSortLabel`           | `'Default sort'`                                                 |
| `gridSetupConditionalFormattingTitle` | `'Conditional formatting'`                                       |
| `gridSetupConditionalCustom`          | `'Custom'`                                                       |
| `gridSetupRemoveRuleAriaLabel`        | `'Remove rule'`                                                  |
| `gridSetupInteractionsTitle`          | `'Interactions'`                                                 |
| `gridSetupInteractionsDescription`    | `'When other widgets are clicked, this table…'`                  |

### Map setup panel

| Token                  | Default     |
| :--------------------- | :---------- |
| `mapSetupColorBlues`   | `'Blues'`   |
| `mapSetupColorReds`    | `'Reds'`    |
| `mapSetupColorGreens`  | `'Greens'`  |
| `mapSetupColorOranges` | `'Oranges'` |
| `mapSetupColorPurples` | `'Purples'` |
| `mapSetupLegendBottom` | `'Bottom'`  |
| `mapSetupLegendTop`    | `'Top'`     |
| `mapSetupLegendLeft`   | `'Left'`    |
| `mapSetupLegendRight`  | `'Right'`   |
| `mapSetupLegendHidden` | `'Hidden'`  |

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
