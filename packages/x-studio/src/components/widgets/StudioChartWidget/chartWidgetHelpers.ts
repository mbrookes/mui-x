import {
  fillTemporalLabelGaps,
  formatTemporalAxisLabel,
  getTemporalAxisData,
} from '../../../internals/temporalUtils';
import { formatNumber } from '../../../internals/numberFormat';
import type {
  AggregatedData,
  MultiSeriesData,
  MultiYSeriesData,
} from '../../../internals/chartAggregation';
import type {
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioNumberFormat,
  StudioWidget,
} from '../../../models';

/** A temporal-gap-densified aggregation — gap-filled positions carry `null` values. */
export interface DensifiedAggregatedData {
  labels: (string | number)[];
  values: (number | null)[];
}
export interface DensifiedMultiSeriesData {
  labels: (string | number)[];
  seriesNames: (string | number)[];
  seriesData: Record<string | number, (number | null)[]>;
}
export interface DensifiedMultiYSeriesData {
  labels: (string | number)[];
  series: Array<{ fieldId: string; values: (number | null)[] }>;
}

/**
 * Fills temporal gaps in a single-series aggregation, inserting `null` for the synthesized
 * label positions. Returns the input unchanged (same object) when there are no gaps, so callers
 * can keep the cheap identity-equality short-circuit their memos relied on.
 */
export function densifyAggregated(data: AggregatedData): DensifiedAggregatedData {
  const labels = densifyBarLabels(data.labels);
  if (labels === data.labels) {
    return data;
  }
  const valueByLabel = new Map(data.labels.map((label, index) => [label, data.values[index]]));
  return {
    labels,
    values: labels.map((label) => valueByLabel.get(label) ?? null),
  };
}

/** Fills temporal gaps in a split-by (series-field) aggregation. */
export function densifyMultiSeries(data: MultiSeriesData): DensifiedMultiSeriesData {
  const labels = densifyBarLabels(data.labels);
  if (labels === data.labels) {
    return data;
  }
  return {
    labels,
    seriesNames: data.seriesNames,
    seriesData: Object.fromEntries(
      data.seriesNames.map((seriesName) => {
        const valueByLabel = new Map(
          data.labels.map((label, index) => [label, data.seriesData[seriesName][index]]),
        );
        return [seriesName, labels.map((label) => valueByLabel.get(label) ?? null)];
      }),
    ),
  };
}

/** Fills temporal gaps in a multi-Y aggregation (one entry per y-field). */
export function densifyMultiY(data: MultiYSeriesData): DensifiedMultiYSeriesData {
  const labels = densifyBarLabels(data.labels);
  if (labels === data.labels) {
    return data;
  }
  return {
    labels,
    series: data.series.map((series) => {
      const valueByLabel = new Map(
        data.labels.map((label, index) => [label, series.values[index]]),
      );
      return {
        fieldId: series.fieldId,
        values: labels.map((label) => valueByLabel.get(label) ?? null),
      };
    }),
  };
}

/** Shape consumed by `CrossFilterBarContext`. */
export interface GhostBarContext {
  filteredValuesBySeriesId: Record<string, (number | null)[]>;
  allValuesBySeriesId: Record<string, number[]>;
}

/**
 * Builds the `CrossFilterBarContext` value for the multi-Y and split-by bar ghost overlays.
 * For each series, the filtered values are aligned to the all-data label order (missing series
 * → an all-null column) and the baseline values are null-coalesced to `0`.
 */
export function buildGhostBarContext(
  allLabels: (string | number)[],
  filteredLabels: (string | number)[],
  series: Array<{
    seriesId: string;
    allValues: (number | null)[];
    filteredValues: (number | null)[] | null;
  }>,
): GhostBarContext {
  const filteredValuesBySeriesId: Record<string, (number | null)[]> = {};
  const allValuesBySeriesId: Record<string, number[]> = {};
  for (const { seriesId, allValues, filteredValues } of series) {
    filteredValuesBySeriesId[seriesId] = filteredValues
      ? alignFilteredToAllLabels(allLabels, filteredLabels, filteredValues)
      : allLabels.map(() => null);
    allValuesBySeriesId[seriesId] = allValues.map((v) => v ?? 0);
  }
  return { filteredValuesBySeriesId, allValuesBySeriesId };
}

