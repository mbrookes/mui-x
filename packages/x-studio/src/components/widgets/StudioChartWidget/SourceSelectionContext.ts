'use client';
import * as React from 'react';

/**
 * Set of dataIndex values that are currently multi-selected via shift-click.
 * When null, no multi-select is active and bars render normally.
 */
export const SourceSelectionContext = React.createContext<Set<number> | null>(null);
