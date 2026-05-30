---
title: MUI X Studio
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# MUI X Studio

<p class="description">A full-featured, embeddable dashboard builder with drag-and-drop layout, rich widgets, cross-filtering, and an optional AI assistant.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## What is Studio?

Studio is a React component that renders a complete, interactive dashboard builder inside your application.
Users can add and configure widgets (charts, KPIs, tables, filters, rich text), connect them to data sources, apply filters, and switch between edit and view mode — all without leaving the page.

Key capabilities:

- **Edit / view mode** — switch between a drag-and-drop editing experience and a clean read-only view
- **Widget types** — bar, line, pie, scatter charts; KPI cards with sparklines; Data Grid tables; date-range, multi-select, toggle, and slider filter widgets; rich text
- **Cross-filtering** — clicking a chart or table row filters other widgets on the page automatically
- **Multi-page dashboards** — multiple pages per dashboard, each with its own layout and theme
- **State persistence** — serialize the entire dashboard to JSON and restore it later with automatic schema migration
- **AI assistant** — an optional chat panel powered by any OpenAI-compatible endpoint; the AI can add and configure widgets through tool calls
- **Async data adapters** — delegate row-fetching, filtering, and aggregation to a server-side handler

## Approaches

There are two ways to embed Studio:

### Single-component approach

Use `<Studio>` as a self-contained unit with your own toolbar around it.
All internal UI (sidebar drawers, canvas, AI panel) is managed for you.
Read state via `onStateChange` and control it imperatively through a ref (`StudioHandle`).

```tsx
import { Studio } from '@mui/x-studio';
import type { StudioHandle, StudioMode, StudioState } from '@mui/x-studio';

const ref = React.useRef<StudioHandle>(null);

<Studio
  ref={ref}
  initialState={myInitialState}
  onStateChange={(state) => {
    setMode(state.mode);
    setCanUndo(ref.current?.canUndo() ?? false);
  }}
/>;
```

See [Studio component](/x/react-studio/getting-started/studio/) for the full API.

### Composed approach

Use `StudioProvider` + individual pieces (`StudioCanvas`, `DrawerPanel`, `TabbedSidebar`) to build a completely custom layout.
The `Studio` component itself is built this way.

```tsx
import {
  StudioProvider,
  StudioCanvas,
  DrawerPanel,
  StudioDataDrawer,
  useStudioController,
} from '@mui/x-studio';

<StudioProvider controller={controller}>
  <DrawerPanel drawer="data" title="Data">
    <StudioDataDrawer />
  </DrawerPanel>
  <StudioCanvas />
</StudioProvider>;
```

See [Composed approach](/x/react-studio/getting-started/composition/) for details.

## Widget types

| Type                             | Component            | Description                                   |
| :------------------------------- | :------------------- | :-------------------------------------------- |
| Bar / line / pie / scatter chart | `StudioChartWidget`  | Powered by MUI X Charts                       |
| KPI card                         | `StudioKpiWidget`    | Big number with sparkline and trend indicator |
| Table                            | `StudioGridWidget`   | Powered by MUI X Data Grid Pro                |
| Filter                           | `StudioFilterWidget` | Date-range, multi-select, toggle, or slider   |
| Text                             | `StudioTextWidget`   | Rich text with Markdown support               |

## Data flow

Studio works with data sources that contain rows and field definitions.
You can provide rows inline (sync) or delegate fetching to an async adapter (useful for large datasets and server-side filtering):

```ts
// Inline (sync)
const source: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'revenue', label: 'Revenue', type: 'number', aggregatable: true },
  ],
  rows: ordersData, // array of plain objects
};

// Async adapter
studioRef.current?.setDataSourceAdapter('orders', {
  async getRows(descriptor) {
    return fetch('/api/orders', { body: JSON.stringify(descriptor) }).then((r) =>
      r.json(),
    );
  },
});
```

See [Inline data sources](/x/react-studio/data/data-sources/) and [Async adapters](/x/react-studio/data/async-adapters/).

## See also

- [Quickstart](/x/react-studio/quickstart/) — install and render your first dashboard in minutes
- [Studio component](/x/react-studio/getting-started/studio/) — full `<Studio>` API and `StudioHandle` reference
- [Composed approach](/x/react-studio/getting-started/composition/) — build a custom layout using `StudioProvider`
- [Inline data sources](/x/react-studio/data/data-sources/) — the `StudioDataSource` and `StudioDataField` shapes
- [AI assistant](/x/react-studio/ai/setup/) — add a chat panel powered by any OpenAI-compatible endpoint
