---
title: Studio — Saved views
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio — Saved views

<p class="description">Name and save the current filter state as a preset so viewers can quickly restore a configured view.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

When `featureFlags.savedFilterViews` is enabled, the Filters drawer shows a **Saved views** section at the bottom.
A saved view is a named snapshot of the current page-level filters for the active page.

## Saving, applying, and deleting

To save a view, click **Save**, type a name, and press **Enter** or click **Save** again.
Studio creates a `StudioFilterPreset` entry from the current page filters.

Click a preset chip to restore that snapshot onto the active page.
Click the delete icon to remove the preset.

## Type

```ts
interface StudioFilterPreset {
  id: string;
  name: string;
  filters: StudioFilterState[]; // snapshot of page-scoped filters
}
```

Presets are stored in `StudioState.filterPresets`, so they are saved and restored with the rest of the dashboard state.

## Programmatic API

Use the controller methods to manage presets imperatively:

```ts
controller.saveFilterPreset('Q4 Revenue View');
controller.applyFilterPreset(presetId);
controller.deleteFilterPreset(presetId);
```

`saveFilterPreset()` captures the active page's page-scoped filters.
`applyFilterPreset()` replaces the current page filters while leaving non-page filters intact.

## Feature flag and localization

`featureFlags.savedFilterViews` defaults to `true`.

Useful locale tokens include:

- `filtersSavedViewsTitle`
- `filtersNoSavedViews`
- `filtersSaveViewTooltip`
- `filtersSaveViewButton`
- `filtersSaveViewPlaceholder`
- `filtersDeleteViewTooltip`

## See also

- [Global filters](/x/react-studio/features/global-filters/) — page filters that saved views snapshot
- [Localization](/x/react-studio/customization/localization/) — override drawer labels and empty states
- [State management](/x/react-studio/getting-started/state/) — where `filterPresets` lives in `StudioState`
