---
title: Studio component
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
components: Studio
---

# Studio component

<p class="description">The `Studio` component is the single-entrypoint approach: a self-contained dashboard builder with sidebar, canvas, and optional AI chat panel.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Usage

```tsx
import { Studio } from '@mui/x-studio';
import type { StudioHandle, StudioState } from '@mui/x-studio';

const ref = React.useRef<StudioHandle>(null);

<Studio
  ref={ref}
  initialState={myState}
  onStateChange={(state) => {
    setMode(state.mode);
    setTitle(state.dashboard.title);
    setCanUndo(ref.current?.canUndo() ?? false);
  }}
/>;
```

Studio fills its container — wrap it in a sized element (for example, `height: 100vh` or `flexGrow: 1`).

## Props

### `initialState`

```ts
initialState?: Partial<StudioState>
```

Seeds the dashboard at mount — treated like `defaultValue` in a controlled input.
Changes to `initialState` after mount are **ignored**.
To replace state programmatically, use `ref.loadSerializedState(data)`.

Pass at least one page and one data source for a useful starting point:

```ts
const initialState: Partial<StudioState> = {
  dashboard: { id: 'db-1', title: 'Sales Dashboard', activePageId: 'page-1' },
  pages: {
    'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] },
  },
  dataSources: { orders: ordersSource },
};
```

See [Inline data sources](/x/react-studio/data/data-sources/) for the full `StudioDataSource` shape.

### `onStateChange`

```ts
onStateChange?: (state: StudioState) => void
```

Called on every state change — after every user action, mode switch, or programmatic update.
Use it to sync Studio state into your own React state for toolbar rendering.

:::info
`canUndo` and `canRedo` are not part of `StudioState`.
Read them from the ref inside `onStateChange`:

```ts
onStateChange={(state) => {
  setMode(state.mode);
  setCanUndo(ref.current?.canUndo() ?? false);
  setCanRedo(ref.current?.canRedo() ?? false);
}}
```

:::

The callback identity is tracked internally via a ref, so you can pass an arrow function defined in render without memoizing it (though `useCallback` is still good practice).

### `sidebarLayout`

```ts
sidebarLayout?: 'stacked' | 'tabbed'
```

Controls how the sidebar panels are organized:

- `'stacked'` (default) — each panel (Data, Compose, Filters) has its own independent collapse strip.
- `'tabbed'` — a single tab rail shows all panels; at most one panel is open at a time.

