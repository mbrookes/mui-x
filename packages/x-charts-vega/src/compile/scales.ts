import type { XAxis, YAxis } from '@mui/x-charts/models';
import type { DatasetRow, VegaChannelDef, VegaFieldDef } from '../types';
import { isFieldDef } from '../types';
import type { GapCollector } from '../gaps';
import type { NormalizedUnit } from '../normalize';
import type { AxisResolution } from './context';
import { categoryKey } from './context';
import { resolveFieldType, toDate } from './fieldTypes';

/*
 * Positional-scale resolution: turns the x/y channel definitions of all
 * layers into shared x-charts axis configs (`XAxis`/`YAxis` objects) plus the
 * ordered category domain for band/point scales.
 *
 * OWNERSHIP: the "scales & axes" work unit owns this file — deepen it with
 * explicit scale.type/domain/range handling, sort orders, `resolve.scale`
 * independence (second axis), axis titles/format, log/pow/sqrt/symlog, and
 * grid flags. The baseline implementation below covers: band/point vs
 * linear vs time selection, category collection in data order, axis id
 * assignment, and axis titles from field names.
 */

export interface ResolvedAxes {
  x?: AxisResolution<XAxis>;
  y?: AxisResolution<YAxis>;
  grid: { vertical?: boolean; horizontal?: boolean };
}

interface ChannelOccurrence {
  unit: NormalizedUnit;
  rows: readonly DatasetRow[];
  def: VegaChannelDef;
}

function fieldOf(def: VegaChannelDef | undefined): string | undefined {
  return def && isFieldDef(def) ? def.field : undefined;
}

function axisTitle(def: VegaChannelDef | undefined): string | undefined {
  if (!def || !isFieldDef(def)) {
    return undefined;
  }
  if (def.title === null) {
    return undefined;
  }
  if (def.title) {
    return def.title;
  }
  const fieldDef = def as VegaFieldDef;
  const parts: string[] = [];
  if (typeof fieldDef.aggregate === 'string') {
    parts.push(fieldDef.aggregate.toUpperCase());
  }
  if (fieldDef.field) {
    parts.push(fieldDef.field);
  } else if (fieldDef.aggregate === 'count') {
    parts.push('Count of Records');
  }
  return parts.length > 0 ? parts.join(' of ') : undefined;
}

function resolveChannelAxis(
  channel: 'x' | 'y',
  occurrences: ChannelOccurrence[],
  hasBarMark: boolean,
  gaps: GapCollector,
): AxisResolution | undefined {
  const first = occurrences[0];
  if (!first) {
    return undefined;
  }
  const def = first.def;
  const fieldType = resolveFieldType(def, first.rows);
  const field = fieldOf(def);
  const id = `vega-${channel}`;
  const title = axisTitle(def);

  if (fieldType === 'nominal' || fieldType === 'ordinal') {
    const categories: Array<string | number | Date> = [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
      const occurrenceField = fieldOf(occurrence.def);
      if (!occurrenceField) {
        continue;
      }
      for (const row of occurrence.rows) {
        const value = row[occurrenceField];
        if (value == null) {
          continue;
        }
        const key = categoryKey(value);
        if (!seen.has(key)) {
          seen.add(key);
          categories.push(value as string | number | Date);
          keys.push(key);
        }
      }
    }
    return {
      config: {
        id,
        scaleType: hasBarMark ? 'band' : 'point',
        data: categories,
        label: title,
      },
      fieldType,
      categories,
      categoryKeys: keys,
      channel: def,
      field,
    };
  }

  if (fieldType === 'temporal') {
    const categories: Array<string | number | Date> = [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
      const occurrenceField = fieldOf(occurrence.def);
      if (!occurrenceField) {
        continue;
      }
      for (const row of occurrence.rows) {
        const value = toDate(row[occurrenceField]);
        if (value == null) {
          continue;
        }
        const key = categoryKey(value);
        if (!seen.has(key)) {
          seen.add(key);
          categories.push(value);
          keys.push(key);
        }
      }
    }
    categories.sort((a, b) => (a as Date).getTime() - (b as Date).getTime());
    const sortedKeys = categories.map(categoryKey);
    // Temporal axes use a point scale over the sorted date domain: the mark
    // compilers' index-alignment contract needs a discrete domain. The
    // scales work unit may upgrade quantitative-dense cases to `scaleType:
    // 'time'` with per-series (x, y) data instead.
    return {
      config: {
        id,
        scaleType: 'point',
        data: categories,
        label: title,
        valueFormatter: (value: Date) => value.toLocaleDateString(),
      },
      fieldType,
      categories,
      categoryKeys: sortedKeys,
      channel: def,
      field,
    };
  }

  if (fieldType === 'geojson') {
    gaps.add({
      code: 'type:geojson',
      message:
        'geojson field types require geographic projections (Premium Map chart territory). Not supported by this wrapper.',
      severity: 'unsupported',
      path: `${first.unit.path}.encoding.${channel}`,
    });
    return undefined;
  }

  // Quantitative continuous axis.
  const scale = isFieldDef(def) ? def.scale : undefined;
  let scaleType: 'linear' | 'log' | 'pow' | 'sqrt' | 'symlog' = 'linear';
  if (scale?.type === 'log') {
    scaleType = 'log';
  } else if (scale?.type === 'pow') {
    scaleType = 'pow';
  } else if (scale?.type === 'sqrt') {
    scaleType = 'sqrt';
  } else if (scale?.type === 'symlog') {
    scaleType = 'symlog';
  } else if (scale?.type && scale.type !== 'linear') {
    gaps.add({
      code: `scale:${scale.type}`,
      message: `Scale type "${scale.type}" on a positional channel is not translated; falling back to linear.`,
      severity: 'partial',
      path: `${first.unit.path}.encoding.${channel}.scale.type`,
    });
  }
  const domain = Array.isArray(scale?.domain) ? scale?.domain : undefined;
  return {
    config: {
      id,
      scaleType,
      label: title,
      min: typeof domain?.[0] === 'number' ? domain[0] : undefined,
      max: typeof domain?.[1] === 'number' ? domain[1] : undefined,
      reverse: scale?.reverse === true || undefined,
    },
    fieldType,
    channel: def,
    field,
  };
}

export function resolveAxes(
  units: Array<{ unit: NormalizedUnit; rows: readonly DatasetRow[] }>,
  gaps: GapCollector,
): ResolvedAxes {
  const xOccurrences: ChannelOccurrence[] = [];
  const yOccurrences: ChannelOccurrence[] = [];
  let hasBarMark = false;
  const grid: ResolvedAxes['grid'] = {};

  for (const { unit, rows } of units) {
    if (unit.mark.type === 'bar' || unit.mark.type === 'rect') {
      hasBarMark = true;
    }
    if (unit.encoding.x) {
      xOccurrences.push({ unit, rows, def: unit.encoding.x });
      if (isFieldDef(unit.encoding.x) && unit.encoding.x.axis?.grid) {
        grid.vertical = true;
      }
    }
    if (unit.encoding.y) {
      yOccurrences.push({ unit, rows, def: unit.encoding.y });
      if (isFieldDef(unit.encoding.y) && unit.encoding.y.axis?.grid) {
        grid.horizontal = true;
      }
    }
  }

  return {
    x: resolveChannelAxis('x', xOccurrences, hasBarMark, gaps) as AxisResolution<XAxis> | undefined,
    y: resolveChannelAxis('y', yOccurrences, false, gaps) as AxisResolution<YAxis> | undefined,
    grid,
  };
}
