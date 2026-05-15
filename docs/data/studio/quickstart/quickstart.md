---
title: Studio - Quickstart
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Quickstart

<p class="description">Install the MUI X Studio package and embed a working dashboard builder in minutes.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Installation

Install the package using your preferred package manager:

<codeblock storageKey="package-manager">

```bash npm
npm install @mui/x-studio
```

```bash pnpm
pnpm add @mui/x-studio
```

```bash yarn
yarn add @mui/x-studio
```

</codeblock>

### Peer dependencies

#### Material UI

Studio requires `@mui/material` and its emotion dependencies:

<codeblock storageKey="package-manager">

```bash npm
npm install @mui/material @emotion/react @emotion/styled
```

```bash pnpm
pnpm add @mui/material @emotion/react @emotion/styled
```

```bash yarn
yarn add @mui/material @emotion/react @emotion/styled
```

</codeblock>

#### MUI X Charts and Data Grid Pro

Widgets use Charts and Data Grid Pro internally:

<codeblock storageKey="package-manager">

```bash npm
npm install @mui/x-charts @mui/x-data-grid-pro
```

```bash pnpm
pnpm add @mui/x-charts @mui/x-data-grid-pro
```

```bash yarn
yarn add @mui/x-charts @mui/x-data-grid-pro
```

</codeblock>

#### MUI X Date Pickers

Date-range filter widgets require Date Pickers and a date adapter:

<codeblock storageKey="package-manager">

```bash npm
npm install @mui/x-date-pickers dayjs
```

```bash pnpm
pnpm add @mui/x-date-pickers dayjs
```

```bash yarn
yarn add @mui/x-date-pickers dayjs
```

</codeblock>

#### React

<!-- #react-peer-version -->

[`react`](https://www.npmjs.com/package/react) and [`react-dom`](https://www.npmjs.com/package/react-dom) must be 17, 18, or 19:

```json
"peerDependencies": {
  "react": "^17.0.0 || ^18.0.0 || ^19.0.0",
  "react-dom": "^17.0.0 || ^18.0.0 || ^19.0.0"
}
```

## Basic usage

Wrap your app in `LocalizationProvider`, then render `<Studio>` inside a sized container.
Pass `initialState` with at least one data source so users have something to work with right away.

```tsx
import * as React from 'react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { Studio } from '@mui/x-studio';
import type { StudioState } from '@mui/x-studio';

const initialState: Partial<StudioState> = {
  dashboard: { id: 'db-1', title: 'My Dashboard', activePageId: 'page-1' },
  pages: {
    'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
  },
  dataSources: {
    sales: {
      id: 'sales',
      label: 'Sales',
      fields: [
        { id: 'month', label: 'Month', type: 'string' },
        { id: 'revenue', label: 'Revenue', type: 'number', aggregatable: true },
        { id: 'category', label: 'Category', type: 'string' },
      ],
      rows: [
        { month: 'Jan', revenue: 12000, category: 'Electronics' },
        { month: 'Feb', revenue: 18500, category: 'Clothing' },
        { month: 'Mar', revenue: 9200, category: 'Electronics' },
        { month: 'Apr', revenue: 22000, category: 'Furniture' },
      ],
    },
  },
};

export default function App() {
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      {/* Studio fills its container — give it an explicit height */}
      <div style={{ height: '100vh' }}>
        <Studio initialState={initialState} />
      </div>
    </LocalizationProvider>
  );
}
```

When you render this:

1. Studio opens in **edit mode** with the sidebar visible.
2. Click **+ Add widget** in the Compose drawer to add your first chart or KPI.
3. Select a data source and configure the chart type, dimensions, and metrics.
4. Toggle to **view mode** to see the clean, non-editable result.

## Responding to state changes

Use `onStateChange` to sync Studio's state with your own React state.
This lets you build a toolbar that reflects the current mode, page title, and undo/redo availability.

```tsx
import { Studio } from '@mui/x-studio';
import type { StudioHandle, StudioMode, StudioState } from '@mui/x-studio';

export default function App() {
  const studioRef = React.useRef<StudioHandle>(null);
  const [mode, setMode] = React.useState<StudioMode>('edit');
  const [canUndo, setCanUndo] = React.useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header>
        <button onClick={() => studioRef.current?.undo()} disabled={!canUndo}>
          Undo
        </button>
        <button
          onClick={() =>
            studioRef.current?.setMode(mode === 'edit' ? 'view' : 'edit')
          }
        >
          {mode === 'edit' ? 'View' : 'Edit'}
        </button>
      </header>

      <div style={{ flexGrow: 1 }}>
        <Studio
          ref={studioRef}
          initialState={initialState}
          onStateChange={(state) => {
            setMode(state.mode);
            setCanUndo(studioRef.current?.canUndo() ?? false);
          }}
        />
      </div>
    </div>
  );
}
```

:::info
Use functional state updates (e.g. `setMode((prev) => ...)`) to skip React re-renders when the value hasn't changed.
All six `setState` calls in `onStateChange` are batched into a single re-render in React 18+.
:::

## See also

- [Studio component](/x/react-studio/getting-started/studio/) — full `<Studio>` API, `StudioHandle`, and slot props
- [Composed approach](/x/react-studio/getting-started/composition/) — build a custom layout using `StudioProvider` and individual pieces
- [Inline data sources](/x/react-studio/data/data-sources/) — the full `StudioDataSource` and `StudioDataField` shapes
- [Async adapters](/x/react-studio/data/async-adapters/) — delegate filtering and aggregation to your server
- [AI assistant](/x/react-studio/ai/setup/) — add an AI chat panel with tool calling
