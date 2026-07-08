import type { BarSeriesType, StackOffsetType } from '@mui/x-charts/models';
import type { AxisResolution, CompiledUnit, UnitContext } from '../compile/context';
import { resolveColor } from '../compile/color';
import { toNumber } from '../compile/fieldTypes';
import type { DatasetRow, VegaChannelDef } from '../types';
import { isFieldDef } from '../types';

/*
 * OWNERSHIP: the "bar mark" work unit owns this file.
 *
 * Translates the `bar` mark to x-charts `type: 'bar'` series. See the module
 * doc comments below for the supported grammar subset; anything outside it
 * degrades to a `TranslationGap` instead of throwing.
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

/** Builds a category-aligned data array for one group of rows, summing duplicates. */
function buildSeriesData(
  ctx: UnitContext,
  rows: readonly DatasetRow[],
  categoryAxis: AxisResolution,
  valueField: string,
): Array<number | null> {
  const data: Array<number | null> = new Array(categoryAxis.categories?.length ?? 0).fill(null);
  const categoryField = categoryAxis.field;
  if (!categoryField) {
    return data;
  }
  for (const row of rows) {
    const index = ctx.categoryIndex(categoryAxis, row[categoryField]);
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

interface RowGroup {
  value: unknown;
  rows: DatasetRow[];
}

/** Groups rows by `splitField`, ordered by `domain` when provided, else first appearance. */
function groupRowsByField(
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

  (['x2', 'y2'] as const).forEach((channel) => {
    if (encoding[channel]) {
      gaps.add({
        code: 'mark:bar-ranged',
        message:
          'Ranged bars (x2/y2, spanning between two values instead of from a baseline) have no equivalent bar series in x-charts; the range span is dropped. The rangeBar chart in @mui/x-charts-premium covers this.',
        severity: 'unsupported',
        path: `${unit.path}.encoding.${channel}`,
      });
    }
  });

  if (mark.cornerRadius !== undefined) {
    gaps.add({
      code: 'mark:bar-corner-radius',
      message:
        'mark.cornerRadius is per-mark in Vega-Lite, but x-charts only exposes bar corner rounding as a chart-wide `borderRadius` prop on `<BarPlot>` (not per series). Not applied by this wrapper.',
      severity: 'ignored',
      path: `${unit.path}.mark.cornerRadius`,
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

  const color = resolveColor(encoding, rows, gaps, unit.path);
  const staticColor = color.staticColor ?? mark.color ?? mark.fill;

  const series: BarSeriesType[] = [];

  if (!color.splitField) {
    const data = buildSeriesData(ctx, rows, categoryAxis, valueField);
    series.push(
      omitUndefined({
        type: 'bar',
        data,
        layout: horizontal ? ('horizontal' as const) : undefined,
        color: staticColor,
      }),
    );
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

    let stackId: string | undefined;
    let stackOffset: StackOffsetType | undefined;
    if (!grouped && !explicitlyUnstacked) {
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
    }

    const groups = groupRowsByField(ctx, rows, color.splitField, color.domain);
    groups.forEach((group, groupIndex) => {
      const data = buildSeriesData(ctx, group.rows, categoryAxis, valueField);
      series.push(
        omitUndefined({
          type: 'bar',
          id: `${unit.path}:${color.splitField}:${ctx.categoryKey(group.value)}`,
          label: String(group.value),
          data,
          layout: horizontal ? ('horizontal' as const) : undefined,
          stack: stackId,
          stackOffset,
          color: color.range?.[groupIndex] ?? staticColor,
        }),
      );
    });
  }

  return {
    series,
    plots: ['bar'],
  };
}
