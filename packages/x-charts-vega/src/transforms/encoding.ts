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
  'x2',
  'y2',
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

/**
 * A resolved encoding-level argmin/argmax: within each group, the row whose
 * `criterion` field is extreme is selected, and this channel's `extract` field
 * is read off that row. Covers both the string form (`aggregate: 'argmax'`,
 * where `criterion === extract === field`) and the object form
 * (`aggregate: { argmax: 'b' }`, where `criterion` is `'b'` and `extract` is
 * this channel's own `field`).
 */
interface ArgmmSpec {
  op: 'argmin' | 'argmax';
  criterion: string;
  extract: string;
}

/**
 * Classifies a channel's `aggregate` as an argmin/argmax:
 * - `undefined` — not an argmin/argmax aggregate (a plain scalar op, or a
 *   non-argmm object); the caller handles it elsewhere.
 * - `null` — an argmin/argmax we cannot wire up (missing criterion or the
 *   channel's own `field`); the caller records a gap and drops the channel.
 * - `ArgmmSpec` — a resolved argmin/argmax.
 */
function resolveArgmm(def: VegaFieldDef): ArgmmSpec | null | undefined {
  const agg = def.aggregate;
  if (agg === 'argmin' || agg === 'argmax') {
    // String form: select on and read back this channel's own field.
    return def.field ? { op: agg, criterion: def.field, extract: def.field } : null;
  }
  if (agg && typeof agg === 'object' && (agg.argmax !== undefined || agg.argmin !== undefined)) {
    const op = agg.argmax !== undefined ? 'argmax' : 'argmin';
    const criterion = op === 'argmax' ? agg.argmax : agg.argmin;
    // Object form: `criterion` selects the row; this channel's field is read
    // off it. Both are required to produce a channel value.
    return criterion && def.field ? { op, criterion, extract: def.field } : null;
  }
  return undefined;
}

function syntheticName(def: VegaFieldDef, argmm?: ArgmmSpec): string {
  if (argmm) {
    return `__${argmm.op}_${argmm.criterion}_${argmm.extract}`;
  }
  const op = typeof def.aggregate === 'string' ? def.aggregate : 'agg';
  return `__${op}_${def.field ?? 'records'}`;
}

/**
 * Resolves the bin-end companion for `bin: "binned"` (pre-binned data) from the
 * positional channel's `x2`/`y2`, when it carries an explicit field. Returns the
 * companion `channel` (so the caller can drop it once consumed) and its `field`.
 * Returns `undefined` for channels with no companion (e.g. `color`) or when the
 * companion has no field — applyInlineBin then falls back to `"${field}_end"`.
 */
function resolveBinnedEndChannel(
  encoding: VegaEncoding,
  channel: string,
): { channel: 'x2' | 'y2'; field: string } | undefined {
  let endChannel: 'x2' | 'y2' | undefined;
  if (channel === 'x') {
    endChannel = 'x2';
  } else if (channel === 'y') {
    endChannel = 'y2';
  }
  if (!endChannel) {
    return undefined;
  }
  const endDef = encoding[endChannel];
  if (endDef && !Array.isArray(endDef) && isFieldDef(endDef) && endDef.field) {
    return { channel: endChannel, field: endDef.field };
  }
  return undefined;
}

