declare module '@mui/x-date-pickers/LocalizationProvider' {
  import * as React from 'react';

  export interface LocalizationProviderProps {
    dateAdapter: unknown;
    adapterLocale?: string;
    localeText?: Record<string, unknown>;
    children?: React.ReactNode;
  }

  export const LocalizationProvider: React.ComponentType<LocalizationProviderProps>;
}