/**
 * Gates the hover-driven highlight for a chart. A hovered item highlights only when nothing is
 * cross-filtering this widget (neither an active own x-filter nor an incoming cross-filter) and
 * the hovered series is one this chart owns; the hovered axis is likewise suppressed while a
 * cross-filter is active. Returns `{ item, axis }` (the axis is `[]` when suppressed).
 */
export function computeControlledHighlight<I extends { seriesId: string | number }, A>(
  hoveredItem: I | null,
  hoveredAxis: A[] | null,
  hasActiveXFilter: boolean,
  hasIncomingCrossFilters: boolean,
  highlightableSeriesIds: Set<string>,
): { item: I | null; axis: A[] } {
  const gated = !hasActiveXFilter && !hasIncomingCrossFilters;
  return {
    item:
      gated && hoveredItem && highlightableSeriesIds.has(hoveredItem.seriesId as string)
        ? hoveredItem
        : null,
    axis: gated ? (hoveredAxis ?? []) : [],
  };
}

/**
 * Shared legend `slotProps` for the multi-series bar/line charts — a scrollable, non-wrapping
 * legend capped to the chart height. Previously copy-pasted at six call sites.
 */
export const CHART_LEGEND_SLOT_PROPS = {
  legend: {
    sx: {
      overflowY: 'auto',
      flexWrap: 'nowrap',
      maxHeight: '100%',
    },
  },
} as const;

/**
 * Builds the `onAxisClick` handler shared by the bar/line charts: forward the clicked axis value
 * to `onItemClick` (with the shift-key for multi-select). An optional `isBlockedLabel` predicate
 * suppresses the click for synthetic values that map to no real category (e.g. an "Other" bucket).
 */
export function makeAxisClickHandler(
  onItemClick: (label: string | number | Date, shiftKey: boolean) => void,
  isBlockedLabel?: (label: string | number | Date) => boolean,
): (
  event: { shiftKey?: boolean } | null,
  params: { axisValue?: string | number | Date } | null,
) => void {
  return (event, params) => {
    if (params?.axisValue === undefined) {
      return;
    }
    if (isBlockedLabel?.(params.axisValue)) {
      return;
    }
    onItemClick(params.axisValue, Boolean(event?.shiftKey));
  };
}

/**
 * Resolves a field definition by id, checking the widget's data source first and
 * then the expression (computed) fields. This is the single implementation of the
 * `dataSource?.fields.find(...) ?? expressionFields.find(...)` lookup that was
 * previously copy-pasted ~10× across `StudioChartWidget.tsx`. Both returned shapes
 * carry the `format`/`currencyCode`/`precision`/`label` props chart formatting reads.
 */
export function resolveFieldDef(
  fieldId: string | undefined,
  dataSource: StudioDataSource | undefined,
  expressionFields: StudioExpressionField[],
): StudioDataField | StudioExpressionField | undefined {
  if (!fieldId) {
    return undefined;
  }
  return (
    dataSource?.fields.find((field) => field.id === fieldId) ??
    expressionFields.find((field) => field.id === fieldId)
  );
}

export function alignFilteredToAllLabels(
  allLabels: (string | number | Date)[],
  filteredLabels: (string | number | Date)[],
  filteredValues: (number | null)[],
): (number | null)[] {
  const filteredByLabel = new Map(filteredLabels.map((l, i) => [String(l), filteredValues[i]]));
  return allLabels.map((l) => filteredByLabel.get(String(l)) ?? null);
}

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
/**
 * Wraps a base valueFormatter for line/area chart main series (which holds filtered values)
 * to show "filtered / baseline" when a cross-highlight ghost series is active.
 * @param {(number | null)[]} baselineValues - Array of baseline (all-data) values aligned to the x-axis.
 * @param {(arg: number | null) => string} baseFormatter - The chart series' original value formatter.
 */
