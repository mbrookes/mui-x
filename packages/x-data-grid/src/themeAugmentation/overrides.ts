import type { GridClassKey } from '../constants/gridClasses';

export interface DataGridComponentNameToClassKey {
  MuiDataGrid: GridClassKey;
}

declare module '@mui/material/styles' {
  interface ComponentNameToClassKey extends DataGridComponentNameToClassKey {}

  interface PaletteDataGrid {
    bg?: string;
    headerBg?: string;
    pinnedBg?: string;
  }

  interface CssVarsPalette {
    DataGrid: PaletteDataGrid;
  }

  /**
   * Optional here, required on `CssVarsPalette`, and that asymmetry is deliberate: a CSS-variables
   * theme always materializes the key, whereas a plain `createTheme()` theme only has it if the
   * consumer passed `palette.DataGrid`.
   *
   * Declared at all because `PaletteOptions` accepts the key — so without this, a theme built from
   * an option the augmentation itself invites could not be read back. `useMaterialCSSVariables`
   * reads `(theme.vars || theme).palette.DataGrid`, a union whose plain-`Palette` arm made that
   * access fail to compile.
   */
  interface Palette {
    DataGrid?: PaletteDataGrid;
  }

  interface PaletteOptions {
    DataGrid?: Partial<PaletteDataGrid>;
  }
}
