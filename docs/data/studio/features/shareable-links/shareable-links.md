---
title: Studio — Shareable filter links
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio — Shareable filter links

<p class="description">Active page filters can be encoded in the URL so viewers can bookmark and share filtered dashboard states.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

Studio core does not automatically read or write filter state to the URL.
The composed demo app shows one integration pattern for shareable links.

In that example, page-filter values are encoded as `?fv=<base64-JSON>`.
The payload stores the active filter values by filter ID and includes `operator`, `value`, `operator2`, and `value2` when present.

## What gets encoded

The demo encodes page-scoped filters with a non-null `value`:

```ts
type EncodedFilterValues = Record<
  string,
  { operator: string; value: unknown; operator2?: string; value2?: unknown }
>;
```

Cross-filters, interactive filters, and widget-scoped filters are excluded because the encoder only reads `scope === 'page'`.

## URL sync behavior

The demo app debounces filter changes by 300 ms before updating `window.history.replaceState()`.
On first load, it reads `?fv=` and patches `initialState.filters` before the controller is constructed, so there is no visual flash from applying filters after mount.

```ts
const urlValues = decodeFilterValues(
  new URL(window.location.href).searchParams.get('fv') ?? '',
);

const initialState = {
  ...baseState,
  filters: baseState.filters.map((filter) => {
    const patch = urlValues?.[filter.id];
    return patch ? { ...filter, ...patch } : filter;
  }),
};
```

## Copy link button

The composed demo toolbar includes a **Copy link** button.
It copies `window.location.href` to the clipboard and shows a **Copied!** tooltip for 2 seconds.

## Custom apps

If you want shareable links in your own app, implement the same pattern in the host application:

1. Decode `?fv=` before creating the controller.
2. Patch the matching page filters in `initialState`.
3. Re-encode page-filter values when filters change.

Studio itself does not auto-read the URL.
That behavior belongs to the consuming app.

## See also

- [Global filters](/x/react-studio/features/global-filters/) — page-scoped filter state
- [State management](/x/react-studio/getting-started/state/) — initialize and observe `StudioState`
