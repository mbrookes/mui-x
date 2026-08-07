import {
  fillTemporalLabelGaps,
  formatTemporalAxisLabel,
  getTemporalAxisData,
  sortLabels,
  formatNumber,
  formatPercent,
} from '@mui/x-studio-core/engine';
import type {
  StudioLocaleText,
  AggregatedData,
  MultiSeriesData,
  MultiYSeriesData,
} from '@mui/x-studio-core/engine';
import type { StudioBarLayout } from '@mui/x-studio-core/models';
import type {
  StudioChartConfig,
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioNumberFormat,
} from '../../../models';

/**
 * Applies alpha to an arbitrary CSS color without parsing it, using `color-mix()`
 * (already an established pattern in this repo — see `GridChartsPanelChart.tsx`).
 *
 * The previous approach string-concatenated a hex alpha byte directly onto the color
 * (`` `${color}40` ``), which only produces a valid paint string when `color` happens to
 * be a bare hex literal — it silently produces garbage (and a dropped/opaque fill) for
 * `rgb()`/`hsl()` values or CSS variables, which hosts can legitimately supply via
 * `chartColors`/theme defaults. `color-mix` works uniformly regardless of the input
 * color's format (`StudioPieChart.tsx` fixed the equivalent pie-arc bug
 * via `fill-opacity`; line/area series colors are consumed as a raw SVG `fill` string
 * with no per-series slot to hook `fill-opacity` onto, so `color-mix` is the equivalent
 * fix for this call site shape).
 *
 * @param color - Any valid CSS color (hex, `rgb()`, `hsl()`, a CSS variable, …).
 * @param percent - Opacity as 0-100 (e.g. `25` for 25% opacity).
 */
