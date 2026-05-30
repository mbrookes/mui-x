import {
  fillTemporalLabelGaps,
  formatTemporalAxisLabel,
  getTemporalAxisData,
} from '../internals/chartUtils';
import { formatNumber } from '../internals/numberFormat';
import type { StudioNumberFormat, StudioWidget } from '../models';

export function alignFilteredToAllLabels(
  allLabels: (string | number | Date)[],
  filteredLabels: (string | number | Date)[],
  filteredValues: (number | null)[],
): (number | null)[] {
  const filteredByLabel = new Map(filteredLabels.map((l, i) => [String(l), filteredValues[i]]));
  return allLabels.map((l) => filteredByLabel.get(String(l)) ?? null);
}

// eslint-disable-next-line jsdoc/require-param
/**
 * Wraps a base valueFormatter to show "filtered / total" when a cross-filter is active.
 * @param {((number | null)[]} filteredValues - Array of filtered values aligned to bar chart label indices.
 * @param {(arg: number | null) => string} baseFormatter - The chart series' original value formatter.
 * @returns {(v: number | null, ctx: { dataIndex: number }) => string} A composite formatter showing "filtered / total" for cross-filtered data.
 */
export function makeCrossFilterValueFormatter(
  filteredValues: (number | null)[],
  baseFormatter: (arg: number | null) => string,
): (value: number | null, context: { dataIndex: number }) => string {
  return (value, { dataIndex }) => {
    const fv = filteredValues[dataIndex];
    const base = baseFormatter(value);
    if (fv == null) {
      return `${base} (filtered out)`;
    }
    if (fv === value) {
      return base;
    }
    return `${baseFormatter(fv)} / ${base}`;
  };
}
export function densifyBarLabels(labels: (string | number)[]) {
  return fillTemporalLabelGaps(labels);
}

export function createLineXAxisConfig(
  labels: (string | number)[],
  xGroupBy: StudioWidget['config']['xGroupBy'],
  formatLabel: (label: string | number) => string,
  axisId?: string,
) {
  const temporalData = getTemporalAxisData(labels);
  if (temporalData) {
    return [
      {
        ...(axisId ? { id: axisId } : {}),
        data: temporalData,
        scaleType: 'utc' as const,
        height: 'auto' as const,
        valueFormatter: (value: Date | number) => formatTemporalAxisLabel(value, xGroupBy),
      },
    ];
  }

  return [
    {
      ...(axisId ? { id: axisId } : {}),
      data: labels,
      scaleType: 'point' as const,
      height: 'auto' as const,
      valueFormatter: (v: string | number) => formatLabel(String(v)),
    },
  ];
}

export function makeValueFormatter(format?: StudioNumberFormat, currencyCode?: string) {
  return (value: number | null) => {
    if (value === null) {
      return '';
    }
    if (!format) {
      return String(value);
    }
    return formatNumber(value, format, currencyCode);
  };
}

export function normalizeCrossFilterValue(value: string | number | Date | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value == null) {
    return null;
  }

  return String(value);
}
