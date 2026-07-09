import type { XAxis, YAxis } from '@mui/x-charts/models';
import type { DatasetRow, VegaChannelDef, VegaFieldDef, VegaFieldType, VegaSort } from '../types';
import { isFieldDef } from '../types';
import type { GapCollector } from '../gaps';
import type { NormalizedSpec, NormalizedUnit } from '../normalize';
import type { AxisResolution } from './context';
import { categoryKey } from './context';
import { resolveFieldType, toDate } from './fieldTypes';
import { createValueFormatter } from '../format';

/*
 * Positional-scale resolution: turns the x/y channel definitions of all
 * layers into shared x-charts axis configs (`XAxis`/`YAxis` objects) plus the
 * ordered category domain for band/point scales.
 *
 * OWNERSHIP: the "scales & axes" work unit owns this file. It covers:
 *   - per-channel band-vs-point selection (bars/rects → band, else point),
 *     with an explicit `scale.type` of band/point/ordinal overriding inference;
 *   - discrete-axis `sort` (ascending/descending/array/null; field/op → gap);
 *   - quantitative `scale.domain` / `zero` / `nice` / `reverse` / log-family;
 *   - axis-config enrichment (`title`, `labelAngle`, `tickCount`, `values`,
 *     `grid`, `labels`, `format`, `orient`) from the field def's `axis`, with
 *     the `format` d3 pattern compiled to a `valueFormatter` (see ../format)
 *     when it can be translated, and reported as a gap otherwise;
 *   - temporal channels rendered as a *continuous* time/utc scale over the
 *     ordered Dates by default (native x-charts time-tick formatting), and as
 *     a discrete band/point scale over those Dates only when a per-category
 *     mark (bar/rect/boxplot/errorbar), an explicit discrete `scale.type`, or
 *     an unsupported `sort` forces it (that fallback records a `partial` gap);
 *   - `resolve.scale` independence + `x2`/`y2` reported as gaps (no multi-axis).
 *
 * The domain (`categories`) is collected in data order (unless `sort` reorders
 * it) so mark compilers can index-align their series `data` to `categories` —
 * this holds on the continuous-temporal path too, since x-charts still
 * positions line/area/scatter points by indexing into `xAxis.data` (the
 * ordered Date[]) even on a `scaleType: 'time'` axis.
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

/** Discrete-axis enrichment pulled from a field def's `axis` config. */
interface AxisExtras {
  tickNumber?: number;
  tickInterval?: unknown[];
  tickLabelStyle?: { angle?: number; display?: string };
  position?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  // Compiled from `axis.format` (d3-format / d3-time-format) — feeds ticks and tooltips.
  valueFormatter?: (value: unknown) => string;
}

function fieldOf(def: VegaChannelDef | undefined): string | undefined {
  return def && isFieldDef(def) ? def.field : undefined;
}

function scaleOf(def: VegaChannelDef | undefined) {
  return def && isFieldDef(def) ? def.scale : undefined;
}

