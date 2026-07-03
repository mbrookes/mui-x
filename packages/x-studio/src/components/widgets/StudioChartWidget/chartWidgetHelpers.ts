import {
  fillTemporalLabelGaps,
  formatTemporalAxisLabel,
  getTemporalAxisData,
} from '../../../internals/chartUtils';
import { formatNumber } from '../../../internals/numberFormat';
import type {
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioNumberFormat,
  StudioWidget,
} from '../../../models';

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
