import type { FunnelValueType } from './funnel.types';

/**
 * Creates a `valueFormatter` that displays each section's value as a
 * percentage of the total across all sections.
 *
 * Usage:
 * ```tsx
 * <FunnelChart
 *   series={[{ data, valueFormatter: createFunnelPercentFormatter(data) }]}
 * />
 * ```
 *
 * @param {FunnelValueType[]} data The same data array passed to the series.
 * @param {{ decimals?: number }} options Formatting options.
 * @returns A `valueFormatter` function compatible with `FunnelSeriesType.valueFormatter`.
 */
export function createFunnelPercentFormatter(
  data: FunnelValueType[],
  options?: { decimals?: number },
): (item: FunnelValueType | null) => string {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const decimals = options?.decimals ?? 1;

  return (item: FunnelValueType | null): string => {
    if (item == null || total === 0) {
      return '';
    }
    const pct = (item.value / total) * 100;
    return `${pct.toFixed(decimals)}%`;
  };
}

/**
 * Creates a `valueFormatter` that displays each section's value as a
 * conversion rate relative to the first (largest) section in the data array.
 *
 * Usage:
 * ```tsx
 * <FunnelChart
 *   series={[{ data, valueFormatter: createFunnelConversionFormatter(data) }]}
 * />
 * ```
 *
 * @param {FunnelValueType[]} data The same data array passed to the series.
 * @param {{ decimals?: number }} options Formatting options.
 * @returns A `valueFormatter` function compatible with `FunnelSeriesType.valueFormatter`.
 */
export function createFunnelConversionFormatter(
  data: FunnelValueType[],
  options?: { decimals?: number },
): (item: FunnelValueType | null) => string {
  const maxValue = Math.max(...data.map((d) => d.value), 0);
  const decimals = options?.decimals ?? 1;

  return (item: FunnelValueType | null): string => {
    if (item == null || maxValue === 0) {
      return '';
    }
    const rate = (item.value / maxValue) * 100;
    return `${rate.toFixed(decimals)}%`;
  };
}
