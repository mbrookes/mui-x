---
title: Studio - Multi-page dashboards
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Multi-page dashboards

<p class="description">Organise widgets into multiple pages, each with its own layout and optional visual theme.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

A Studio dashboard contains one or more pages. Each page has its own grid of widgets and an optional `StudioPageTheme`. Users switch between pages using the tabs at the bottom of the canvas in edit mode, and via the same tabs (or programmatic navigation) in view mode.

## StudioPage

```ts
interface StudioPage {
  id: string;
  title: string;
  widgetRows: string[][];  // 2-D array of widget IDs
  theme?: StudioPageTheme;
}
```

`widgetRows` represents the layout grid. Each inner array is one horizontal row; widgets in the same row share the row height equally and are displayed side-by-side. For example:

```ts
widgetRows: [
  ['kpi-revenue', 'kpi-orders', 'kpi-aov'],  // three KPIs in a row
  ['chart-revenue-trend'],                     // full-width chart
  ['chart-by-category', 'grid-orders'],        // chart + table side-by-side
]
```

## StudioPageTheme

Override the visual appearance of a single page:

```ts
interface StudioPageTheme {
  pageBackground?: string; // CSS colour for the canvas background
  cardBackground?: string; // CSS colour for widget card surfaces
  cardPadding?: 0 | 1 | 2 | 3 | 4; // MUI spacing units (default 2)
}
```

Set a default theme for all pages on `dashboard.defaultTheme`. Per-page `theme` overrides the default for that page only.

## Preloading multiple pages

```tsx
import { Studio, createDefaultStudioState } from '@mui/x-studio';

const initialState = createDefaultStudioState({
  dashboard: {
    id: 'dash-1',
    title: 'Sales Dashboard',
    activePageId: 'overview',
  },
  pages: {
    overview: {
      id: 'overview',
      title: 'Overview',
      widgetRows: [
        ['kpi-revenue', 'kpi-orders'],
        ['chart-trend'],
      ],
    },
    detail: {
      id: 'detail',
      title: 'Detail',
      widgetRows: [['grid-orders']],
      theme: { pageBackground: '#f5f5f5' },
    },
  },
  widgets: {
    // ... all widgets across all pages
  },
});
```

## Navigating pages programmatically

### Via ref (Studio component)

```tsx
const studioRef = React.useRef<StudioHandle>(null);

// Switch to a named page
studioRef.current?.getController().dispatch({
  type: 'SET_ACTIVE_PAGE',
  pageId: 'detail',
});
```

### Via controller (composed approach)

```tsx
import { useStudioController } from '@mui/x-studio';

function PageSwitcher() {
  const controller = useStudioController();
  return (
    <button
      onClick={() =>
        controller.dispatch({ type: 'SET_ACTIVE_PAGE', pageId: 'detail' })
      }
    >
      Go to Detail
    </button>
  );
}
```

### Via selector

Read the active page ID to synchronise external navigation (for example, a URL query parameter):

```tsx
import { useStudioSelector, selectActivePageId, selectPages } from '@mui/x-studio';

function PageTitle() {
  const activePageId = useStudioSelector(selectActivePageId);
  const pages = useStudioSelector(selectPages);
  return <h2>{pages[activePageId]?.title}</h2>;
}
```

## Page-scoped filters

Filters with `scope: 'page'` apply to all widgets on **all** pages that have the matching field. To restrict a filter to one page, set `scope: 'widget'` on each widget that should be filtered, or design each page to use a separate data source.

## Per-page theming

```tsx
const initialState = createDefaultStudioState({
  dashboard: {
    id: 'dash-1',
    title: 'My Dashboard',
    activePageId: 'page-1',
    defaultTheme: {
      pageBackground: '#fafafa',
      cardBackground: '#ffffff',
      cardPadding: 2,
    },
  },
  pages: {
    'page-1': {
      id: 'page-1',
      title: 'Summary',
      widgetRows: [],
      // inherits dashboard.defaultTheme
    },
    'page-2': {
      id: 'page-2',
      title: 'Dark View',
      widgetRows: [],
      theme: {
        pageBackground: '#1a1a2e',
        cardBackground: '#16213e',
      },
    },
  },
});
```
