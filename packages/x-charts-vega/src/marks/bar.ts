import type { BarSeriesType, StackOffsetType } from '@mui/x-charts/models';
// `rangeBar` is an @mui/x-charts-premium series type (renders a watermark
// without a license key, exactly like the rest of this wrapper's Premium
// marks — see `packages/x-charts-premium/src/models/seriesType/rangeBar.ts`).
import type { RangeBarSeriesType } from '@mui/x-charts-premium/models';
import type { AxisResolution, CompiledUnit, UnitContext } from '../compile/context';
import { resolveColor } from '../compile/color';
import { toDate, toNumber } from '../compile/fieldTypes';
import type { DatasetRow, VegaChannelDef } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';

/*
 * OWNERSHIP: the "bar mark" work unit owns this file.
 *
 * Translates the `bar` mark to x-charts `type: 'bar'` series, and — when the
 * primary positional value channel (y for vertical bars, x for horizontal
 * bars) is paired with its `2` twin (y2/x2) — to `type: 'rangeBar'` series
 * (`@mui/x-charts-premium`) instead. See the module doc comments below for
 * the supported grammar subset; anything outside it degrades to a
 * `TranslationGap` instead of throwing.
 */

function fieldOf(def: VegaChannelDef | undefined): string | undefined {
  return def && isFieldDef(def) ? def.field : undefined;
}

/**
 * Drops keys whose value is `undefined`. x-charts' internal series
 * defaultizers apply defaults via `{ layout: 'vertical', ...series[id] }`
 * (see `BarChart/seriesConfig/bar/seriesProcessor.ts`): an explicit
 * `layout: undefined` key would win over that spread and produce a series
 * with no layout at all, so optional props must be omitted rather than set
 * to `undefined`.
 */
function omitUndefined<T extends object>(obj: T): T {
  const result = {} as T;
  (Object.keys(obj) as Array<keyof T>).forEach((key) => {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  });
  return result;
}

/** Whether this unit renders horizontal bars: quantitative x + categorical y. */
function resolveOrientation(ctx: UnitContext): 'horizontal' | 'vertical' {
  const orient = ctx.unit.mark.orient;
  if (orient === 'horizontal' || orient === 'vertical') {
    return orient;
  }
  if (!ctx.x?.categories && ctx.y?.categories) {
    return 'horizontal';
  }
  return 'vertical';
}

/**
 * Temporal axis categories are Date objects (see scales.ts), so raw row
 * values (often ISO strings) must be coerced before the category lookup —
 * same as point.ts/lineArea.ts/rect.ts.
 */
function toCategoryValue(axis: AxisResolution, raw: unknown): unknown {
  return axis.fieldType === 'temporal' ? toDate(raw) : raw;
}

/** Builds a category-aligned data array for one group of rows, summing duplicates. */
function buildSeriesData(
  ctx: UnitContext,
  rows: readonly DatasetRow[],
  categoryAxis: AxisResolution,
  valueField: string,
): Array<number | null> {
  const data: Array<number | null> = new Array(categoryAxis.categories?.length ?? 0).fill(null);
  const categoryField = categoryAxis.field;
  if (!categoryField && !categoryAxis.synthetic) {
    return data;
  }
  for (const row of rows) {
    // A synthetic axis (aggregate-only bars) has a single implicit category —
    // every row lands at index 0.
    const index = categoryField
      ? ctx.categoryIndex(categoryAxis, toCategoryValue(categoryAxis, row[categoryField]))
      : 0;
    if (index < 0) {
      continue;
    }
    const value = toNumber(row[valueField]);
    if (value === null) {
      continue;
    }
    data[index] = data[index] === null ? value : (data[index] as number) + value;
  }
  return data;
}

/** The twin (`x2`/`y2`) endpoint of a ranged bar: either a data field or a constant (datum def). */
interface RangeTwin {
  field?: string;
  constant?: number;
}

/**
 * Builds a category-aligned `[start, end]` data array for one group of rows.
 * Sibling of `buildSeriesData` for `rangeBar` series: `startField` is the
 * primary value channel's field, `twin` is the resolved `2`-channel endpoint.
 * Unlike regular bars, duplicate rows landing on the same category are not
 * summed (a range has no meaningful sum) — the last row wins. A cell is left
 * `null` when either endpoint cannot be resolved to a number.
 */
