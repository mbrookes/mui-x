---
title: Embedded view demo
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Embedded view demo

<p class="description">Embed a read-only dashboard view inside an existing application — no sidebar, no toolbar, no edit controls — using the composed API with forced view mode.</p>

## Overview

The embedded pattern is ideal when you want to display a pre-built dashboard inside a larger application (for example, an analytics pane in a SaaS product).
The viewer sees the live data but cannot edit the layout.
An admin-only route can render the full `Studio` component where authors build and save dashboards.

## How it works

1. Load a `StudioState` from your backend (or localStorage in this example).
2. Instantiate `StudioController` with `mode: 'view'` in `initialState` and no way to switch to `'edit'`.
3. Render only `StudioCanvas` — no toolbar, no sidebar.
4. Pass `slotProps.widgetCard` to strip the drag handle and action overlay.

## Full example

```tsx
import * as React from 'react';
import { StudioCanvas, StudioController, StudioStateProvider } from '@mui/x-studio';
import type { StudioState } from '@mui/x-studio';
import { Box, CircularProgress, Typography } from '@mui/material';

// ── Load state from your backend ──────────────────────────────────────────

async function fetchDashboardState(dashboardId: string): Promise<StudioState> {
  const res = await fetch(`/api/dashboards/${dashboardId}`);
  if (!res.ok) {
    throw new Error(`Failed to load dashboard: ${res.statusText}`);
  }
  return res.json() as Promise<StudioState>;
}

// ── Embedded viewer ───────────────────────────────────────────────────────

interface EmbeddedDashboardProps {
  dashboardId: string;
  /** Height of the dashboard container. Defaults to 100% of the parent. */
  height?: string | number;
}

export function EmbeddedDashboard({
  dashboardId,
  height = '100%',
}: EmbeddedDashboardProps) {
  const [controller, setController] = React.useState<StudioController | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchDashboardState(dashboardId)
      .then((state) => {
        if (cancelled) {
          return;
        }
        // Force view mode regardless of how the state was saved
        setController(
          new StudioController({ initialState: { ...state, mode: 'view' } }),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardId]);

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography color="error">{error}</Typography>
      </Box>
    );
  }

  if (!controller) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <StudioStateProvider controller={controller}>
      <Box sx={{ height, overflow: 'auto' }}>
        <StudioCanvas
          slotProps={{
            widgetCard: {
              // Remove the grab cursor — widgets are not draggable in view mode
              slotProps: { paper: { sx: { cursor: 'default' } } },
            },
          }}
        />
      </Box>
    </StudioStateProvider>
  );
}
```

## Usage in a page

```tsx
import { EmbeddedDashboard } from './EmbeddedDashboard';

export default function AnalyticsPage() {
  return (
    <main>
      <h1>Sales Analytics</h1>
      <EmbeddedDashboard dashboardId="sales-overview" height={600} />
    </main>
  );
}
```

## Saving dashboards (admin route)

The admin route renders the full `Studio` component and POSTs the state to the same endpoint the viewer reads from:

```tsx
import { Studio } from '@mui/x-studio';
import type { StudioState } from '@mui/x-studio';

async function saveDashboard(dashboardId: string, state: StudioState) {
  await fetch(`/api/dashboards/${dashboardId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
}

export default function AdminDashboardEditor({
  dashboardId,
}: {
  dashboardId: string;
}) {
  return (
    <Studio
      onStateChange={(state) => saveDashboard(dashboardId, state)}
      sx={{ height: '100vh' }}
    />
  );
}
```

## What this demonstrates

| Feature                    | Where                                                     |
| :------------------------- | :-------------------------------------------------------- |
| Forced view mode           | `{ ...state, mode: 'view' }` in controller                |
| Canvas-only rendering      | `StudioCanvas` without `StudioToolbar` or `StudioSidebar` |
| Async state loading        | `fetchDashboardState` with loading/error states           |
| Cursor override            | `slotProps.widgetCard.slotProps.paper.sx`                 |
| Separate read/write routes | `EmbeddedDashboard` vs `AdminDashboardEditor`             |

## Key considerations

**Re-rendering when data changes** — `StudioController` holds state internally.
To reflect data changes (e.g., live metrics), refetch the state and pass it to a new controller instance, or use an async data adapter that polls the backend (see [Async adapters](/x/react-studio/data/async-adapters/)).

**Preventing mode switch** — The viewer cannot switch to edit mode because there is no `StudioToolbar`, and the controller was initialized with `mode: 'view'`.
If you need to programmatically guard against a mode switch, listen to `onStateChange` and reset:

```tsx
<StudioCanvas />;
// In a parent component:
controller.subscribe((state) => {
  if (state.mode === 'edit') {
    controller.setMode('view');
  }
});
```

**Responsive height** — Wrap `EmbeddedDashboard` in a parent with a defined height (or `height: 100%`).
If `height` is `'auto'`, the canvas will expand to fit all widgets vertically, which works well inside scrollable containers.

## See also

- [Composed approach](/x/react-studio/getting-started/composition/)
- [State management](/x/react-studio/getting-started/state/)
- [Async adapters](/x/react-studio/data/async-adapters/)
- [Persistence](/x/react-studio/persistence/save-and-load/)
- [Sales dashboard demo](/x/react-studio/demos/sales-dashboard/)
