import type { DatasetRow, VegaBinParams, VegaBinTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toNumber } from '../compile/fieldTypes';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — d3-style "nice"
 * binning (maxbins/step/extent), shared by the top-level `bin` transform
 * (`applyBinTransform`) and inline `bin` on encoding channels
 * (`applyInlineBin`, wired in from encoding.ts).
 */

export interface NiceBinning {
  start: number;
  step: number;
  stop: number;
  /**
   * The explicit `extent` from the spec, when one was provided (normalized
   * to ascending order). Values outside it are EXCLUDED from binning (null
   * bin), matching Vega-Lite — unlike the derived data extent, which always
   * covers every value.
   */
  extent?: [number, number];
}

const DEFAULT_MAXBINS = 10;

/** Rounds `rawStep` up to the nearest "nice" step: 1, 2, or 5 times a power of ten. */
function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const residual = rawStep / magnitude;
  let niceResidual: number;
  if (residual <= 1) {
    niceResidual = 1;
  } else if (residual <= 2) {
    niceResidual = 2;
  } else if (residual <= 5) {
    niceResidual = 5;
  } else {
    niceResidual = 10;
  }
  return niceResidual * magnitude;
}

/** Cleans up floating point noise (e.g. `0.1 + 0.2`) without discarding real precision. */
function roundClean(value: number): number {
  if (value === 0) {
    return 0;
  }
  return Number(value.toPrecision(12));
}

/**
 * Computes a "nice" bin domain (start/step/stop) over `values`, honoring
 * `maxbins` (default 10), an explicit `step`, and an explicit `extent`
 * override — the same rounding rules used by d3/Vega's own binning.
 * A reversed explicit extent is normalized to ascending order. Returns
 * `null` when no domain can be derived (no numeric values and no explicit
 * `extent`).
 */
export function computeNiceBinning(
  values: readonly number[],
  params: VegaBinParams | boolean | undefined,
): NiceBinning | null {
  const p: VegaBinParams = typeof params === 'object' && params ? params : {};
  let min: number;
  let max: number;
  let explicitExtent: [number, number] | undefined;
  if (Array.isArray(p.extent) && p.extent.length === 2) {
    [min, max] = p.extent as [number, number];
    if (min > max) {
      [min, max] = [max, min];
    }
    explicitExtent = [min, max];
  } else if (values.length > 0) {
    min = Math.min(...values);
    max = Math.max(...values);
  } else {
    return null;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }
  if (min === max) {
    const step = typeof p.step === 'number' && p.step > 0 ? p.step : 1;
    return {
      start: roundClean(min - step / 2),
      step,
      stop: roundClean(min + step / 2),
      ...(explicitExtent ? { extent: explicitExtent } : {}),
    };
  }
  let step: number;
  if (typeof p.step === 'number' && p.step > 0) {
    step = p.step;
  } else {
    const maxbins = typeof p.maxbins === 'number' && p.maxbins > 0 ? p.maxbins : DEFAULT_MAXBINS;
    step = niceStep((max - min) / maxbins);
  }
  const start = roundClean(Math.floor(min / step) * step);
  const stop = roundClean(Math.ceil(max / step) * step);
  return { start, step, stop, ...(explicitExtent ? { extent: explicitExtent } : {}) };
}

/**
 * Places `value` into a bin of `binning`. Values outside an EXPLICIT extent
 * are excluded (returns `null`, matching Vega-Lite); with a derived extent,
 * edge values are clamped into the first/last bin (only reachable at the
 * inclusive upper bound or through floating-point noise).
 */
export function binOf(
  value: number,
  binning: NiceBinning,
): { start: number; end: number; index: number } | null {
  if (binning.extent && (value < binning.extent[0] || value > binning.extent[1])) {
    return null;
  }
  const totalBins = Math.max(1, Math.round((binning.stop - binning.start) / binning.step));
  let index = Math.floor((value - binning.start) / binning.step);
  if (index >= totalBins) {
    index = totalBins - 1;
  } else if (index < 0) {
    index = 0;
  }
  const start = roundClean(binning.start + index * binning.step);
  const end = roundClean(start + binning.step);
  return { start, end, index };
}

function formatBinBound(value: number): string {
  return String(roundClean(value));
}

/** One toNumber pass per row, reused for both domain derivation and per-row binning. */
function extractNumbers(
  rows: readonly DatasetRow[],
  field: string,
): { perRow: Array<number | null>; values: number[] } {
  const perRow = rows.map((row) => toNumber(row[field]));
  return { perRow, values: perRow.filter((value): value is number => value != null) };
}

/*
 * Shared tail of the inline-bin paths: turn a per-row `{ sortKey, label }` into
 * the `"start–end"` synthetic label column. When `sortRows` is true (positional
 * x/y channels) rows are re-sorted by `sortKey` (bin start) so the resulting
 * category axis renders bins left-to-right in ascending order (the mark
 * compilers align series data to the axis's category order, so sorting here is
 * what makes that come out right); a binned COLOR channel must NOT re-sort, or
 * it would clobber the positional row order (zig-zag line marks).
 */
