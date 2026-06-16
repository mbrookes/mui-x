import * as React from 'react';
import type { AppLocaleText } from './index';

const AppLocaleContext = React.createContext<AppLocaleText | null>(null);

export function AppLocaleProvider({
  children,
  localeText,
}: {
  children: React.ReactNode;
  localeText: AppLocaleText;
}) {
  return <AppLocaleContext.Provider value={localeText}>{children}</AppLocaleContext.Provider>;
}

export function useAppLocaleText(): AppLocaleText {
  const ctx = React.use(AppLocaleContext);
  if (!ctx) {
    throw new Error('useAppLocaleText must be used within AppLocaleProvider');
  }
  return ctx;
}