function axisTitle(def: VegaChannelDef | undefined): string | undefined {
  if (!def || !isFieldDef(def)) {
    return undefined;
  }
  // `axis: null` removes the axis entirely — including its title.
  const axis = def.axis;
  if (axis === null) {
    return undefined;
  }
  // An explicit `axis.title` (including `null` to suppress it) wins over the
  // field def's own `title` and the derived name.
  if (axis && typeof axis === 'object' && 'title' in axis) {
    return axis.title == null ? undefined : axis.title;
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

function mapOrient(channel: 'x' | 'y', orient: string): AxisExtras['position'] | undefined {
  if (channel === 'x') {
    return orient === 'top' || orient === 'bottom' ? orient : undefined;
  }
  return orient === 'left' || orient === 'right' ? orient : undefined;
}

/**
 * Translates the field def's `axis` config into x-charts axis props. `title`
 * is handled separately by `axisTitle`; everything else is mapped here. A
 * `format` d3 pattern is compiled to a `valueFormatter` via `../format` when it
 * can be translated (quantitative/temporal, or any type with an explicit
 * `formatType`); patterns that cannot be translated are recorded as gaps.
 */
function buildAxisExtras(
  def: VegaChannelDef | undefined,
  channel: 'x' | 'y',
  fieldType: VegaFieldType,
  gaps: GapCollector,
  path: string,
): AxisExtras {
  const extras: AxisExtras = {};
  if (!def || !isFieldDef(def)) {
    return extras;
  }
  const axis = def.axis;
  if (axis === null) {
    // `axis: null` removes the axis entirely in Vega-Lite.
    extras.position = 'none';
    return extras;
  }
  if (!axis) {
    return extras;
  }
  if (typeof axis.tickCount === 'number') {
    extras.tickNumber = axis.tickCount;
  }
  if (Array.isArray(axis.values)) {
    extras.tickInterval = axis.values;
  }
  const tickLabelStyle: { angle?: number; display?: string } = {};
  if (typeof axis.labelAngle === 'number') {
    tickLabelStyle.angle = axis.labelAngle;
  }
  if (axis.labels === false) {
    tickLabelStyle.display = 'none';
  }
  if (Object.keys(tickLabelStyle).length > 0) {
    extras.tickLabelStyle = tickLabelStyle;
  }
  if (typeof axis.format === 'string') {
    const formatter = createValueFormatter(
      axis.format,
      fieldType,
      typeof axis.formatType === 'string' ? axis.formatType : undefined,
    );
    if (formatter) {
      extras.valueFormatter = formatter;
    } else {
      gaps.add({
        code: 'scale:axis-format',
        message:
          `Axis \`format\` string "${axis.format}" could not be translated to a value formatter ` +
          `(a d3-format / d3-time-format pattern needs a quantitative or temporal field, or an explicit \`formatType\`); ` +
          'x-charts applies its default number/date formatting instead. Pass a `valueFormatter` on the axis for custom output.',
        severity: 'partial',
        path: `${path}.encoding.${channel}.axis.format`,
      });
    }
  }
  if (typeof axis.orient === 'string') {
    const position = mapOrient(channel, axis.orient);
    if (position) {
      extras.position = position;
    }
  }
  return extras;
}

/** Assigns `position` onto a config without fighting the XAxis/YAxis union. */
function assignPosition(config: object, position: AxisExtras['position']): void {
  if (position) {
    (config as { position?: string }).position = position;
  }
}

/** Numeric-, date-, then lexicographic-aware comparison for sort orders. */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  return String(a).localeCompare(String(b));
}

interface CategoryPair {
  value: string | number | Date;
  key: string;
}

/**
 * Applies a discrete-axis `sort` to the collected category/key pairs. Data
 * order is preserved for `null`/`undefined`; field/op sort objects and bare
 * field references are recorded as `partial` gaps and fall back to data order.
 */
function applySort(
  pairs: CategoryPair[],
  sort: VegaSort | undefined,
  isTemporal: boolean,
  gaps: GapCollector,
  path: string,
): CategoryPair[] {
  if (sort == null) {
    return pairs;
  }
  if (sort === 'ascending' || sort === 'descending') {
    const sorted = pairs.slice().sort((a, b) => compareValues(a.value, b.value));
    return sort === 'descending' ? sorted.reverse() : sorted;
  }
  if (Array.isArray(sort)) {
    const rank = new Map<string, number>();
    sort.forEach((entry, index) => {
      const key = categoryKey(isTemporal ? (toDate(entry) ?? entry) : entry);
      if (!rank.has(key)) {
        rank.set(key, index);
      }
    });
    const inList: CategoryPair[] = [];
    const rest: CategoryPair[] = [];
    for (const pair of pairs) {
      if (rank.has(pair.key)) {
        inList.push(pair);
      } else {
        rest.push(pair);
      }
    }
    inList.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
    // Values absent from the explicit array keep their data order at the end,
    // matching Vega-Lite's handling of unlisted domain values.
    return [...inList, ...rest];
  }
  // Object ({field, op, order}) or bare field-name sorts reorder the domain by
  // another encoded field — x-charts axes have no equivalent hook.
  gaps.add({
    code: 'scale:sort-by-field',
    message:
      'Sorting a discrete axis by another field or aggregate is not supported; ' +
      'the domain keeps its data order. Pre-sort or pre-aggregate the rows to control the order.',
    severity: 'partial',
    path: `${path}.sort`,
  });
  return pairs;
}

/** `true` when any occurrence of the channel is drawn with a bar/rect mark. */
function channelHasBarMark(occurrences: ChannelOccurrence[]): boolean {
  return occurrences.some(
    (occurrence) => occurrence.unit.mark.type === 'bar' || occurrence.unit.mark.type === 'rect',
  );
}

/**
 * Marks that force a temporal channel onto a discrete band/point scale instead
 * of a continuous time scale: bar/rect derive their width from a band, and
 * boxplot/errorbar group their summary geometry per category. Generalizes the
 * plain bar/rect check — any of these on a temporal channel opts out of the
 * continuous-time path.
 */
const DISCRETE_TEMPORAL_MARKS = new Set(['bar', 'rect', 'boxplot', 'errorbar']);

/** `true` when any occurrence of the channel is drawn with a per-category (band-requiring) mark. */
function channelHasDiscreteTemporalMark(occurrences: ChannelOccurrence[]): boolean {
  return occurrences.some((occurrence) => DISCRETE_TEMPORAL_MARKS.has(occurrence.unit.mark.type));
}

/**
 * An explicit categorical `scale.type` (`band`/`point`/`ordinal`) on any
 * occurrence overrides band-vs-point inference. Vega's `ordinal` position
 * scale maps to x-charts' `band`.
 */
function explicitDiscreteScaleType(occurrences: ChannelOccurrence[]): 'band' | 'point' | undefined {
  for (const occurrence of occurrences) {
    const type = scaleOf(occurrence.def)?.type;
    if (type === 'band' || type === 'ordinal') {
      return 'band';
    }
    if (type === 'point') {
      return 'point';
    }
  }
  return undefined;
}

function resolveChannelAxis(
  channel: 'x' | 'y',
  occurrences: ChannelOccurrence[],
  gaps: GapCollector,
): AxisResolution | undefined {
  const first = occurrences[0];
  if (!first) {
    return undefined;
  }
  const def = first.def;
  const fieldType = resolveFieldType(def, first.rows);

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

  const field = fieldOf(def);
  const scale = scaleOf(def);
  const extras = buildAxisExtras(def, channel, fieldType, gaps, first.unit.path);
  // Axis props shared by the discrete and quantitative branches — assembled in
  // one place so new props cannot drift between the two.
  const commonConfig = {
    id: `vega-${channel}`,
    label: axisTitle(def),
    reverse: scale?.reverse === true || undefined,
    tickNumber: extras.tickNumber,
    tickInterval: extras.tickInterval,
    tickLabelStyle: extras.tickLabelStyle,
  };

  if (fieldType === 'nominal' || fieldType === 'ordinal' || fieldType === 'temporal') {
    const isTemporal = fieldType === 'temporal';
    const pairs: CategoryPair[] = [];
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
      const occurrenceField = fieldOf(occurrence.def);
      if (!occurrenceField) {
        continue;
      }
      for (const row of occurrence.rows) {
        const raw = row[occurrenceField];
        const value = isTemporal ? toDate(raw) : (raw as string | number | Date);
        if (value == null) {
          continue;
        }
        const key = categoryKey(value);
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ value, key });
        }
      }
    }

    const sort = isFieldDef(def) ? def.sort : undefined;

    // Vega-Lite's default temporal order is chronological, but only when no
    // `sort` is given: `sort: null` explicitly asks for data order, and the
    // other sort forms establish their own order in `applySort` below.
    if (isTemporal && sort === undefined) {
      pairs.sort((a, b) => (a.value as Date).getTime() - (b.value as Date).getTime());
    }

    const ordered = applySort(
      pairs,
      sort,
      isTemporal,
      gaps,
      `${first.unit.path}.encoding.${channel}`,
    );
    const categories = ordered.map((pair) => pair.value);
    const keys = ordered.map((pair) => pair.key);

    // `axis.values` are literal tick placements. On a continuous time scale
    // x-charts' `useTicks` treats a `tickInterval` array as literal tick
    // *values*, so ISO-string / number entries must be coerced to Dates; the
    // discrete path compares them against the Date category domain and needs
    // Dates too (fixing a latent ISO-string-vs-Date mismatch there).
    const temporalTickInterval = extras.tickInterval?.map((entry) => toDate(entry) ?? entry);

    if (isTemporal) {
      // A temporal channel maps to a *continuous* time/utc scale unless a
      // per-category mark (bar/rect/boxplot/errorbar), an explicit discrete
      // `scale.type`, or a non-chronological `sort` forces a band/point domain.
      const forcedDiscreteMark = channelHasDiscreteTemporalMark(occurrences);
      const explicitDiscrete = explicitDiscreteScaleType(occurrences);
      const chronologicalSort = sort === undefined || sort === 'ascending';
      if (!forcedDiscreteMark && explicitDiscrete === undefined && chronologicalSort) {
        // Continuous time scale. `categories`/`categoryKeys` stay populated so
        // the mark compilers' index-alignment contract is unchanged: x-charts
        // still positions line/area/scatter points via `xAxis.data[index]`
        // even on a `scaleType: 'time'` axis.
        const temporalDomain = Array.isArray(scale?.domain) ? scale?.domain : undefined;
        // Built through a generic so `scaleType` is a single literal at each
        // call site — a `'time' | 'utc'` union would not collapse to one member
        // of the discriminated `XAxis`/`YAxis` union once Date min/max pin it.
        const buildTimeConfig = <S extends 'time' | 'utc'>(scaleType: S) => {
          const timeConfig = {
            ...commonConfig,
            scaleType,
            data: categories /* Date[] */,
            tickInterval: temporalTickInterval,
            min: toDate(temporalDomain?.[0]) ?? undefined,
            max: toDate(temporalDomain?.[1]) ?? undefined,
            // Leave x-charts' native time-tick formatting in place; only
            // override it when the spec provides a translatable `axis.format`.
            ...(extras.valueFormatter ? { valueFormatter: extras.valueFormatter } : {}),
          };
          assignPosition(timeConfig, extras.position);
          return timeConfig;
        };
        const config = scale?.type === 'utc' ? buildTimeConfig('utc') : buildTimeConfig('time');
        return { config, fieldType, categories, categoryKeys: keys, channel: def, field };
      }
      // Discrete fallback — record why the continuous-time path was declined.
      let reason = 'a non-chronological `sort` (null / descending / array / by-field)';
      if (forcedDiscreteMark) {
        reason = 'a per-category mark (bar/rect/boxplot/errorbar)';
      } else if (explicitDiscrete !== undefined) {
        reason = `an explicit discrete \`scale.type\` ("${scale?.type}")`;
      }
      gaps.add({
        code: 'scale:temporal-point-approximation',
        message:
          `The temporal channel falls back to a discrete band/point scale over the ordered dates because of ${reason}, ` +
          'so tick spacing reflects data order rather than elapsed time. ' +
          'The category domain stays index-aligned with the series data.',
        severity: 'partial',
        path: `${first.unit.path}.encoding.${channel}`,
      });
    }

    // Discrete band/point domain: nominal/ordinal channels, or a temporal
    // channel forced discrete above. Bars need a band scale to derive width.
    const scaleType =
      explicitDiscreteScaleType(occurrences) ?? (channelHasBarMark(occurrences) ? 'band' : 'point');

    // A temporal discrete axis defaults to a locale date string (unless a
    // translatable `axis.format` overrides it); nominal/ordinal axes only carry
    // a formatter when `axis.format` produced one (e.g. via `formatType`).
    let discreteValueFormatter = extras.valueFormatter;
    if (isTemporal && discreteValueFormatter === undefined) {
      discreteValueFormatter = (value) => (value as Date).toLocaleDateString();
    }

    const config = {
      ...commonConfig,
      scaleType,
      data: categories,
      ...(isTemporal ? { tickInterval: temporalTickInterval } : {}),
      ...(discreteValueFormatter ? { valueFormatter: discreteValueFormatter } : {}),
    };
    assignPosition(config, extras.position);
    return {
      config,
      fieldType,
      categories,
      categoryKeys: keys,
      channel: def,
      field,
    };
  }

  // Quantitative continuous axis.
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
  // `scale.zero: false` leaves the min free — the x-charts default already lets
  // the domain float, so nothing is forced here (for bar-anchored axes x-charts
  // keeps the zero baseline, which matches `zero`'s default of `true`).
  // `scale.nice: false` maps to a strict domain; the default is nice rounding.
  const domainLimit = scale?.nice === false ? ('strict' as const) : undefined;
  const config = {
    ...commonConfig,
    scaleType,
    min: typeof domain?.[0] === 'number' ? domain[0] : undefined,
    max: typeof domain?.[1] === 'number' ? domain[1] : undefined,
    domainLimit,
    // A translatable `axis.format` d3 pattern (see ../format) feeds both ticks
    // and tooltips; left undefined when the axis has no format.
    valueFormatter: extras.valueFormatter,
  };
  assignPosition(config, extras.position);
  return {
    config,
    fieldType,
    channel: def,
    field,
  };
}