function foldBinLabels(
  rows: readonly DatasetRow[],
  syntheticField: string,
  sortRows: boolean,
  compute: (row: DatasetRow, index: number) => { sortKey: number; label: string | null },
): { rows: DatasetRow[]; field: string } {
  const withBins = rows.map((row, index) => ({ row, ...compute(row, index) }));
  if (sortRows) {
    withBins.sort((a, b) => a.sortKey - b.sortKey);
  }
  return {
    rows: withBins.map(({ row, label }) => ({ ...row, [syntheticField]: label })),
    field: syntheticField,
  };
}

/**
 * Handles `bin: "binned"` — the data is ALREADY binned. `field` holds each
 * row's bin start and a companion field holds the bin end: either the explicit
 * `endField` (resolved by the caller from the channel's `x2`/`y2`) or, when
 * absent, the Vega-Lite default `"${field}_end"`. The start/end pair is folded
 * into the same synthetic `"start–end"` ordinal label the normal inline-bin
 * path produces, so pre-binned histograms go through the band-scale path too.
 * Returns `null` (after recording a gap) when the bin-end field can't be found.
 */
function applyPreBinned(
  rows: readonly DatasetRow[],
  field: string,
  endField: string | undefined,
  gaps: GapCollector,
  path: string,
  sortRows: boolean,
): { rows: DatasetRow[]; field: string } | null {
  const resolvedEnd = endField ?? `${field}_end`;
  if (!rows.some((row) => resolvedEnd in row)) {
    gaps.add({
      code: 'encoding:bin-binned',
      message: `\`bin: "binned"\` needs a bin-end field ("${resolvedEnd}") next to the bin-start field "${field}", but none was found; the field is rendered unbinned.`,
      severity: 'partial',
      path,
    });
    return null;
  }
  return foldBinLabels(rows, `__bin_${field}`, sortRows, (row) => {
    const start = toNumber(row[field]);
    const end = toNumber(row[resolvedEnd]);
    if (start == null || end == null) {
      return { sortKey: Number.POSITIVE_INFINITY, label: null };
    }
    return { sortKey: start, label: `${formatBinBound(start)}–${formatBinBound(end)}` };
  });
}

/**
 * Bins `field` on `rows` for an inline encoding-channel `bin`: each row's
 * value is folded into a `"start–end"` label written to a synthetic column.
 * We deliberately render bins as an ordinal "start–end" string column (rather
 * than keeping a numeric `quantitative` field) so histograms go through the
 * existing band-scale path in scales.ts and render one bar per bin with a
 * readable label, instead of one bar per distinct raw value. See
 * `foldBinLabels` for the `sortRows` behavior.
 *
 * `bin: "binned"` (pre-binned data) is handled by `applyPreBinned`, reading the
 * bin end from `endField` (the channel's `x2`/`y2`) or `"${field}_end"`.
 *
 * Returns `null` (after recording a gap) when binning can't be computed at all
 * (no numeric values, or — for pre-binned data — no bin-end field); the caller
 * should then fall back to the original unbinned field.
 */
export function applyInlineBin(
  rows: readonly DatasetRow[],
  field: string,
  binParam: boolean | VegaBinParams | 'binned',
  gaps: GapCollector,
  path: string,
  sortRows: boolean,
  endField?: string,
): { rows: DatasetRow[]; field: string } | null {
  if (binParam === 'binned') {
    return applyPreBinned(rows, field, endField, gaps, path, sortRows);
  }
  const { perRow, values } = extractNumbers(rows, field);
  const binning = computeNiceBinning(values, binParam);
  if (!binning) {
    gaps.add({
      code: 'encoding:bin',
      message: `Field "${field}" has no numeric values to derive a bin domain from; values are rendered unbinned.`,
      severity: 'partial',
      path,
    });
    return null;
  }
  return foldBinLabels(rows, `__bin_${field}`, sortRows, (row, index) => {
    const value = perRow[index];
    const bin = value == null ? null : binOf(value, binning);
    if (bin == null) {
      return { sortKey: Number.POSITIVE_INFINITY, label: null };
    }
    return { sortKey: bin.start, label: `${formatBinBound(bin.start)}–${formatBinBound(bin.end)}` };
  });
}

/*
 * Top-level `bin` transform: writes the bin start to `as` (or `as[0]`) and
 * the bin end to `${as}_end` (or `as[1]`). Rows whose value is missing,
 * non-numeric, or outside an explicit `extent` get null bin bounds.
 */
export function applyBinTransform(
  rows: readonly DatasetRow[],
  transform: VegaBinTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const [asStart, asEnd] = Array.isArray(transform.as)
    ? transform.as
    : [transform.as, `${transform.as}_end`];
  const { perRow, values } = extractNumbers(rows, transform.field);
  const binning = computeNiceBinning(values, transform.bin);
  if (!binning) {
    gaps.add({
      code: 'transform:bin',
      message: `The \`bin\` transform on field "${transform.field}" has no numeric values to derive a bin domain from; rows pass through unbinned.`,
      severity: 'unsupported',
      path,
    });
    return rows;
  }
  return rows.map((row, index) => {
    const value = perRow[index];
    const bin = value == null ? null : binOf(value, binning);
    if (bin == null) {
      return { ...row, [asStart]: null, [asEnd]: null };
    }
    return { ...row, [asStart]: bin.start, [asEnd]: bin.end };
  });
}
