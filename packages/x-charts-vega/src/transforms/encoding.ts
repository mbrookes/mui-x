import type { DatasetRow, VegaEncoding, VegaFieldDef } from '../types';
import { isFieldDef } from '../types';
import type { GapCollector } from '../gaps';
import { evaluateAggregate } from './aggregateOps';
import { applyInlineBin } from './bin';
import { applyInlineTimeUnit } from './timeUnit';

/*
 * Encoding-level (inline) transforms: `aggregate`, `bin`, and `timeUnit`
 * declared directly on channel field defs.
 *
 * OWNERSHIP: the "transforms" work unit owns this file. Inline `bin` and
 * `timeUnit` on x/y/color are wired through bin.ts/timeUnit.ts *before* the
 * aggregate/group-by pass below, rewriting the channel to a synthetic field
 * — the same "synthetic column" contract the aggregate path already used —
 * so grouping-by-bin (e.g. `x: {bin: true, field: 'x'}, y: {aggregate:
 * 'count'}`, a histogram) falls out of the existing grouping logic for free.
 */

export interface EncodingTransformResult {
  rows: readonly DatasetRow[];
  /**
   * Encoding rewritten so aggregate/bin/timeUnit channels point at the
   * synthetic columns produced here (and drop their inline transform
   * markers).
   */
  encoding: VegaEncoding;
}

const AGGREGATABLE_CHANNELS = ['x', 'y', 'theta', 'radius', 'size', 'color'] as const;
const GROUPING_CHANNELS = [
  'x',
  'y',
  'color',
  'fill',
  'stroke',
  'detail',
  'xOffset',
  'yOffset',
  'shape',
  'theta',
] as const;
const INLINE_TRANSFORM_CHANNELS = ['x', 'y', 'color'] as const;

function syntheticName(def: VegaFieldDef): string {
  const op = typeof def.aggregate === 'string' ? def.aggregate : 'agg';
  return `__${op}_${def.field ?? 'records'}`;
}

