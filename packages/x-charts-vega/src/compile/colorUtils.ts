import { color as d3Color } from '@mui/x-charts-vendor/d3-color';

/**
 * Applies a constant opacity to a color by baking it into an rgba() string.
 * x-charts has no per-series opacity prop, so a static `mark.opacity` /
 * `fillOpacity` (or a value-def `opacity` encoding) is expressed by lowering
 * the alpha of the series' resolved color instead. Returns the input unchanged
 * when it can't be parsed.
 */
export function applyAlpha(input: string, opacity: number): string {
  const parsed = d3Color(input);
  if (!parsed) {
    return input;
  }
  parsed.opacity = opacity;
  return parsed.formatRgb();
}
