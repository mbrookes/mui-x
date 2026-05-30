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

Studio ships with a Brazilian Portuguese translation out of the box:

```tsx
import { Studio } from '@mui/x-studio';
import { ptBRLocaleText } from '@mui/x-studio';

<Studio localeText={ptBRLocaleText} initialState={myState} />;
```

| Import name      | Language                     |
| :--------------- | :--------------------------- |
| `ptBRLocaleText` | Brazilian Portuguese (pt-BR) |

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

| Token                      | Default                                                           |
| :------------------------- | :---------------------------------------------------------------- |
| `widgetConfigureChartHint` | `'Use the Setup tab to configure this chart.'`                    |
| `widgetConfigureGaugeHint` | `'Use the Setup tab to choose a gauge value field.'`              |
| `widgetConfigurePivotHint` | `'Use the Setup tab to configure row, column, and value fields.'` |
| `widgetNoData`             | `'No data to display.'`                                           |
| `widgetLoadError`          | `'Failed to load data'`                                           |

### Quick filter bar

| Token                       | Default                    |
| :-------------------------- | :------------------------- |
| `quickFilterBarOpenFilters` | `'Open filters panel'`     |
| `quickFilterBarClearAll`    | `'Clear all page filters'` |

### Widget card actions

| Token                    | Default           |
| :----------------------- | :---------------- |
| `widgetEditTooltip`      | `'Edit widget'`   |
| `widgetExportCsvTooltip` | `'Export as CSV'` |
| `widgetExportPngTooltip` | `'Export as PNG'` |
| `widgetExpandTooltip`    | `'Expand chart'`  |
| `widgetMoveToPageLabel`  | `'Move to page'`  |

### AI assistant

| Token                     | Default                |
| :------------------------ | :--------------------- |
| `aiAssistantOpenTooltip`  | `'Open AI assistant'`  |
| `aiAssistantCloseTooltip` | `'Close AI assistant'` |

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