export function applyEncodingTransforms(
  rows: readonly DatasetRow[],
  encoding: VegaEncoding,
  gaps: GapCollector,
  path: string,
): EncodingTransformResult {
  let workingRows = rows;
  const workingEncoding: VegaEncoding = { ...encoding };

  // Bin/timeUnit channels become plain fields (synthetic columns) before
  // anything below looks at `aggregate`/grouping, so those steps never need
  // to know about inline bin/timeUnit at all.
  for (const channel of INLINE_TRANSFORM_CHANNELS) {
    const def = workingEncoding[channel];
    if (!def || Array.isArray(def) || !isFieldDef(def)) {
      continue;
    }
    if ((def.bin || def.timeUnit) && !def.field) {
      gaps.add({
        code: `encoding:${def.bin ? 'bin' : 'timeUnit'}-no-field`,
        message: `Inline \`${def.bin ? 'bin' : 'timeUnit'}\` on the "${channel}" channel has no \`field\` to transform; it was ignored.`,
        severity: 'ignored',
        path: `${path}.encoding.${channel}`,
      });
      continue;
    }
    if (!def.field) {
      continue;
    }
    if (def.bin) {
      const binResult = applyInlineBin(
        workingRows,
        def.field,
        def.bin,
        gaps,
        `${path}.encoding.${channel}.bin`,
        // Only positional channels re-sort rows into ascending-bin order (to
        // drive the axis category order); a binned color channel must keep
        // the positional row order intact.
        channel !== 'color',
      );
      if (binResult) {
        workingRows = binResult.rows;
        // Binned channels render as an ordinal "start–end" label field, so
        // histograms go through the existing band-scale path in scales.ts
        // (one bar per bin) instead of the continuous quantitative path.
        workingEncoding[channel] = {
          ...def,
          field: binResult.field,
          type: 'ordinal',
          bin: undefined,
          title: def.title ?? def.field,
        };
      } else {
        // Binning failed (gap already recorded): strip the bin marker so
        // downstream type inference sees the raw field for what it is
        // instead of assuming a binned-quantitative channel.
        workingEncoding[channel] = { ...def, bin: undefined };
      }
    } else if (def.timeUnit) {
      const timeUnitResult = applyInlineTimeUnit(
        workingRows,
        def.field,
        def.timeUnit,
        gaps,
        `${path}.encoding.${channel}.timeUnit`,
      );
      if (timeUnitResult) {
        workingRows = timeUnitResult.rows;
        workingEncoding[channel] = {
          ...def,
          field: timeUnitResult.field,
          type: 'temporal',
          timeUnit: undefined,
          title: def.title ?? def.field,
        };
      } else {
        // Unsupported unit (gap already recorded): fall back to the raw
        // date field, stripping the marker like the bin failure path.
        workingEncoding[channel] = { ...def, timeUnit: undefined };
      }
    }
  }

  const aggregateChannels: Array<{ channel: string; def: VegaFieldDef; as: string }> = [];
  for (const channel of AGGREGATABLE_CHANNELS) {
    const def = workingEncoding[channel];
    if (def && !Array.isArray(def) && isFieldDef(def) && def.aggregate !== undefined) {
      if (typeof def.aggregate !== 'string') {
        gaps.add({
          code: 'aggregate:argminmax',
          message: 'argmin/argmax aggregates are not implemented; the channel was dropped.',
          severity: 'unsupported',
          path: `${path}.encoding.${channel}.aggregate`,
        });
        continue;
      }
      aggregateChannels.push({
        channel,
        def: def as VegaFieldDef,
        as: syntheticName(def as VegaFieldDef),
      });
    }
  }

  if (aggregateChannels.length === 0) {
    return { rows: workingRows, encoding: workingEncoding };
  }

  const groupFields: string[] = [];
  for (const channel of GROUPING_CHANNELS) {
    const def = workingEncoding[channel];
    const defs = Array.isArray(def) ? def : [def];
    for (const channelDef of defs) {
      if (
        isFieldDef(channelDef) &&
        channelDef.field &&
        channelDef.aggregate === undefined &&
        !groupFields.includes(channelDef.field)
      ) {
        groupFields.push(channelDef.field);
      }
    }
  }

  const groups = new Map<string, { key: DatasetRow; rows: DatasetRow[] }>();
  for (const row of workingRows) {
    const key = groupFields.map((field) => {
      const value = row[field];
      return value instanceof Date ? `d:${value.getTime()}` : `${typeof value}:${String(value)}`;
    });
    const groupKey = key.join(' ');
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: Object.fromEntries(groupFields.map((field) => [field, row[field]])),
        rows: [],
      };
      groups.set(groupKey, group);
    }
    group.rows.push(row);
  }

  const outRows: DatasetRow[] = [];
  for (const group of groups.values()) {
    const outRow: DatasetRow = { ...group.key };
    for (const { channel, def, as } of aggregateChannels) {
      const values =
        def.field == null ? group.rows : group.rows.map((row) => row[def.field as string]);
      const result = evaluateAggregate(def.aggregate as never, values);
      if (result === undefined) {
        gaps.add({
          code: `aggregate:${String(def.aggregate)}`,
          message: `Aggregate op "${String(def.aggregate)}" is not implemented; the channel value is null.`,
          severity: 'unsupported',
          path: `${path}.encoding.${channel}.aggregate`,
        });
        outRow[as] = null;
      } else {
        outRow[as] = result;
      }
    }
    outRows.push(outRow);
  }

  const nextEncoding: VegaEncoding = { ...workingEncoding };
  for (const { channel, def, as } of aggregateChannels) {
    // The rewrite strips the `aggregate` marker and renames `field` to the
    // synthetic column, so scales.ts's aggregate-aware title derivation can
    // never fire downstream — derive the "MEAN of v"-style title here instead
    // (matching axisTitle's format) unless the spec set one explicitly.
    const op = String(def.aggregate).toUpperCase();
    const derivedTitle = def.field ? `${op} of ${def.field}` : 'Count of Records';
    nextEncoding[channel] = {
      ...def,
      field: as,
      aggregate: undefined,
      type: def.type ?? 'quantitative',
      title: def.title ?? derivedTitle,
    };
  }

  return { rows: outRows, encoding: nextEncoding };
}