export function applyEncodingTransforms(
  rows: readonly DatasetRow[],
  encoding: VegaEncoding,
  gaps: GapCollector,
  path: string,
  // Accepted for signature parity with `applyTransforms`; no calculate/filter
  // expressions run here, so signals are not consumed (yet). Prefixed with `_`
  // per the unused-arg lint rule — a worker wiring expressions here renames it.
  _signals?: Readonly<Record<string, unknown>>,
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
      // For pre-binned data (`bin: "binned"`), the bin end comes from the
      // channel's `x2`/`y2` companion when present; otherwise applyInlineBin
      // falls back to the `"${field}_end"` convention.
      const binnedEndChannel =
        def.bin === 'binned' ? resolveBinnedEndChannel(workingEncoding, channel) : undefined;
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
        binnedEndChannel?.field,
      );
      if (binResult) {
        workingRows = binResult.rows;
        // The single ordinal "start–end" band now encodes the whole bin, so the
        // x2/y2 companion that supplied the bin end is redundant — drop it, or a
        // downstream bar mark would read x/x2 as a ranged bar instead of routing
        // through the band-scale histogram path.
        if (binnedEndChannel) {
          delete workingEncoding[binnedEndChannel.channel];
        }
        // Binned channels render as an ordinal "start–end" label field, so
        // histograms go through the existing band-scale path in scales.ts
        // (one bar per bin) instead of the continuous quantitative path.
        workingEncoding[channel] = {
          ...def,
          field: binResult.field,
          type: 'ordinal',
          bin: undefined,
          // Vega-Lite suffixes a binned field's axis/legend title with
          // "(binned)"; keep an explicit title if the spec set one.
          title: def.title ?? (def.field ? `${def.field} (binned)` : undefined),
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

  const aggregateChannels: Array<{
    channel: string;
    def: VegaFieldDef;
    as: string;
    argmm?: ArgmmSpec;
  }> = [];
  for (const channel of AGGREGATABLE_CHANNELS) {
    const def = workingEncoding[channel];
    if (!(def && !Array.isArray(def) && isFieldDef(def) && def.aggregate !== undefined)) {
      continue;
    }
    const fieldDef = def as VegaFieldDef;
    const argmm = resolveArgmm(fieldDef);
    if (argmm === null || (argmm === undefined && typeof fieldDef.aggregate !== 'string')) {
      // Either an argmin/argmax we can't wire up (missing criterion/field) or a
      // non-argmm object aggregate we don't understand — drop the channel.
      gaps.add({
        code: 'aggregate:argminmax',
        message:
          'The argmin/argmax aggregate needs both a criterion field to select on and ' +
          `this channel's \`field\` to read back; the "${channel}" channel was dropped.`,
        severity: 'unsupported',
        path: `${path}.encoding.${channel}.aggregate`,
      });
      continue;
    }
    // `null` was handled above (channel dropped), so `argmm` is now
    // `ArgmmSpec | undefined`.
    aggregateChannels.push({
      channel,
      def: fieldDef,
      as: syntheticName(fieldDef, argmm),
      argmm,
    });
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
    for (const { channel, def, as, argmm } of aggregateChannels) {
      if (argmm) {
        // argmin/argmax: pick the row that extremizes `criterion` within the
        // group (evaluateAggregate returns that whole row when given
        // `group.rows`), then read this channel's `extract` field off it. A
        // group with no numeric criterion value yields `null`.
        const winner = evaluateAggregate(
          argmm.op,
          group.rows.map((row) => row[argmm.criterion]),
          group.rows,
        );
        outRow[as] =
          winner != null && typeof winner === 'object' ? (winner[argmm.extract] ?? null) : null;
        continue;
      }
      const values =
        def.field == null ? group.rows : group.rows.map((row) => row[def.field as string]);
      const result = evaluateAggregate(def.aggregate as never, values, group.rows);
      // Only scalar ops reach here (argmin/argmax are handled above). A missing
      // (`undefined`) or unexpectedly non-numeric result means the op has no
      // scalar implementation, so the channel value is nulled and gapped.
      if (result === undefined || (result !== null && typeof result !== 'number')) {
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
  for (const { channel, def, as, argmm } of aggregateChannels) {
    // The rewrite strips the `aggregate` marker and renames `field` to the
    // synthetic column, so scales.ts's aggregate-aware title derivation can
    // never fire downstream — derive the "MEAN of v"-style title here instead
    // (matching axisTitle's format) unless the spec set one explicitly. For
    // argmin/argmax the displayed value is this channel's `extract` field read
    // off the winning row, so title it with that field name.
    let derivedTitle: string;
    if (argmm) {
      derivedTitle = argmm.extract;
    } else {
      const op = String(def.aggregate).toUpperCase();
      derivedTitle = def.field ? `${op} of ${def.field}` : 'Count of Records';
    }
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
