import type { CurveType } from '@mui/x-charts/models';
import type { CompiledSeries, CompiledUnit, PlotKind, UnitContext } from '../compile/context';
import { resolveColor } from '../compile/color';
import { toDate, toNumber } from '../compile/fieldTypes';
import type { DatasetRow, VegaFieldDef } from '../types';
import { isFieldDef } from '../types';

/*
 * OWNERSHIP: the "line & area marks" work unit owns this file.
 *
 * Translates `line`, `area`, and `trail` marks to x-charts `type: 'line'`
 * series. See the module-level comment history (git blame) for the full
 * design brief; the short version:
 * - `area` → `area: true` + plots `['area', 'line']`; `line` → `['line']`;
 *   `trail` → treated as `line` + a `partial` gap (stroke-width-by-field is
 *   unsupported).
 * - series `data` is index-aligned to `ctx.x.categories` (band/point/temporal
 *   axes all resolve discrete in this wrapper); missing cells are `null`.
 * - color-field splitting into one series per group via `resolveColor`;
 *   static color via `staticColor`/`mark.color`/`mark.stroke`.
 * - `mark.interpolate` → series `curve`, exact mapping where one exists,
 *   closest `CurveType` + `partial` gap otherwise.
 * - `mark.point` → `showMark` + the shell's `MarkPlot`; point styling
 *   objects are `ignored`.
 * - stacking on the y field def's `stack`; area + color split defaults to
 *   `'zero'` per Vega-Lite; lines default to unstacked.
 * - `strokeDash`/opacity/`strokeWidth` have no x-charts line-series
 *   equivalent → `ignored` gaps.
 * - `connectNulls` is always `false` (Vega-Lite's default invalid-value
 *   behavior breaks the line at gaps); `impute` is reported `unsupported`.
 */

const CURVE_MAP: Partial<Record<string, CurveType>> = {
  linear: 'linear',
  monotone: 'monotoneX',
  natural: 'natural',
  step: 'step',
  'step-before': 'stepBefore',
  'step-after': 'stepAfter',
};

/** Curve families with no exact x-charts equivalent — approximated. */
const APPROXIMATE_CURVE_MAP: Partial<Record<string, CurveType>> = {
  basis: 'catmullRom',
  bundle: 'catmullRom',
  cardinal: 'catmullRom',
  'catmull-rom': 'catmullRom',
};

function resolveCurve(interpolate: string | undefined, ctx: UnitContext, path: string): CurveType {
  const value = interpolate ?? 'linear';
  const exact = CURVE_MAP[value];
  if (exact) {
    return exact;
  }
  const approximate = APPROXIMATE_CURVE_MAP[value];
  if (approximate) {
    ctx.gaps.add({
      code: 'mark:interpolate-approximate',
      message: `Vega-Lite interpolate "${value}" has no exact x-charts curve equivalent; approximated with the closest available curve ("${approximate}").`,
      severity: 'partial',
      path,
    });
    return approximate;
  }
  ctx.gaps.add({
    code: 'mark:interpolate-unsupported',
    message: `Vega-Lite interpolate "${value}" is not recognized by this wrapper; falling back to a straight-line curve.`,
    severity: 'partial',
    path,
  });
  return 'linear';
}

interface StackConfig {
  stack?: string;
  stackOffset?: 'none' | 'expand' | 'silhouette';
}

/** Maps a Vega-Lite `stack` field-def value to x-charts stack props, sharing `stackId` across the layer's series. */
function resolveStack(stackSetting: unknown, stackId: string): StackConfig {
  if (stackSetting === 'zero' || stackSetting === true) {
    return { stack: stackId, stackOffset: 'none' };
  }
  if (stackSetting === 'normalize') {
    return { stack: stackId, stackOffset: 'expand' };
  }
  if (stackSetting === 'center') {
    return { stack: stackId, stackOffset: 'silhouette' };
  }
  // `null`/`false`/anything else opts out of stacking.
  return {};
}

