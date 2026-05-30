---
title: Studio - Slot props
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Slot props

<p class="description">Customize individual sub-components — chart types, KPI displays, widget cards, paper surfaces — without replacing the entire component tree.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Slots vs slotProps

Studio follows the MUI X convention:

- **`slots`** — replace a sub-component entirely with your own React component.
- **`slotProps`** — forward extra props to the default sub-component (no replacement needed).

Most customizations use `slotProps`.
Use `slots` when you need a fundamentally different rendering.

## The slot props chain

Slot props flow through a hierarchy from `Studio` down to individual widget components:

```text
Studio
└─ slotProps.canvas (StudioCanvasProps)
   └─ slotProps.widgetCard (StudioWidgetCardProps)
      ├─ slotProps.paper        → outer <Paper> (PaperProps)
      ├─ slotProps.chart        → StudioChartWidget
      │  └─ slotProps.barChart   → <BarChart> props
      │  └─ slotProps.lineChart  → <LineChart> props
      │  └─ slotProps.pieChart   → <PieChart> props
      │  └─ slotProps.scatterChart → <ScatterChart> props
      │  └─ slots.noDataOverlay  → custom component for unconfigured/empty state
      ├─ slotProps.kpi          → StudioKpiWidget
      │  └─ slotProps.value      → <KpiValue> props
      │  └─ slotProps.sparkline  → <KpiSparkline> props
      │  └─ slotProps.trend      → <KpiTrend> props
      │  └─ slots.value/sparkline/trend → replace sub-components
      ├─ slotProps.grid         → StudioGridWidget
      │  └─ slotProps.dataGrid  → DataGridPro props
      │     └─ slots.noRowsOverlay → custom component for empty rows
      ├─ slotProps.filter       → StudioFilterWidget
      │  └─ slotProps.dateRangeControl / multiSelectControl / toggleControl / sliderControl
      │  └─ slots.dateRangeControl / ...  → replace control components
      └─ slotProps.text         → StudioTextWidget
```

The AI chat panel has its own chain via `slotProps.chatPanel`:

```text
Studio
└─ slotProps.chatPanel (StudioChatPanelProps without aiConfig/open/onClose/overlay)
   └─ slotProps.chatBox   → <ChatBox> props
   └─ slotProps.panel     → overlay container <Box> props
```

## Common examples

### Outlined widget cards

Replace the default elevated `Paper` with an outlined variant:

```tsx
<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            paper: { elevation: 0, variant: 'outlined' },
          },
        },
      },
    },
  }}
/>
```

### Rounded corners on bar charts

Forward `borderRadius` to every bar chart:

```tsx
<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
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

### Stripe rows on all grids

```tsx
<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            grid: {
              slotProps: {
                dataGrid: {
                  getRowClassName: (params) =>
                    params.indexRelativeToCurrentPage % 2 === 0 ? 'even' : 'odd',
                },
              },
            },
          },
        },
      },
    },
  }}
/>
```

### Custom no-data overlay for charts and grids

When widgets have no rows to display (after filtering, or because the server returned an empty result), Studio shows a `StudioNoDataOverlay` — a centered inbox icon with a "No data" label in `text.disabled` colour. This component is exported from `@mui/x-studio` so you can use it directly with a custom message, or replace it entirely.

#### Chart widgets

The chart `slots.noDataOverlay` is used both when a chart has no data **and** when it has an unsupported configuration (e.g. missing required fields). Provide a custom component to cover both cases, or just override the message for the default look:

```tsx
import { StudioNoDataOverlay } from '@mui/x-studio';

// Custom message, default appearance
<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            chart: {
              slots: {
                noDataOverlay: () => (
                  <StudioNoDataOverlay message="No orders match the current filters" />
                ),
              },
            },
          },
        },
      },
    },
  }}
/>

// Or directly on StudioChartWidget (composed approach)
<StudioChartWidget
  widget={widget}
  dataSource={source}
  slots={{ noDataOverlay: () => <StudioNoDataOverlay message="No data available" /> }}
/>
```

#### Grid widgets

The grid's empty overlay is surfaced through the underlying `DataGridPro` `noRowsOverlay` slot:

```tsx
import { StudioNoDataOverlay } from '@mui/x-studio';

<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            grid: {
              slotProps: {
                dataGrid: {
                  slots: {
                    noRowsOverlay: () => (
                      <StudioNoDataOverlay message="No results — try adjusting filters" />
                    ),
                  },
                },
              },
            },
          },
        },
      },
    },
  }}
/>;
```

#### `StudioNoDataOverlay` props

```ts
interface StudioNoDataOverlayProps {
  /** Override the default "No data" label. */
  message?: string;
  /** Optional fixed height — used by chart widgets to match the chart canvas height. */
  height?: number | string;
}
```

### Custom KPI value renderer

Replace the default big-number display with your own component:

```tsx
import type { StudioKpiWidgetSlots } from '@mui/x-studio';

