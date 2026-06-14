'use client';
import * as React from 'react';

// ─── Context ──────────────────────────────────────────────────────────────────

export interface StudioMapTooltipContextValue {
  /** Display label for the value field, shown alongside the formatted value. */
  valueFieldLabel: string | null;
  /** Converts a geographic featureId (e.g. alpha-2 code, state abbreviation) to a display name. */
  featureIdToLabel: (featureId: string) => string;
}

export const StudioMapTooltipContext = React.createContext<StudioMapTooltipContextValue>({
  valueFieldLabel: null,
  featureIdToLabel: (featureId) => featureId,
});