/** The stack setting to use for the y field def, honoring Vega-Lite's default of stacking areas that split by color. */
function computeStackSetting(
  yDef: VegaFieldDef | undefined,
  markType: string,
  hasColorSplit: boolean,
): unknown {
  if (yDef?.stack !== undefined) {
    return yDef.stack;
  }
  if (markType === 'area' && hasColorSplit) {
    return 'zero';
  }
  return undefined;
}

/** Formats a color-group value for a series legend label, using a locale date string for temporal groups. */
function formatGroupLabel(value: unknown): string {
  if (value instanceof Date) {
    return value.toLocaleDateString();
  }
  return String(value);
}

export function compileLineAreaMark(ctx: UnitContext): CompiledUnit {
  const { unit, rows, encoding, x, gaps } = ctx;
  const path = unit.path;
  const mark = unit.mark;
  const markType = mark.type as 'line' | 'area' | 'trail';

  const yDef = isFieldDef(encoding.y) ? (encoding.y as VegaFieldDef) : undefined;
  const yField = yDef?.field;
  const xField = x?.field;

  if (!x || !x.categories || !x.categoryKeys) {
    gaps.add({
      code: 'mark:line-continuous-x',
      message:
        'Line/area marks need a discrete (nominal/ordinal/temporal) x axis in this wrapper — a continuous quantitative x axis has no index-aligned category domain to plot the series against. The layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  if (!yField || !xField) {
    gaps.add({
      code: 'mark:line-missing-field',
      message:
        'Line/area marks require both `x` and `y` to be field encodings; the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const categories = x.categories;

  // Point overlays.
  const markPoint = mark.point;
  const showMark = Boolean(markPoint);
  if (markPoint && typeof markPoint === 'object') {
    gaps.add({
      code: 'mark:point-styling',
      message:
        'Custom `mark.point` styling (size/shape/fill of overlay points) is not supported; overlay points render with the series default marker instead.',
      severity: 'ignored',
      path: `${path}.mark.point`,
    });
  }
  if (markPoint === 'transparent') {
    gaps.add({
      code: 'mark:point-transparent',
      message:
        '`mark.point: "transparent"` marks invisible interaction-only points in Vega-Lite; x-charts has no invisible-marker mode, so this wrapper renders regular visible markers instead.',
      severity: 'partial',
      path: `${path}.mark.point`,
    });
  }

  const curve = resolveCurve(
    typeof mark.interpolate === 'string' ? mark.interpolate : undefined,
    ctx,
    `${path}.mark.interpolate`,
  );

  if (markType === 'trail') {
    gaps.add({
      code: 'mark:trail-width',
      message:
        'The `trail` mark varies stroke width by a data field; x-charts line series render with a uniform stroke width, so the width variation is dropped (rendered as a plain line).',
      severity: 'partial',
      path,
    });
  }

  if (mark.strokeDash !== undefined) {
    gaps.add({
      code: 'mark:strokeDash',
      message:
        'Dashed strokes (`mark.strokeDash`) are not configurable on x-charts line series; the line renders solid.',
      severity: 'ignored',
      path: `${path}.mark.strokeDash`,
    });
  }
  if (mark.strokeWidth !== undefined) {
    gaps.add({
      code: 'mark:strokeWidth',
      message:
        'Custom stroke width (`mark.strokeWidth`) has no x-charts line-series equivalent and is ignored.',
      severity: 'ignored',
      path: `${path}.mark.strokeWidth`,
    });
  }
  if (
    mark.opacity !== undefined ||
    mark.fillOpacity !== undefined ||
    mark.strokeOpacity !== undefined
  ) {
    gaps.add({
      code: 'mark:opacity',
      message:
        'Opacity (`mark.opacity`/`fillOpacity`/`strokeOpacity`) is not configurable per line/area series on x-charts and is ignored.',
      severity: 'ignored',
      path: `${path}.mark.opacity`,
    });
  }
  if (encoding.opacity !== undefined) {
    gaps.add({
      code: 'encoding:opacity',
      message:
        'The `opacity` encoding channel has no x-charts line/area series equivalent and is ignored.',
      severity: 'ignored',
      path: `${path}.encoding.opacity`,
    });
  }

  const xImpute = isFieldDef(encoding.x) ? (encoding.x as VegaFieldDef).impute : undefined;
  if (yDef?.impute !== undefined || xImpute !== undefined) {
    gaps.add({
      code: 'encoding:impute',
      message:
        'Value imputation (`impute`) for missing data points is not implemented; missing cells remain gaps in the line/area instead of being filled or interpolated.',
      severity: 'unsupported',
      path: `${path}.encoding.y.impute`,
    });
  }

  const plots = new Set<PlotKind>();
  if (markType === 'area') {
    plots.add('area');
    plots.add('line');
  } else {
    plots.add('line');
  }
  if (showMark) {
    plots.add('marks');
  }

  const colorRes = resolveColor(encoding, rows, gaps, path);
  const splitField = colorRes.splitField;
  const stackId = `${path}:stack`;
  const stackMode = resolveStack(computeStackSetting(yDef, markType, Boolean(splitField)), stackId);

  // One implicit, unfiltered group when there's no color split; otherwise one
  // group per distinct color-field value — explicit `domain` order first
  // (paired with the matching `range` color), then first-appearance order for
  // any values outside the domain.
  const SINGLE_GROUP_KEY = '__single__';
  const groups: Array<{ key: string; label?: string; color?: string }> = [];
  if (splitField) {
    const seenGroups = new Set<string>();
    const addGroup = (value: unknown, color?: string) => {
      const key = ctx.categoryKey(value);
      if (seenGroups.has(key)) {
        return;
      }
      seenGroups.add(key);
      groups.push({
        key,
        label: colorRes.hasLegend ? formatGroupLabel(value) : undefined,
        color,
      });
    };
    colorRes.domain?.forEach((value, index) => addGroup(value, colorRes.range?.[index]));
    for (const row of rows) {
      const value = row[splitField];
      if (value != null) {
        addGroup(value);
      }
    }
  } else {
    const staticColor =
      colorRes.staticColor ??
      (markType === 'area'
        ? (mark.fill ?? mark.color ?? mark.stroke)
        : (mark.stroke ?? mark.color ?? mark.fill));
    groups.push({
      key: SINGLE_GROUP_KEY,
      color: typeof staticColor === 'string' ? staticColor : undefined,
    });
  }

  // Bucket rows by group in a single pass over `rows` (rather than rescanning
  // all rows once per group), then build each series from its own bucket.
  const rowsByGroup = new Map<string, DatasetRow[]>();
  for (const row of rows) {
    const key = splitField ? ctx.categoryKey(row[splitField]) : SINGLE_GROUP_KEY;
    const bucket = rowsByGroup.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByGroup.set(key, [row]);
    }
  }

  const series: CompiledSeries[] = groups.map((group) => {
    const data: Array<number | null> = new Array(categories.length).fill(null);
    for (const row of rowsByGroup.get(group.key) ?? []) {
      // Temporal axis categories are Date objects (see scales.ts), so the raw
      // row value (often an ISO string) must be coerced before the lookup —
      // same as point.ts's resolveAxisValue.
      const rawX = x.fieldType === 'temporal' ? toDate(row[xField]) : row[xField];
      const idx = ctx.categoryIndex(x, rawX);
      if (idx === -1) {
        continue;
      }
      data[idx] = toNumber(row[yField]);
    }
    return {
      type: 'line',
      id: `${path}:${group.key}`,
      label: group.label,
      data,
      area: markType === 'area',
      curve,
      showMark,
      connectNulls: false,
      color: group.color,
      ...stackMode,
    } as CompiledSeries;
  });

  return { series, plots: Array.from(plots) };
}