function MyKpiValue({ value, format }: { value: number | null; format?: string }) {
  return (
    <Box sx={{ fontSize: 40, fontWeight: 700, color: 'primary.main' }}>
      {value == null ? '—' : new Intl.NumberFormat('en-US').format(value)}
    </Box>
  );
}

<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            kpi: {
              slots: { value: MyKpiValue },
            },
          },
        },
      },
    },
  }}
/>;
```

### Wider AI chat panel

```tsx
<Studio
  aiConfig={aiConfig}
  slotProps={{
    chatPanel: {
      slotProps: {
        panel: { sx: { width: 480 } },
      },
    },
  }}
/>
```

## Using slot props in the composed approach

When composing with `StudioCanvas` directly, pass slotProps to the canvas:

```tsx
<StudioCanvas
  slotProps={{
    widgetCard: {
      slotProps: {
        paper: { elevation: 0, variant: 'outlined' },
        chart: {
          slotProps: {
            barChart: { borderRadius: 6 },
          },
        },
      },
    },
  }}
/>
```

Or target individual widget components directly:

```tsx
<StudioWidgetCard
  widgetId={widgetId}
  slotProps={{
    paper: { elevation: 2 },
    chart: {
      slotProps: { lineChart: { curve: 'natural' } },
    },
  }}
/>
```

## Reference: interfaces

### `StudioCanvasProps`

```ts
interface StudioCanvasProps {
  slotProps?: {
    widgetCard?: Partial<
      Omit<StudioWidgetCardProps, 'widgetId' | 'isFirstRow' | 'pageTheme'>
    >;
  };
}
```

### `StudioWidgetCardProps` — slotProps

```ts
interface StudioWidgetCardProps {
  slotProps?: {
    loadingOverlay?: object;
    paper?: Partial<PaperProps>;
    chart?: Partial<Omit<StudioChartWidgetProps, 'widget' | 'dataSource'>>;
    kpi?: Partial<Omit<StudioKpiWidgetProps, 'widget' | 'dataSource'>>;
    grid?: Partial<Omit<StudioGridWidgetProps, 'widget' | 'dataSource'>>;
    filter?: Partial<Omit<StudioFilterWidgetProps, 'widget' | 'dataSource'>>;
    text?: Partial<Omit<StudioTextWidgetProps, 'widget'>>;
  };
  slots?: {
    loadingOverlay?: React.ElementType;
  };
}
```

### `StudioChartWidgetSlots` / `StudioChartWidgetSlotProps`

```ts
interface StudioChartWidgetSlots {
  noDataOverlay?: React.ElementType<React.HTMLAttributes<HTMLDivElement>>;
}

interface StudioChartWidgetSlotProps {
  noDataOverlay?: React.HTMLAttributes<HTMLDivElement>;
  barChart?: Partial<BarChartProps>;
  lineChart?: Partial<LineChartProps>;
  pieChart?: Partial<PieChartProps>;
  scatterChart?: Partial<ScatterChartProps>;
}
```

### `StudioKpiWidgetSlots` / `StudioKpiWidgetSlotProps`

```ts
interface StudioKpiWidgetSlots {
  value?: React.ElementType<KpiValueProps>;
  sparkline?: React.ElementType<KpiSparklineProps>;
  trend?: React.ElementType<KpiTrendProps>;
}

interface StudioKpiWidgetSlotProps {
  value?: Partial<KpiValueProps>;
  sparkline?: Partial<KpiSparklineProps>;
  trend?: Partial<KpiTrendProps>;
}
```

### `StudioFilterWidgetSlots` / `StudioFilterWidgetSlotProps`

```ts
interface StudioFilterWidgetSlots {
  dateRangeControl?: React.ElementType<StudioFilterDateRangeControlProps>;
  multiSelectControl?: React.ElementType<StudioFilterMultiSelectControlProps>;
  toggleControl?: React.ElementType<StudioFilterToggleControlProps>;
  sliderControl?: React.ElementType<StudioFilterSliderControlProps>;
}

interface StudioFilterWidgetSlotProps {
  dateRangeControl?: Partial<StudioFilterDateRangeControlProps>;
  multiSelectControl?: Partial<StudioFilterMultiSelectControlProps>;
  toggleControl?: Partial<StudioFilterToggleControlProps>;
  sliderControl?: Partial<StudioFilterSliderControlProps>;
}
```

### `StudioChatPanelSlotProps`

```ts
interface StudioChatPanelSlotProps {
  chatBox?: Partial<React.ComponentProps<typeof ChatBox>>;
  panel?: Partial<BoxProps>;
}
```

## See also

- [Composed approach](/x/react-studio/getting-started/composition/) — the composed approach exposes each panel individually
- [Theming](/x/react-studio/customization/theming/) — `StudioTheme` for global chart palette and canvas colours
- [Studio component](/x/react-studio/getting-started/studio/) — full `StudioSlots` and `StudioSlotProps` reference