See also [`sidebarSide`](#sidebarside) to control which side of the canvas the sidebar appears on.

### `sidebarSide`

```ts
sidebarSide?: 'left' | 'right'
```

Controls which side of the canvas the sidebar panels are anchored to:

- `'left'` (default) — sidebar is on the left.
- `'right'` — sidebar is on the right.

```tsx
<Studio sidebarSide="right" />
```

When `sidebarSide="right"` and `sidebarLayout="stacked"`, the panels are ordered
Data → Compose → Filters reading right to left (Data closest to the screen edge,
Filters adjacent to the canvas).

### `tableSourceMode`

```ts
tableSourceMode?: 'explicit' | 'implicit'
```

Controls how the table widget's data source is determined in the setup panel:

- `'explicit'` (default) — a data source picker is shown at the top of the table
  setup panel. The user must choose a source before adding columns. This matches
  the Metabase / SQL-first mental model.
- `'implicit'` — no source picker is shown. The source is inferred from the first
  column the user adds (Tableau / Power BI style). Removing all columns resets the
  source, allowing a different one to be chosen.

```tsx
<Studio tableSourceMode="implicit" />
```

### `aiConfig`

```ts
aiConfig?: StudioAIConfig | null
```

When provided, a floating action button appears at the bottom-right corner.
Clicking it opens the AI chat panel (`StudioChatPanel`).

```ts
const aiConfig: StudioAIConfig = {
  endpoint: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
};
```

See [AI assistant](/x/react-studio/ai/setup/) for detailed setup.

### `featureFlags`

```ts
featureFlags?: StudioFeatureFlags
```

Controls which Studio features are visible to the end user. All flags default to `true`, so you can pass a partial object to disable specific UI capabilities. This prop is available on `Studio`, `StudioDashboard`, and `StudioProvider`.

```ts
interface StudioFeatureFlags {
  // Panel visibility
  compose?: boolean; // Show compose/edit panel (locks to view-only when false)
  filters?: boolean; // Show filters panel + quick filter bar
  savedFilterViews?: boolean; // Allow saving named filter presets
  dataManagement?: boolean; // Show data drawer
  aiChat?: boolean; // Enable AI chat panel (requires aiConfig too)

  // Widget kinds (hides from widget picker when false)
  grid?: boolean;
  chart?: boolean;
  kpi?: boolean;
  text?: boolean;
  filter?: boolean;
  pivot?: boolean;
  map?: boolean;

  // KPI features
  kpiSparkline?: boolean; // KPI sparkline section
  kpiTrend?: boolean; // KPI trend badge
  kpiTarget?: boolean; // KPI target line

  // Chart features
  chartAnnotations?: boolean; // Chart reference-line annotations

  // Grid features
  gridGroupBy?: boolean; // Grid group-by field picker
  gridSummary?: boolean; // Grid summary (totals) row
  gridConditionalFormats?: boolean; // Grid conditional formatting
}
```

```tsx
// View-only dashboard with no editing, no data management, no AI
<Studio
  featureFlags={{
    compose: false,
    dataManagement: false,
    aiChat: false,
  }}
/>
```

`StudioDashboard` uses embed-first defaults with `compose: false` and `dataManagement: false`; pass `featureFlags={{ compose: true }}` to re-enable authoring features there. Feature flags only control what users can _see_ in the UI — they are not a server-side access-control mechanism.

### `slotProps`

```ts
slotProps?: {
  canvas?: StudioCanvasProps;
  chatPanel?: Omit<StudioChatPanelProps, 'aiConfig' | 'open' | 'onClose' | 'overlay'>;
}
```

Forwards extra props to internally-rendered subcomponents.

`slotProps.canvas` unlocks the full slot props chain:

```tsx
<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            paper: { elevation: 0, variant: 'outlined' },
            chart: {
              slotProps: {
                barChart: { borderRadius: 8 },
              },
            },
          },
        },
      },
    },
  }}
/>
```

See [Slot props](/x/react-studio/customization/slot-props/) for the full hierarchy.

### Slots (ReactNode overrides)

The `Studio` component accepts four ReactNode slot props that replace entire panels:

| Prop            | Default                   | Description                    |
| :-------------- | :------------------------ | :----------------------------- |
| `canvas`        | `<StudioCanvas />`        | The main widget canvas         |
| `dataDrawer`    | `<StudioDataDrawer />`    | The data sources panel         |
| `composeDrawer` | `<StudioComposeDrawer />` | The widget configuration panel |
| `filtersDrawer` | `<StudioFiltersDrawer />` | The filters panel              |

Use these when you need a fully custom panel UI but still want Studio to own the canvas and state:

```tsx
<Studio dataDrawer={<MyCustomDataPanel />} />
```

### `customWidgets`

Register consumer-defined widget kinds that appear in the widget picker alongside the
built-ins. Pass an array of `StudioCustomWidgetDef`; each entry maps a unique `kind` to
a render `component` and, optionally, a compose-drawer `setupPanel`.

```tsx
import type { StudioCustomWidgetDef } from '@mui/x-studio';

const alertWidget: StudioCustomWidgetDef = {
  kind: 'acme-alert', // namespace to avoid collisions with built-ins
  label: 'Alert Banner',
  description: 'Coloured alert box with a configurable message',
  icon: <NotificationsIcon />,
  component: AlertBannerWidget,
  setupPanel: AlertBannerSetupPanel, // optional
};

<Studio customWidgets={[alertWidget]} />;
```

| Field                | Type                      | Default | Description                                                                              |
| :------------------- | :------------------------ | :------ | :--------------------------------------------------------------------------------------- |
| `kind`               | `string`                  | —       | Unique identifier. Namespace it (for example, `'acme-weather'`) to avoid collisions.     |
| `label`              | `string`                  | —       | Display name in the widget picker.                                                       |
| `component`          | `ComponentType`           | —       | Renders the widget on the canvas. Receives `{ widget, dataSource }`.                     |
| `setupPanel`         | `ComponentType`           | —       | Optional compose-drawer panel that edits the widget's `customConfig`.                    |
| `requiresDataSource` | `boolean`                 | `false` | When `true`, the picker shows the data-source selector before the widget can be created. |
| `defaultConfig`      | `Record<string, unknown>` | —       | JSON-serializable defaults written to `config.customConfig` on creation.                 |
| `fullBleed`          | `boolean`                 | `false` | Render the component edge-to-edge — see below.                                           |

The same `customWidgets` array is accepted on `<StudioProvider>` and `<StudioDashboard>`.
Use the `useCustomWidgetMap()` hook for an O(1) lookup of registered definitions.

#### Full-bleed custom widgets

Set `fullBleed: true` to render the widget edge-to-edge: the card omits its
title/subtitle header and removes its inner padding so the component fills the entire
card. Use this for widgets that are themselves the visual — a banner, a hero image, a
full-card map — where the standard card chrome would get in the way.

```tsx
const bannerWidget: StudioCustomWidgetDef = {
  kind: 'acme-banner',
  label: 'Hero Banner',
  component: HeroBannerWidget,
  fullBleed: true, // no card header, no padding
};
```

## `StudioHandle` — the imperative API

Obtain a reference to the `StudioHandle` via `React.useRef<StudioHandle>(null)`.

### Undo / redo

```ts
ref.current.undo(); // Undo the last action
ref.current.redo(); // Redo the last undone action
ref.current.canUndo(); // true if there is an action to undo
ref.current.canRedo(); // true if there is an action to redo
```

Studio maintains its own undo/redo stack.
Bind these to keyboard shortcuts (`Ctrl+Z` / `Ctrl+Y`) or toolbar buttons:

```tsx
const handleKeyDown = (e: React.KeyboardEvent) => {
  if (e.ctrlKey && e.key === 'z') ref.current?.undo();
  if (e.ctrlKey && e.key === 'y') ref.current?.redo();
};
```

Note: Studio also handles `Ctrl+Z` / `Ctrl+Y` natively when it has focus.
See `useStudioKeyboardShortcuts` if you compose Studio manually.

### Mode

```ts
ref.current.setMode('edit' | 'view');
```

Switches between edit mode (sidebar visible, widgets draggable) and view mode (clean read-only presentation).

### Pages

```ts
ref.current.setActivePage(pageId: string)
```

Navigate to a specific page programmatically.
Pair this with `onStateChange` to build a custom page tab bar:

```tsx
const [pages, setPages] = React.useState<Record<string, StudioPage>>({});
const [activePageId, setActivePageId] = React.useState('');

// In onStateChange:
setPages(state.pages);
setActivePageId(state.dashboard.activePageId);

// In your tab bar:
<Tabs value={activePageId} onChange={(_, id) => ref.current?.setActivePage(id)}>
  {Object.values(pages).map((page) => (
    <Tab key={page.id} value={page.id} label={page.title} />
  ))}
</Tabs>;
```

### State

```ts
ref.current.getState(); // Returns a snapshot of StudioState
ref.current.serializeState(); // Returns a JSON-safe SerializedStudioState
ref.current.loadSerializedState(data); // Restores state; returns MigrationResult
```

See [Save & load](/x/react-studio/persistence/save-and-load/) for the full persistence API.

### Data source adapters

```ts
ref.current.setDataSourceAdapter(sourceId: string, adapter: StudioDataSourceAdapter | undefined)
```

Attaches (or removes) an async data source adapter after mount.
See [Async adapters](/x/react-studio/data/async-adapters .

## Mode indicator in the toolbar

A common pattern is to put an edit/view toggle switch in an external toolbar that also shows the page title and undo/redo buttons.
The `onStateChange` callback gives you everything you need:

```tsx
export default function App() {
  const studioRef = React.useRef<StudioHandle>(null);
  const [mode, setMode] = React.useState<StudioMode>('edit');
  const [title, setTitle] = React.useState('');
  const [pages, setPages] = React.useState<Record<string, StudioPage>>({});
  const [activePageId, setActivePageId] = React.useState('');
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);

  const handleStateChange = React.useCallback((state: StudioState) => {
    setMode((prev) => (prev === state.mode ? prev : state.mode));
    setTitle((prev) =>
      prev === state.dashboard.title ? prev : state.dashboard.title,
    );
    setPages((prev) => (prev === state.pages ? prev : state.pages));
    setActivePageId((prev) =>
      prev === state.dashboard.activePageId ? prev : state.dashboard.activePageId,
    );
    setCanUndo(studioRef.current?.canUndo() ?? false);
    setCanRedo(studioRef.current?.canRedo() ?? false);
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppToolbar
        title={title}
        mode={mode}
        pages={Object.values(pages)}
        activePageId={activePageId}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => studioRef.current?.undo()}
        onRedo={() => studioRef.current?.redo()}
        onModeChange={(_, checked) =>
          studioRef.current?.setMode(checked ? 'edit' : 'view')
        }
        onPageChange={(_, pageId) => studioRef.current?.setActivePage(pageId)}
      />
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        <Studio
          ref={studioRef}
          initialState={myState}
          onStateChange={handleStateChange}
        />
      </Box>
    </Box>
  );
}
```

## See also

- [Quickstart](/x/react-studio/quickstart/) — a minimal working example to get started
- [Composed approach](/x/react-studio/getting-started/composition/) — `StudioProvider` and the individual building blocks
- [State management](/x/react-studio/getting-started/state/) — `StudioState` shape, selectors, and reactive reads
- [Save & load](/x/react-studio/persistence/save-and-load/) — serializing and restoring dashboard state
- [Slot props](/x/react-studio/customization/slot-props/) — customize widgets, cards, and charts without replacing components
