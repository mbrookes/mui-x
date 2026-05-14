---
title: Studio - Theming
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Theming

<p class="description">Integrate Studio into your MUI theme with component defaultProps, per-page canvas colours, and full dark mode support.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Theme augmentation

Studio ships a `themeAugmentation` entry point that extends the MUI theme type with the `MuiStudio` component key. Import it once (side-effect import) alongside your `createTheme` call:

```tsx
import { createTheme } from '@mui/material/styles';
import type {} from '@mui/x-studio/themeAugmentation';

const theme = createTheme({
  components: {
    MuiStudio: {
      defaultProps: {
        // Applied to every <Studio> rendered under this ThemeProvider
        initialMode: 'view',
      },
    },
  },
});
```

The `defaultProps` type is `Partial<StudioProps>`, so any prop accepted by `<Studio>` can be set as a default here. This is useful for:

- Defaulting all Studio instances to view mode in production
- Setting a default `aiConfig` for all instances in the app
- Applying a common `slotProps` override across your product

## MUI theme integration

Studio inherits all MUI theme tokens: palette (primary, secondary, background, text), typography, spacing, shape (border radius), and shadows. No special configuration is needed — just wrap Studio in your existing `ThemeProvider`.

```tsx
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { Studio } from '@mui/x-studio';

const theme = createTheme({
  palette: {
    primary: { main: '#6750a4' }, // Studio's accent (FAB, active states)
  },
  shape: {
    borderRadius: 12, // Widget cards pick this up
  },
});

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <Studio initialState={initialState} dataSources={sources} />
    </ThemeProvider>
  );
}
```

## Dark mode

Set `colorScheme: 'dark'` or use a `mode: 'dark'` palette — Studio adapts all its surfaces, text colours, and chart palettes automatically:

```tsx
const darkTheme = createTheme({
  palette: {
    mode: 'dark',
  },
});
```

## Per-page canvas colours

`StudioPageTheme` lets you override the canvas background and widget card colours for individual pages (or set a global default on the dashboard):

```ts
interface StudioPageTheme {
  pageBackground?: string; // CSS colour string
  cardBackground?: string; // CSS colour string
  cardPadding?: 0 | 1 | 2 | 3 | 4; // MUI spacing units, default 2
}
```

Set on the dashboard for a global default, or on a specific page to override:

```tsx
const initialState = createDefaultStudioState({
  dashboard: {
    id: 'dash-1',
    title: 'My Dashboard',
    activePageId: 'page-1',
    defaultTheme: {
      pageBackground: '#f0f4f8',
      cardBackground: '#ffffff',
      cardPadding: 2,
    },
  },
  pages: {
    'page-1': {
      id: 'page-1',
      title: 'Overview',
      widgetRows: [],
      // overrides the dashboard default for this page only
      theme: {
        pageBackground: '#1e1e2e',
        cardBackground: '#2a2a3e',
      },
    },
  },
});
```

## Chart colour palettes

Studio uses the MUI X Charts colour palette by default. To customise the chart colours, override them on the MUI theme using the Charts theme augmentation:

```tsx
import type {} from '@mui/x-charts/themeAugmentation';

const theme = createTheme({
  colorSchemes: {
    light: {
      palette: {
        // MUI X Charts reads these for series colours
      },
    },
  },
});
```

See the [MUI X Charts theming documentation](https://mui.com/x/react-charts/styling/) for the full list of tokens.