function buildRangedSeriesData(
  ctx: UnitContext,
  rows: readonly DatasetRow[],
  categoryAxis: AxisResolution,
  startField: string,
  twin: RangeTwin,
): Array<[number, number] | null> {
  const data: Array<[number, number] | null> = new Array(categoryAxis.categories?.length ?? 0).fill(
    null,
  );
  const categoryField = categoryAxis.field;
  if (!categoryField && !categoryAxis.synthetic) {
    return data;
  }
  for (const row of rows) {
    // Synthetic axis (aggregate-only bars): single implicit category, index 0.
    const index = categoryField
      ? ctx.categoryIndex(categoryAxis, toCategoryValue(categoryAxis, row[categoryField]))
      : 0;
    if (index < 0) {
      continue;
    }
    const start = toNumber(row[startField]);
    const end = twin.field !== undefined ? toNumber(row[twin.field]) : (twin.constant ?? null);
    if (start === null || end === null) {
      continue;
    }
    data[index] = [start, end];
  }
  return data;
}

export interface RowGroup {
  value: unknown;
  rows: DatasetRow[];
}

/** Groups rows by `splitField`, ordered by `domain` when provided, else first appearance. */
export function groupRowsByField(
  ctx: UnitContext,
  rows: readonly DatasetRow[],
  splitField: string,
  domain: unknown[] | undefined,
): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const value = row[splitField];
    if (value == null) {
      continue;
    }
    const key = ctx.categoryKey(value);
    let group = groups.get(key);
    if (!group) {
      group = { value, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  if (!domain || domain.length === 0) {
    return Array.from(groups.values());
  }
  const ordered: RowGroup[] = [];
  const consumed = new Set<string>();
  for (const domainValue of domain) {
    const key = ctx.categoryKey(domainValue);
    const group = groups.get(key);
    if (group) {
      ordered.push(group);
      consumed.add(key);
    }
  }
  for (const [key, group] of groups) {
    if (!consumed.has(key)) {
      ordered.push(group);
    }
  }
  return ordered;
}

export function compileBarMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const mark = unit.mark;

  let barBorderRadius: number | undefined;
  if (typeof mark.cornerRadius === 'number' && mark.cornerRadius > 0) {
    barBorderRadius = mark.cornerRadius;
    gaps.add({
      code: 'mark:bar-corner-radius',
      message:
        'mark.cornerRadius is per-mark in Vega-Lite; x-charts applies it chart-wide via ' +
        '<BarPlot borderRadius>, rounding value-end corners of every bar series.',
      severity: 'partial',
      path: `${unit.path}.mark.cornerRadius`,
    });
  } else if (mark.cornerRadius !== undefined) {
    // Defined but not a usable positive number (0, negative, or a Vega
    // signal-expression object) — nothing to apply, but still worth
    // recording so the discrepancy from the source spec isn't silent.
    gaps.add({
      code: 'mark:bar-corner-radius',
      message:
        "mark.cornerRadius must be a positive number to map onto x-charts' chart-wide " +
        `<BarPlot borderRadius>; the given value (${JSON.stringify(mark.cornerRadius)}) was not applied.`,
      severity: 'ignored',
      path: `${unit.path}.mark.cornerRadius`,
    });
  }

  // Per-corner radii (cornerRadiusTopLeft/TopRight/BottomLeft/BottomRight,
  // and the `mark.cornerRadiusEnd` alias) have no x-charts equivalent — only
  // a single uniform chart-wide radius is supported (see above).
  const perCornerKeys = [
    'cornerRadiusTopLeft',
    'cornerRadiusTopRight',
    'cornerRadiusBottomLeft',
    'cornerRadiusBottomRight',
    'cornerRadiusEnd',
  ] as const;
  const styledPerCorner = perCornerKeys.find(
    (key) => (mark as Record<string, unknown>)[key] !== undefined,
  );
  if (styledPerCorner) {
    gaps.add({
      code: 'mark:bar-corner-radius-per-corner',
      message: `\`${styledPerCorner}\` sets a per-corner radius, but x-charts only exposes a single uniform chart-wide bar corner radius; the per-corner configuration was ignored.`,
      severity: 'ignored',
      path: `${unit.path}.mark.${styledPerCorner}`,
    });
  }

  if (mark.size !== undefined || mark.binSpacing !== undefined) {
    gaps.add({
      code: 'mark:bar-size',
      message:
        'mark.size / mark.binSpacing (explicit bar thickness/gap) have no x-charts equivalent — bar width is derived automatically from the band scale. Ignored.',
      severity: 'ignored',
      path: `${unit.path}.mark`,
    });
  }

  const orientation = resolveOrientation(ctx);
  const horizontal = orientation === 'horizontal';
  const categoryAxis = horizontal ? ctx.y : ctx.x;
  const valueAxis = horizontal ? ctx.x : ctx.y;
  const valueChannelDef = horizontal ? encoding.x : encoding.y;
  const valueField = horizontal ? ctx.x?.field : ctx.y?.field;
  // A usable value channel must resolve to a continuous (quantitative/
  // temporal) axis — if both positional channels ended up categorical (e.g.
  // two nominal fields), there is no numeric value to draw a bar length
  // from, so bail with a gap instead of silently emitting all-null bars.
  const valueAxisIsContinuous =
    valueAxis?.fieldType === 'quantitative' || valueAxis?.fieldType === 'temporal';

  if (!categoryAxis?.categories || !valueField || !valueAxisIsContinuous) {
    gaps.add({
      code: 'mark:bar-missing-axes',
      message:
        'The bar mark needs one categorical/temporal positional channel and one quantitative positional channel; this spec is missing one of them (or both resolved to categorical axes), so no bars were rendered.',
      severity: 'unsupported',
      path: unit.path,
    });
    return { series: [], plots: [] };
  }

  // Ranged-bar detection: pairing the primary value channel (y for vertical
  // bars, x for horizontal bars) with its `2` twin turns this into a
  // `rangeBar` series (@mui/x-charts-premium) instead of a plain `bar`.
  const primaryTwinChannel = horizontal ? 'x2' : 'y2';
  const secondaryTwinChannel = horizontal ? 'y2' : 'x2';
  const primaryTwinDef = encoding[primaryTwinChannel];
  const secondaryTwinDef = encoding[secondaryTwinChannel];

  let rangeTwin: RangeTwin | undefined;
  if (primaryTwinDef !== undefined && secondaryTwinDef !== undefined) {
    // Both x2 and y2 are present: a rangeBar series can only span one
    // dimension, so it's ambiguous which channel should provide the range.
    // Fall back to a regular (non-ranged) bar, same as before this channel
    // was supported at all.
    (['x2', 'y2'] as const).forEach((channel) => {
      gaps.add({
        code: 'mark:bar-ranged',
        message:
          'Both x2 and y2 are present on this bar mark; x-charts rangeBar series can only span one axis, so it is ambiguous which channel should provide the range. Rendered as a regular (non-ranged) bar instead.',
        severity: 'unsupported',
        path: `${unit.path}.encoding.${channel}`,
      });
    });
  } else if (isValueDef(primaryTwinDef)) {
    // A value def is a constant in *pixel* space (e.g. a fixed screen X/Y),
    // not data space, so there is no scale to invert it through into a
    // rangeBar data value — unlike a datum def, which is already data-space.
    gaps.add({
      code: 'mark:bar-ranged-value',
      message: `\`${primaryTwinChannel}\` is a value def (a constant pixel-space value) rather than a field or datum def; x-charts rangeBar data is data-space and a pixel-space value cannot be inverted back into it, so the range span is dropped.`,
      severity: 'partial',
      path: `${unit.path}.encoding.${primaryTwinChannel}`,
    });
  } else if (isDatumDef(primaryTwinDef)) {
    const constant = toNumber(primaryTwinDef.datum);
    if (constant !== null) {
      rangeTwin = { constant };
    } else {
      gaps.add({
        code: 'mark:bar-ranged-datum-invalid',
        message: `\`${primaryTwinChannel}\`'s datum def (${JSON.stringify(primaryTwinDef.datum)}) does not coerce to a finite number, so it cannot provide a rangeBar range endpoint; the range span is dropped.`,
        severity: 'unsupported',
        path: `${unit.path}.encoding.${primaryTwinChannel}`,
      });
    }
  } else if (isFieldDef(primaryTwinDef) && primaryTwinDef.field) {
    rangeTwin = { field: primaryTwinDef.field };
  } else if (secondaryTwinDef !== undefined) {
    // Only the "wrong" twin is present (e.g. a vertical bar — categorical x +
    // quantitative y — with a lone x2, instead of the y2 that would pair
    // with y). There's no positional channel for it to range against, so it
    // is dropped, same as an unsupported channel would have been before
    // rangeBar existed.
    gaps.add({
      code: 'mark:bar-ranged-mismatched-axis',
      message: `\`${secondaryTwinChannel}\` is present without a matching primary value channel on its axis (only \`${horizontal ? 'y' : 'x'}\`/\`${primaryTwinChannel}\` can form a rangeBar range for this bar's orientation); it has no x-charts equivalent and was dropped.`,
      severity: 'unsupported',
      path: `${unit.path}.encoding.${secondaryTwinChannel}`,
    });
  }

  const color = resolveColor(encoding, rows, gaps, unit.path);
  const staticColor = color.staticColor ?? mark.color ?? mark.fill;

  const series: Array<BarSeriesType | RangeBarSeriesType> = [];

  if (!color.splitField) {
    if (rangeTwin) {
      const data = buildRangedSeriesData(ctx, rows, categoryAxis, valueField, rangeTwin);
      series.push(
        omitUndefined({
          type: 'rangeBar',
          data,
          layout: horizontal ? ('horizontal' as const) : undefined,
          color: staticColor,
        }),
      );
    } else {
      const data = buildSeriesData(ctx, rows, categoryAxis, valueField);
      series.push(
        omitUndefined({
          type: 'bar',
          data,
          layout: horizontal ? ('horizontal' as const) : undefined,
          color: staticColor,
        }),
      );
    }
  } else {
    const offsetChannelDef = horizontal ? encoding.yOffset : encoding.xOffset;
    const offsetField = fieldOf(offsetChannelDef);
    const grouped = offsetChannelDef !== undefined;
    if (offsetChannelDef && offsetField && offsetField !== color.splitField) {
      gaps.add({
        code: 'encoding:bar-offset-mismatch',
        message: `The ${horizontal ? 'yOffset' : 'xOffset'} channel groups bars by "${offsetField}", a different field from the color channel ("${color.splitField}"). x-charts only groups bar series by the color field; approximated as grouped-by-color bars, ignoring the offset field.`,
        severity: 'partial',
        path: `${unit.path}.encoding.${horizontal ? 'yOffset' : 'xOffset'}`,
      });
    }

    const stackSetting = isFieldDef(valueChannelDef) ? valueChannelDef.stack : undefined;
    const explicitlyUnstacked = stackSetting === null || stackSetting === false;
    const wouldStack = !grouped && !explicitlyUnstacked;

    let stackId: string | undefined;
    let stackOffset: StackOffsetType | undefined;
    if (wouldStack && !rangeTwin) {
      // Scoped by unit path so two independent bar layers sharing the same
      // (globally-resolved) axis don't accidentally stack into each other.
      stackId = `vega-stack:${unit.path}`;
      if (stackSetting === 'normalize') {
        stackOffset = 'expand';
      } else if (stackSetting === 'center') {
        stackOffset = 'silhouette';
      } else {
        stackOffset = 'none';
      }
    } else if (wouldStack && rangeTwin) {
      // RangeBarSeriesType has no stack/stackOffset props — ranges have no
      // meaningful "stacked on top of" semantics — so a stack that would
      // have applied to a regular bar is simply dropped here.
      gaps.add({
        code: 'mark:bar-ranged-stack',
        message:
          'Stacking was requested for a color-split ranged bar (via the default Vega-Lite stack behavior or an explicit `stack`), but x-charts rangeBar series have no stacking concept; each range is drawn independently.',
        severity: 'ignored',
        path: `${unit.path}.encoding.${horizontal ? 'x' : 'y'}`,
      });
    }

    const groups = groupRowsByField(ctx, rows, color.splitField, color.domain);
    groups.forEach((group, groupIndex) => {
      const id = `${unit.path}:${color.splitField}:${ctx.categoryKey(group.value)}`;
      const label = String(group.value);
      const groupColor = color.range?.[groupIndex] ?? staticColor;
      if (rangeTwin) {
        const data = buildRangedSeriesData(ctx, group.rows, categoryAxis, valueField, rangeTwin);
        series.push(
          omitUndefined({
            type: 'rangeBar',
            id,
            label,
            data,
            layout: horizontal ? ('horizontal' as const) : undefined,
            color: groupColor,
          }),
        );
      } else {
        const data = buildSeriesData(ctx, group.rows, categoryAxis, valueField);
        series.push(
          omitUndefined({
            type: 'bar',
            id,
            label,
            data,
            layout: horizontal ? ('horizontal' as const) : undefined,
            stack: stackId,
            stackOffset,
            color: groupColor,
          }),
        );
      }
    });
  }

  return {
    series,
    plots: [rangeTwin ? 'rangeBar' : 'bar'],
    ...(barBorderRadius !== undefined ? { barBorderRadius } : {}),
  };
}