export function makeCrossHighlightLineFormatter(
  baselineValues: (number | null)[],
  baseFormatter: (arg: number | null) => string,
): (value: number | null, context: { dataIndex: number }) => string {
  return (value, { dataIndex }) => {
    const baseline = baselineValues[dataIndex] ?? null;
    if (value == null) {
      return `${baseFormatter(baseline)} (filtered out)`;
    }
    if (value === baseline || baseline == null) {
      return baseFormatter(value);
    }
    return `${baseFormatter(value)} / ${baseFormatter(baseline)}`;
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

export interface MakeValueFormatterOptions {
  /**
   * Whether to use `Intl` compact notation (e.g. "40K") for large numbers.
   * Defaults to `true` to preserve the historical behavior of this function's
   * chart call sites (axis/tooltip labels favor compact notation).
   */
  compact?: boolean;
  /**
   * What to return when there is no explicit `format`/`precision` config:
   * - `'string'` (default): a formatter that falls back to `String(value)` — most
   *   chart call sites always need *a* formatter to pass to MUI Charts.
   * - `'undefined'`: return `undefined` so the caller can omit `valueFormatter`
   *   entirely and let MUI Charts apply its own default number formatting.
   */
  noFormatFallback?: 'string' | 'undefined';
}

/**
 * Builds a `valueFormatter` for a chart series/axis from a field's number-format
 * config. This is the single shared implementation — do not re-declare a private
 * copy elsewhere (see `lineSeries.ts`, which previously had a byte-for-byte
 * divergent copy that returned `undefined` instead of falling back to `String`).
 *
 * Overloaded so the common 3-argument call (used throughout `StudioChartWidget.tsx`)
 * keeps its historical "always returns a formatter" type, while callers that
 * explicitly opt into `noFormatFallback: 'undefined'` (e.g. `lineSeries.ts`) get an
 * accurately optional return type.
 */
export function makeValueFormatter(
  format?: StudioNumberFormat,
  currencyCode?: string,
  precision?: number,
): (value: number | null) => string;
export function makeValueFormatter(
  format: StudioNumberFormat | undefined,
  currencyCode: string | undefined,
  precision: number | undefined,
  options: MakeValueFormatterOptions & { noFormatFallback: 'undefined' },
): ((value: number | null) => string) | undefined;
export function makeValueFormatter(
  format: StudioNumberFormat | undefined,
  currencyCode: string | undefined,
  precision: number | undefined,
  options: MakeValueFormatterOptions & { noFormatFallback?: 'string' },
): (value: number | null) => string;
export function makeValueFormatter(
  format?: StudioNumberFormat,
  currencyCode?: string,
  precision?: number,
  options?: MakeValueFormatterOptions,
): ((value: number | null) => string) | undefined {
  const compact = options?.compact ?? true;

  if (!format && precision == null) {
    if (options?.noFormatFallback === 'undefined') {
      return undefined;
    }
    return (value: number | null) => (value === null ? '' : String(value));
  }

  return (value: number | null) => {
    if (value === null) {
      return '';
    }
    return formatNumber(value, format, currencyCode, compact, precision);
  };
}

export function normalizeCrossFilterValue(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value == null) {
    return null;
  }

  return String(value);
}

/**
 * Consistent cross-filter value-equality check, used to decide whether clicking
 * a chart/grid/map data point should toggle (clear) the currently-applied
 * cross-filter or apply a new one.
 *
 * Normalizes both sides via `normalizeCrossFilterValue` before comparing so that
 * number/string/date/null/undefined values compare correctly regardless of
 * runtime type — unlike loose `==` (where `'' == 0` and `null == undefined` are
 * both `true`) or `String(a) === String(b)` (where `String('') !== String(0)`).
 */
export function crossFilterValueEquals(a: unknown, b: unknown): boolean {
  return normalizeCrossFilterValue(a) === normalizeCrossFilterValue(b);
}
