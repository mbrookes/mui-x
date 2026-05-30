---
title: Studio — Drill-down panel
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio — Drill-down panel

<p class="description">The legacy drill-down drawer export remains in the package, but the drill-down feature itself has been removed from Studio.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Current status

`StudioDrilldownDrawer` is still exported from `@mui/x-studio` for backwards compatibility, but it is deprecated and currently renders nothing.
Studio no longer mounts a drill-down panel by default, and the current widget model does not expose a `drilldownWidgetId` config field.

```tsx
import { StudioDrilldownDrawer } from '@mui/x-studio';

// Deprecated: renders null.
<StudioDrilldownDrawer />;
```

## What is not available

The current codebase does **not** include:

- a slide-in drill-down panel wired into `StudioCanvas`
- a compose-panel **Interactions** section for drill-down targets
- a `drilldownWidgetId` widget config option
- a `featureFlags.drilldown` feature flag

If you need click-to-detail behavior today, build it in the host app with regular React state and Studio's existing filter APIs.
For most dashboards, [cross-filters](/x/react-studio/features/cross-filters/) are the closest built-in alternative.

## See also

- [Cross-filters](/x/react-studio/features/cross-filters/) — click a chart item or grid row to filter other widgets
- [Grid widget](/x/react-studio/widgets/grid/) — show row-level detail in a built-in table
- [Chart widget](/x/react-studio/widgets/chart/) — interactive chart clicks that already participate in Studio filtering
