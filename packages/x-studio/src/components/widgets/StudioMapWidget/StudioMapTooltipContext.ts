'use client';
import * as React from 'react';

// ─── Context ──────────────────────────────────────────────────────────────────

export interface StudioMapTooltipContextValue {
  /** Display label for the value field, shown alongside the formatted value. */
  valueFieldLabel: string | null;
  /** Converts a geographic featureId (e.g. alpha-2 code, state abbreviation) to a display name. */
  featureIdToLabel: (featureId: string) => string;
  /**
   * Accessible name for one region shape: its display name AND its aggregated value.
   *
   * The shapes announced only the region name, so a screen-reader user tabbing a choropleth
   * heard "France, button", "Spain, button" — the geography, never the measurement, which is
   * the entire point of a choropleth (the value is available to sighted users through the fill
   * colour and the hover tooltip). Composed here rather than in `StudioMapShapePlot` because
   * `StudioMapWidget` is the component that owns both the value formatter and the locale text.
   *
   * Falls back to the bare region name when the region has no measured value — an unshaded
   * region genuinely has nothing to report, and announcing a fabricated `0` would repeat the
   * gauge's mistake.
   */
  regionAriaLabel: (featureId: string, value: number | null | undefined) => string;
}

export const StudioMapTooltipContext = React.createContext<StudioMapTooltipContextValue>({
  valueFieldLabel: null,
  featureIdToLabel: (featureId) => featureId,
  regionAriaLabel: (featureId) => featureId,
});
