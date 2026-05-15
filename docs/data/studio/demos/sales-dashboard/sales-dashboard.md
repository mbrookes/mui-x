---
title: Sales dashboard demo
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Sales dashboard demo

<p class="description">A complete sales analytics dashboard built with Studio: KPI cards, revenue charts, orders table, regional filters, and AI-powered layout editing — all persisted to localStorage.</p>

## Overview

This demo assembles a production-style sales dashboard using the composed API so each region of the UI can be independently positioned and styled.
It combines five widget types, cross-source data relationships, and an AI chat panel that understands the live dashboard state.

The full source is shown below; copy it into a new file and supply your own data to run it.

## Setup

Install the package and configure a backend model endpoint (see [AI setup](/x/react-studio/ai/setup/)):

```bash
npm install @mui/x-studio @mui/material @emotion/react @emotion/styled dayjs
```

## Full example

```tsx
import * as React from 'react';
import {
  StudioCanvas,
  StudioSidebar,
  StudioChatPanel,
  StudioToolbar,
  useStudioController,
  StudioController,
  StudioStateProvider,
} from '@mui/x-studio';
import type { StudioState } from '@mui/x-studio';
import { Box, Fab } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';

// ── Initial dashboard state ────────────────────────────────────────────────

const INITIAL_STATE: StudioState = {
  dashboard: { title: 'Sales Dashboard', activePageId: 'page-overview' },
  mode: 'edit',
  pages: {
    'page-overview': {
      id: 'page-overview',
      title: 'Overview',
      widgetRows: [
        ['kpi-revenue', 'kpi-orders', 'kpi-aov'],
        ['chart-revenue'],
        ['grid-orders'],
      ],
      widgetColSpans: {
        'kpi-revenue': 4,
        'kpi-orders': 4,
        'kpi-aov': 4,
        'chart-revenue': 8,
      },
    },
  },
  widgets: {
    'kpi-revenue': {
      id: 'kpi-revenue',
      kind: 'kpi',
      title: 'Total revenue',
      sourceId: 'src-orders',
      config: { valueField: 'revenue', aggregation: 'sum', prefix: '$', trend: true },
    },
    'kpi-orders': {
      id: 'kpi-orders',
      kind: 'kpi',
      title: 'Total orders',
      sourceId: 'src-orders',
      config: { valueField: 'id', aggregation: 'count', trend: true },
    },
    'kpi-aov': {
      id: 'kpi-aov',
      kind: 'kpi',
      title: 'Avg order value',
      sourceId: 'src-orders',
      config: { valueField: 'revenue', aggregation: 'avg', prefix: '$', decimals: 2 },
    },
    'chart-revenue': {
      id: 'chart-revenue',
      kind: 'chart',
      title: 'Revenue over time',
      sourceId: 'src-orders',
      config: { chartType: 'line', xField: 'date', yField: 'revenue', aggregation: 'sum' },
    },
    'grid-orders': {
      id: 'grid-orders',
      kind: 'grid',
      title: 'Recent orders',
      sourceId: 'src-orders',
      config: {},
    },
  },
  dataSources: {
    'src-orders': {
      id: 'src-orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'date', label: 'Date', type: 'date' },
        { id: 'customer', label: 'Customer', type: 'string' },
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'revenue', label: 'Revenue', type: 'number' },
        { id: 'status', label: 'Status', type: 'string' },
      ],
      rows: [
        { id: 'ord-1', date: '2025-01-05', customer: 'Acme Corp', region: 'North', revenue: 4200, status: 'completed' },
        { id: 'ord-2', date: '2025-01-12', customer: 'Globex', region: 'South', revenue: 1850, status: 'completed' },
        { id: 'ord-3', date: '2025-02-03', customer: 'Initech', region: 'East', revenue: 3100, status: 'pending' },
        { id: 'ord-4', date: '2025-02-18', customer: 'Umbrella', region: 'West', revenue: 7600, status: 'completed' },
        { id: 'ord-5', date: '2025-03-07', customer: 'Acme Corp', region: 'North', revenue: 5300, status: 'completed' },
        { id: 'ord-6', date: '2025-03-22', customer: 'Hooli', region: 'South', revenue: 2900, status: 'cancelled' },
      ],
    },
  },
  filters: [],
  shell: { selectedWidgetId: null },
};

// ── Persistence helpers ────────────────────────────────────────────────────

const STORAGE_KEY = 'sales-dashboard-state';

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StudioState) : INITIAL_STATE;
  } catch {
    return INITIAL_STATE;
  }
}

function saveState(state: StudioState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ── Root component ─────────────────────────────────────────────────────────

export default function SalesDashboard() {
  const [controller] = React.useState(
    () => new StudioController({ initialState: loadState() }),
  );
  const [chatOpen, setChatOpen] = React.useState(false);

  React.useEffect(() => {
    return controller.subscribe((state) => saveState(state));
  }, [controller]);

  return (
    <StudioStateProvider controller={controller}>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <StudioToolbar />
        <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <StudioSidebar />
          <Box sx={{ flex: 1, overflow: 'auto', position: 'relative' }}>
            <StudioCanvas />
            {/* AI chat FAB */}
            <Fab
              color="primary"
              size="medium"
              onClick={() => setChatOpen((v) => !v)}
              sx={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1200 }}
              aria-label="Toggle AI chat"
            >
              <ChatIcon />
            </Fab>
            {chatOpen && (
              <StudioChatPanel
                adapter={{ type: 'openai', endpoint: '/api/ai/studio' }}
                sx={{
                  position: 'fixed',
                  bottom: 88,
                  right: 24,
                  width: 360,
                  maxHeight: '50vh',
                  zIndex: 1199,
                }}
              />
            )}
          </Box>
        </Box>
      </Box>
    </StudioStateProvider>
  );
}
```

## What this demonstrates

| Feature | Where |
| :--- | :--- |
| KPI widgets with trend lines | `kpi-revenue`, `kpi-orders`, `kpi-aov` |
| 12-column span layout | `widgetColSpans` — three 4-col KPIs on row 1 |
| Line chart aggregated over time | `chart-revenue` |
| Data grid with export | `grid-orders` |
| localStorage persistence | `loadState` / `saveState` |
| AI chat panel | `StudioChatPanel` with FAB toggle |

## Extending the demo

- **Add a regional filter widget** — add a `filter` widget with `filterWidgetType: 'select'` and `field: 'region'` to let users drill into a single region.
- **Add a second page** — extend `pages` and add entries to `widgetRows` to show order details or a map.
- **Server-side data** — replace the `rows` array in `dataSources` with an async adapter (see [Async adapters](/x/react-studio/data/async-adapters/)).

## See also

- [Studio component](/x/react-studio/getting-started/studio/)
- [Composed approach](/x/react-studio/getting-started/composition/)
- [AI setup](/x/react-studio/ai/setup/)
- [Async adapters](/x/react-studio/data/async-adapters/)
- [Embedded view demo](/x/react-studio/demos/embedded-view/)
