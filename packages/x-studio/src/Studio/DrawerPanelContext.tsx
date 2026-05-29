'use client';

import * as React from 'react';

export const DRAWER_WIDTH = 215;
export const COLLAPSED_WIDTH = 36;

/**
 * Context that lets content rendered inside a DrawerPanel's scroll area inject
 * a node into the fixed subheader slot (above the scroll, below the title bar).
 */
export interface DrawerSubheaderContextValue {
  setSubheader: (node: React.ReactNode) => void;
}
export const DrawerSubheaderContext = React.createContext<DrawerSubheaderContextValue | null>(null);

/**
 * Call inside a DrawerPanel child to render `node` in the fixed subheader slot.
 * Uses useLayoutEffect so the node appears on the first paint with no flash.
 */
export function useDrawerSubheader(node: React.ReactNode) {
  const ctx = React.use(DrawerSubheaderContext);
  React.useLayoutEffect(() => {
    ctx?.setSubheader(node);
    return () => ctx?.setSubheader(null);
  }, [ctx, node]);
}