export function resolveAxes(
  units: Array<{ unit: NormalizedUnit; rows: readonly DatasetRow[] }>,
  gaps: GapCollector,
  // NOTE for the compileSpec owner: this parameter must be wired through by
  // the caller — `compileSpec` should call
  // `resolveAxes(prepared, gaps, normalized.resolve)` so the
  // `resolve:independent-scale` gap fires for layered specs. Until then it is
  // only exercised by direct resolveAxes callers/tests.
  resolve?: NormalizedSpec['resolve'],
): ResolvedAxes {
  const xOccurrences: ChannelOccurrence[] = [];
  const yOccurrences: ChannelOccurrence[] = [];
  const grid: ResolvedAxes['grid'] = {};

  for (const { unit, rows } of units) {
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
    // Range channels (x2/y2) describe interval marks. Bar marks translate
    // them to Premium rangeBar series and rule marks report their own
    // segment gaps — only the remaining marks drop the second endpoint here.
    const handlesRangeChannels = unit.mark.type === 'bar' || unit.mark.type === 'rule';
    if (unit.encoding.x2 && !handlesRangeChannels) {
      gaps.add({
        code: 'channel:x2',
        message:
          'The `x2` channel (interval / ranged marks) has no x-charts equivalent for this mark; ' +
          'only the primary `x` endpoint is used.',
        severity: 'unsupported',
        path: `${unit.path}.encoding.x2`,
      });
    }
    if (unit.encoding.y2 && !handlesRangeChannels) {
      gaps.add({
        code: 'channel:y2',
        message:
          'The `y2` channel (interval / ranged marks) has no x-charts equivalent for this mark; ' +
          'only the primary `y` endpoint is used.',
        severity: 'unsupported',
        path: `${unit.path}.encoding.y2`,
      });
    }
  }

  // Independent per-layer scales require one axis pair per layer, which the
  // render shell does not provide — it draws a single shared x/y axis pair.
  const scaleResolve = resolve?.scale;
  if (scaleResolve) {
    for (const positional of ['x', 'y'] as const) {
      if (scaleResolve[positional] === 'independent') {
        gaps.add({
          code: 'resolve:independent-scale',
          message:
            `\`resolve.scale.${positional}: "independent"\` would need a separate ${positional} axis per layer; ` +
            'the shell renders one shared axis pair, so every layer shares the resolved scale.',
          severity: 'unsupported',
          path: `resolve.scale.${positional}`,
        });
      }
    }
  }

  let x = resolveChannelAxis('x', xOccurrences, gaps) as AxisResolution<XAxis> | undefined;
  let y = resolveChannelAxis('y', yOccurrences, gaps) as AxisResolution<YAxis> | undefined;

  // Vega-Lite renders an aggregate-only bar (a value channel with no category
  // channel anywhere in the spec) as a single bar over an implicit "all"
  // category. Synthesize a one-category band axis for that side so the bar
  // compiler has a domain to align to (marked `synthetic` — it has no backing
  // data field).
  const hasBarWith = (channel: 'x' | 'y') =>
    units.some(({ unit }) => unit.mark.type === 'bar' && isFieldDef(unit.encoding[channel]));
  if (!x && xOccurrences.length === 0 && hasBarWith('y')) {
    x = syntheticBandAxis('x') as AxisResolution<XAxis>;
  }
  if (!y && yOccurrences.length === 0 && hasBarWith('x')) {
    y = syntheticBandAxis('y') as AxisResolution<YAxis>;
  }

  return { x, y, grid };
}

/** A one-category band axis for aggregate-only bars (implicit "all" category). */
function syntheticBandAxis(channel: 'x' | 'y'): AxisResolution {
  const category = '';
  return {
    config: { id: `vega-${channel}`, scaleType: 'band', data: [category] },
    fieldType: 'nominal',
    categories: [category],
    categoryKeys: [categoryKey(category)],
    synthetic: true,
  };
}
