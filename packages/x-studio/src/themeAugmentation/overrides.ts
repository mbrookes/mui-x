/**
 * Theme component overrides for @mui/x-studio.
 *
 * Extend your MUI theme with Studio component prop defaults:
 *
 * ```tsx
 * import type {} from '@mui/x-studio/themeAugmentation';
 *
 * const theme = createTheme({
 *   components: {
 *     MuiStudio: {
 *       defaultProps: { ... },
 *     },
 *   },
 * });
 * ```
 */

import type {} from '@mui/material/styles';

declare module '@mui/material/styles' {
  interface Components {
    MuiStudio?: {
      defaultProps?: Partial<import('../components/Studio/Studio').StudioProps>;
    };
  }
}

export {};
