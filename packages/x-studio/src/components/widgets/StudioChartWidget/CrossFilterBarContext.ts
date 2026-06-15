'use client';
import * as React from 'react';

interface CrossFilterBarData {
  /** filteredValues[seriesId][dataIndex] = cross-filter value (null if category is filtered out) */
  filteredValuesBySeriesId: Record<string, (number | null)[]>;
  /** allValues[seriesId][dataIndex] = baseline (no cross-filter) value */
  allValuesBySeriesId: Record<string, number[]>;
}

export const CrossFilterBarContext = React.createContext<CrossFilterBarData | null>(null);