export function withAlpha(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/**
 * Whether a bar chart stacks its series. Shared by the multi-Y and split-by bar
 * render paths (previously an identical inline expression at both). A `bar` layout
 * stacks only when `barLayout === 'stacked'`; the dedicated stacked/100% types always do.
 */
export function isBarStacked(
  chartType: 'bar' | 'bar-stacked' | 'bar-100',
  barLayout: StudioBarLayout,
): boolean {
  return (
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    (chartType === 'bar' && barLayout === 'stacked')
  );
}

/**
 * Whether a line/area chart stacks its series (`area-stacked` / `area-100`). Shared by
 * the split-by and multi-Y line/area render paths and `lineSeries.ts`.
 */
export function isAreaStacked(chartType: string | undefined): boolean {
  return chartType === 'area-stacked' || chartType === 'area-100';
}

/**
 * Per-x-position totals for 100%-stacked normalization: sums every series' value at each
 * label index (null → 0). One shared implementation for the multi-Y and split-by bar/line
 * renderers, previously hand-rolled at four call sites.
 */
export function computeStackTotals(columns: (number | null)[][], labelCount: number): number[] {
  const totals: number[] = new Array(labelCount).fill(0);
  for (const column of columns) {
    for (let i = 0; i < labelCount; i += 1) {
      totals[i] += column[i] ?? 0;
    }
  }
  return totals;
}

/**
 * Series/tooltip value formatter for 100%-stacked charts: one-decimal percent, null → `'0%'`.
 * Shared by every bar/line 100%-stacked series.
 *
 * Routed through `formatPercent` (`internals/numberFormat.ts`) so the decimal separator, the
 * grouping separator and the `%` sign's placement come from `Intl` and therefore match every
 * other number the same widget renders — a hand-built `` `${v.toFixed(1)}%` `` hardcodes `.` as
 * the separator, so a French dashboard showed `42.5%` in a tooltip row directly above a
 * `42,5 €` produced by `Intl`.
 *
 * INVARIANT: `value` is ALREADY scaled to 0–100 (the callers divide by the per-label stack
 * total and multiply by 100). `formatPercent` re-divides by 100 itself, so this value must
 * never additionally pass through `formatNumber(value, 'percent')`, which would scale twice.
 */
export function formatPercentValue(value: number | null): string {
  // `null` (no data in this bucket) keeps its whole-number `0%` rendering rather than `0.0%`.
  return value == null ? formatPercent(0, 0) : formatPercent(value, 1);
}

/**
 * Axis-tick value formatter for 100%-stacked charts: whole-number percent, localized through
 * the same `Intl` path as {@link formatPercentValue} so the axis and the tooltip agree.
 */
export function formatPercentAxis(value: number): string {
  return formatPercent(value, 0);
}

/**
 * Projects a series' values into the representation a STACKED bar/line series can render.
 *
 * An unstacked series passes through untouched, preserving the `AggregatedData` doctrine that
 * an empty bucket is `null` and not 0 (a synthetic 0 is indistinguishable from a genuine zero
 * measurement — see `internals/aggregators.ts`).
 *
 * A stacked series cannot keep that distinction. x-charts builds the stack with
 * `d3Stack().value((d, key) => d[key] ?? 0)`, so every layer above a `null` slot is already
 * positioned as if that slot were 0; meanwhile `connectNulls` (which every studio line/area
 * series sets) drops the null point out of the area path entirely, so the layer that owns the
 * null interpolates straight across a slot the layers above it treat as zero-height. The two
 * halves of the stack then disagree at that x position. Collapsing to 0 up front is the only
 * representation the stack renders self-consistently.
 *
 * INVARIANT: every stacked series — multi-Y and split-by, bar and line/area — is built from
 * this one helper, so the two paths cannot drift. They previously did: the split-by paths
 * zero-filled and the multi-Y paths passed `null` through, so a stacked multi-Y bar and a
 * stacked split-by bar over equivalent data stacked differently and read differently in the
 * tooltip.
 */
export function stackSafeValues(values: (number | null)[], isStacked: boolean): (number | null)[] {
  return isStacked ? values.map((value) => value ?? 0) : values;
}

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
 * @param {string} filteredOutLabel - REQUIRED localized suffix shown for a fully-filtered-out
 * value (`StudioLocaleText.chartCrossFilterFilteredOutLabel`). It used to default to the English
 * literal, which meant a call site that forgot it emitted `"1 234 (filtered out)"` inside an
 * otherwise fully localized tooltip — mixed-language output with nothing to flag it, and no compile
 * error to catch the next such call site .
 * @returns {(v: number | null, ctx: { dataIndex: number }) => string} A composite formatter showing "filtered / total" for cross-filtered data.
 */
export function makeCrossFilterValueFormatter(
  filteredValues: (number | null)[],
  baseFormatter: (arg: number | null) => string,
  filteredOutLabel: string,
): (value: number | null, context: { dataIndex: number }) => string {
  return (value, { dataIndex }) => {
    const fv = filteredValues[dataIndex];
    const base = baseFormatter(value);
    if (fv == null) {
      return `${base} (${filteredOutLabel})`;
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
 * @param {string} filteredOutLabel - REQUIRED localized suffix shown for a fully-filtered-out
 * value (`StudioLocaleText.chartCrossFilterFilteredOutLabel`). Required for the same mixed-language
 * reason as `makeCrossFilterValueFormatter` above.
 */
export function makeCrossHighlightLineFormatter(
  baselineValues: (number | null)[],
  baseFormatter: (arg: number | null) => string,
  filteredOutLabel: string,
): (value: number | null, context: { dataIndex: number }) => string {
  return (value, { dataIndex }) => {
    const baseline = baselineValues[dataIndex] ?? null;
    if (value == null) {
      return `${baseFormatter(baseline)} (${filteredOutLabel})`;
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

/**
 * Computes the permutation that reorders temporal x-axis labels into chronological
 * order — the same order `getTemporalAxisData` / `createLineXAxisConfig` plot the axis
 * dates in. Returns `null` when the labels are not temporal, or when they are already
 * chronological (so callers can keep their existing arrays unchanged).
 *
 * A temporal line/area x-axis is always rendered chronologically ascending. The series
 * values are aligned to the ORIGINAL label order (whatever `chartSortBy` /
 * `chartSortDirection` / rank produced), so without applying this permutation to the
 * series each value would plot against the wrong date.
 */
export function getTemporalSortOrder(labels: (string | number)[]): number[] | null {
  if (getTemporalAxisData(labels) == null) {
    return null;
  }
  const sorted = sortLabels(labels);
  const order = sorted.map((label) => labels.indexOf(label));
  // indexOf is safe because aggregation labels are unique period keys; O(n^2) on the
  // small chart label set. An identity order means the labels were already chronological.
  return order.every((value, index) => value === index) ? null : order;
}

function applyOrder<T>(array: readonly T[], order: number[]): T[] {
  return order.map((index) => array[index]);
}

/**
 * Reorders a single-series aggregation into chronological order for a temporal x-axis.
 * Returns the same reference when the labels are non-temporal or already chronological.
 */
export function sortAggregatedTemporally(data: AggregatedData): AggregatedData {
  const order = getTemporalSortOrder(data.labels);
  if (!order) {
    return data;
  }
  return {
    ...data,
    labels: applyOrder(data.labels, order),
    values: applyOrder(data.values, order),
  };
}

/** Reorders a split-by (series-field) aggregation into chronological order for a temporal x-axis. */
export function sortMultiSeriesTemporally(data: MultiSeriesData): MultiSeriesData {
  const order = getTemporalSortOrder(data.labels);
  if (!order) {
    return data;
  }
  return {
    ...data,
    labels: applyOrder(data.labels, order),
    seriesData: Object.fromEntries(
      data.seriesNames.map((name) => [name, applyOrder(data.seriesData[name], order)]),
    ),
  };
}

/** Reorders a multi-Y aggregation into chronological order for a temporal x-axis. */
export function sortMultiYTemporally(data: MultiYSeriesData): MultiYSeriesData {
  const order = getTemporalSortOrder(data.labels);
  if (!order) {
    return data;
  }
  return {
    ...data,
    labels: applyOrder(data.labels, order),
    series: data.series.map((series) => ({
      ...series,
      values: applyOrder(series.values, order),
    })),
  };
}

/**
 * Builds the x-axis config for a line/area chart.
 *
 * The labels decide the branch: period keys that `getTemporalAxisData` can parse
 * (`'2024'`, `'2024-Q1'`, `'2024-W03'`, `'2024-01'`, `'2024-01-15'`) produce a real `utc`
 * date scale whose ticks are formatted by `formatTemporalAxisLabel`; anything else falls back
 * to a categorical `point` scale formatted by `formatLabel`.
 *
 * INVARIANT: the two branches must localize identically. `formatLabel` already carries the
 * caller's locale text, so `localeText` MUST be threaded into the temporal branch as well —
 * without it `formatTemporalAxisLabel` silently defaults to `DEFAULT_STUDIO_LOCALE_TEXT` and a
 * French weekly line chart renders `Week 3 2024` on its x axis while the equivalent bar and
 * mixed charts (which never take the temporal branch) render the translated label. Only the
 * temporal branch reads `localeText`; the categorical branch never does.
 *
 * @param localeText - Locale text bundle forwarded to `formatTemporalAxisLabel`. Optional only
 *   so a non-localized caller still compiles; every in-repo call site passes it.
 */
export function createLineXAxisConfig(
  labels: (string | number)[],
  xGroupBy: StudioChartConfig['xGroupBy'],
  formatLabel: (label: string | number) => string,
  axisId?: string,
  localeText?: StudioLocaleText,
) {
  const temporalData = getTemporalAxisData(labels);
  if (temporalData) {
    return [
      {
        ...(axisId ? { id: axisId } : {}),
        data: temporalData,
        scaleType: 'utc' as const,
        height: 'auto' as const,
        valueFormatter: (value: Date | number) =>
          formatTemporalAxisLabel(value, xGroupBy, localeText),
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
   * - `'localized'` (default): a formatter that routes the value through
   *   {@link formatNumber} with no `format`, i.e. the same locale-aware `Intl`
   *   presentation the KPI / map / pivot widgets give the very same field. `format`
   *   is OPTIONAL on `StudioDataField` and real docs routinely omit it, so this is
   *   the common case, not an edge case.
   * - `'string'`: a formatter that falls back to `String(value)`. Locale-blind, and
   *   it leaks binary floating-point noise (`String(0.1 + 0.2)` is
   *   `'0.30000000000000004'`), so only pick it when a *raw* value is genuinely
   *   wanted — it is not appropriate for anything a user reads.
   * - `'undefined'`: return `undefined` so the caller can omit `valueFormatter`
   *   entirely and let MUI Charts apply its own default number formatting. Note that
   *   several of those defaults (e.g. `Gauge`'s `value.toLocaleString()`) take no
   *   locale argument at all and therefore ignore `<Studio locale>`; prefer
   *   `'localized'` for anything rendered as a value the user reads.
   */
  noFormatFallback?: 'localized' | 'string' | 'undefined';
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
 *
 * The unformatted-field fallback is locale-aware by default. It used to be
 * `String(value)`, which made no `Intl` call at all: for a `type: 'number'` field with
 * no `format` — the shape the repo's own fixtures use — a chart series/tooltip printed
 * `1234.5678` while the KPI card on the same measure printed `1234,6` under
 * `<Studio locale="de-DE">`. Routing the fallback through `formatNumber` gives every
 * widget family one presentation of one number.
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
  options: MakeValueFormatterOptions & { noFormatFallback?: 'localized' | 'string' },
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
    if (options?.noFormatFallback === 'string') {
      return (value: number | null) => (value === null ? '' : String(value));
    }
    return (value: number | null) =>
      value === null ? '' : formatNumber(value, undefined, undefined, compact);
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
    // `new Date('garbage')` is an Invalid Date whose `.toISOString()` throws a `RangeError`.
    // A single host-injected invalid Date cell reaches this per-row (e.g. from the grid's
    // `getRowClassName`), so return `null` (a sentinel that never equals a real filter value)
    // rather than throwing and crashing the whole card (finding).
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
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
