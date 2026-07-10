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
 *   - discrete band `padding`/`paddingInner` → band `categoryGapRatio`
 *     (approximate — `paddingOuter` has no x-charts equivalent, so a `partial`
 *     gap is recorded);
 *   - quantitative `scale.domain` / `zero` / `nice` / `reverse` / log-family,
 *     with `nice: true`→`domainLimit: 'nice'`, `nice: false`→`'strict'`, the
 *     `symlog` `constant`, and `zero` approximated by pinning the domain to the
 *     origin when the data is single-signed (both recorded as `partial` gaps);
 *   - axis-config enrichment (`title`, `labelAngle`, `tickCount`, `values`,
 *     `grid`, `labels`, `format`, `orient`, `ticks`→`disableTicks`,
 *     `domain`→`disableLine`) from the field def's `axis`, with
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
  // `axis.ticks: false` hides the tick marks; `axis.domain: false` hides the axis line.
  disableTicks?: boolean;
  disableLine?: boolean;
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
  // `axis.ticks: false` removes the tick marks; `axis.domain: false` removes the
  // axis (domain) line. These are the tick/line rendering toggles — distinct
  // from `scale.domain` (the data extent) handled on the quantitative branch.
  if (axis.ticks === false) {
    extras.disableTicks = true;
  }
  if (axis.domain === false) {
    extras.disableLine = true;
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

/**
 * Marks that need a discrete **band** scale (interior room per category) rather
 * than a point scale: bar/rect derive their width from the band, and
 * boxplot/errorbar center + dodge their per-category summary geometry inside it.
 * On a point scale the first/last categories sit exactly on the drawing-area
 * edges, so a dodged box/whisker (and its caps) spills outside the axis.
 */
const BAND_SCALE_MARKS = new Set(['bar', 'rect', 'boxplot', 'errorbar']);

/** `true` when any occurrence of the channel is drawn with a band-requiring mark. */
function channelNeedsBandScale(occurrences: ChannelOccurrence[]): boolean {
  return occurrences.some((occurrence) => BAND_SCALE_MARKS.has(occurrence.unit.mark.type));
}

/**
 * `true` when a quantitative positional channel must nonetheless render as a
 * discrete band because it is the **category** axis of a bar mark.
 *
 * x-charts draws bars over a band scale, never a linear one, so a bar needs one
 * discrete positional channel. Vega-Lite reads an un-aggregated, un-binned
 * quantitative field on a bar's discrete axis — e.g. a trellis `x: {field:
 * "age"}` paired with `y: {aggregate: "sum", field: "people"}` — as one bar per
 * distinct value. The channel is only forced discrete when the *opposite*
 * positional channel carries the aggregate (the true value axis); that keeps
 * horizontal bars (quantitative value on `x`, categorical `y`) and binned
 * histograms untouched, and never discretizes the value axis itself.
 */
export function forcesDiscreteBarCategory(
  channel: 'x' | 'y',
  units: Array<{ unit: NormalizedUnit; rows: readonly DatasetRow[] }>,
): boolean {
  const other = channel === 'x' ? 'y' : 'x';
  return units.some(({ unit, rows }) => {
    if (unit.mark.type !== 'bar') {
      return false;
    }
    const def = unit.encoding[channel];
    const otherDef = unit.encoding[other];
    if (!isFieldDef(def) || !isFieldDef(otherDef)) {
      return false;
    }
    // The category candidate must be a raw quantitative field — an aggregate,
    // bin, or timeUnit gets its own discrete handling elsewhere.
    if (
      def.aggregate !== undefined ||
      def.bin !== undefined ||
      def.timeUnit !== undefined ||
      resolveFieldType(def, rows) !== 'quantitative'
    ) {
      return false;
    }
    // The opposite channel must be the aggregated value axis; without that
    // disambiguation we could discretize the wrong (or both) channels.
    return otherDef.aggregate !== undefined;
  });
}

/**
 * `true` when any occurrence of the channel is drawn with a per-category mark
 * (`BAND_SCALE_MARKS`). On a temporal channel this also forces the discrete
 * band/point path instead of a continuous time scale (bar/rect derive their
 * width from a band; boxplot/errorbar group their summary geometry per category).
 */
function channelHasDiscreteTemporalMark(occurrences: ChannelOccurrence[]): boolean {
  return channelNeedsBandScale(occurrences);
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
  // Forces a quantitative axis onto a discrete band (a bar's category axis —
  // see `forcesDiscreteBarCategory`); ignored for non-quantitative types.
  forceDiscrete = false,
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
    // `axis.ticks: false` / `axis.domain: false` → hide the tick marks / axis line.
    disableTicks: extras.disableTicks,
    disableLine: extras.disableLine,
  };

  const forcedQuantitativeDiscrete = forceDiscrete && fieldType === 'quantitative';
  if (
    fieldType === 'nominal' ||
    fieldType === 'ordinal' ||
    fieldType === 'temporal' ||
    forcedQuantitativeDiscrete
  ) {
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

    // A quantitative field forced onto a discrete band (a bar's numeric
    // category axis) has no nominal order to preserve; default to ascending
    // numeric order like a Vega-Lite ordinal-quantitative axis, unless an
    // explicit `sort` overrides it below.
    if (forcedQuantitativeDiscrete && sort === undefined) {
      pairs.sort((a, b) => compareValues(a.value, b.value));
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
      explicitDiscreteScaleType(occurrences) ??
      (channelNeedsBandScale(occurrences) ? 'band' : 'point');

    // A temporal discrete axis defaults to a locale date string (unless a
    // translatable `axis.format` overrides it); nominal/ordinal axes only carry
    // a formatter when `axis.format` produced one (e.g. via `formatType`).
    let discreteValueFormatter = extras.valueFormatter;
    if (isTemporal && discreteValueFormatter === undefined) {
      discreteValueFormatter = (value) => (value as Date).toLocaleDateString();
    }

    // Band `padding`/`paddingInner` (a 0..1 inter-category gap ratio) maps to
    // x-charts' band `categoryGapRatio`, which expresses the same gap. Prefer
    // `paddingInner`; fall back to the combined `padding`. This is approximate:
    // x-charts has no `paddingOuter` equivalent (no outer band padding), so any
    // outer padding is dropped and a `partial` gap is recorded. Point scales
    // carry no `categoryGapRatio`, so this only applies to band.
    let categoryGapRatio: number | undefined;
    if (scaleType === 'band') {
      let innerPadding: number | undefined;
      if (typeof scale?.paddingInner === 'number') {
        innerPadding = scale.paddingInner;
      } else if (typeof scale?.padding === 'number') {
        innerPadding = scale.padding;
      }
      const hasOuterPadding = typeof scale?.paddingOuter === 'number';
      if (innerPadding !== undefined) {
        categoryGapRatio = innerPadding;
      }
      if (innerPadding !== undefined || hasOuterPadding) {
        gaps.add({
          code: 'scale:band-padding',
          message:
            'Band `padding`/`paddingInner` is approximated by the x-charts band `categoryGapRatio` ' +
            '(the gap between categories); `paddingOuter` has no x-charts equivalent and is dropped, so edge spacing ' +
            'may differ from Vega-Lite. Tune `categoryGapRatio` on the axis for exact inter-category spacing.',
          severity: 'partial',
          path: `${first.unit.path}.encoding.${channel}.scale`,
        });
      }
    }

    const config = {
      ...commonConfig,
      scaleType,
      data: categories,
      ...(categoryGapRatio !== undefined ? { categoryGapRatio } : {}),
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
  const explicitMin = typeof domain?.[0] === 'number' ? domain[0] : undefined;
  const explicitMax = typeof domain?.[1] === 'number' ? domain[1] : undefined;

  // `scale.nice` controls domain rounding. `false` pins the domain to the raw
  // extremums (x-charts `'strict'`); `true` asks for human-friendly rounding
  // (`'nice'`, also x-charts' own default). A numeric `nice` targets a specific
  // tick count while rounding — x-charts' `domainLimit` has no such knob, so it
  // still rounds to `'nice'` and the lost tick-count target is a `partial` gap.
  let domainLimit: 'nice' | 'strict' | undefined;
  if (scale?.nice === false) {
    domainLimit = 'strict';
  } else if (scale?.nice === true) {
    domainLimit = 'nice';
  } else if (typeof scale?.nice === 'number') {
    domainLimit = 'nice';
    gaps.add({
      code: 'scale:nice-count',
      message:
        `A numeric \`scale.nice\` (${scale.nice}) requests a specific tick count when rounding the ` +
        "domain, which x-charts' `domainLimit` cannot express; the domain is rounded to nice values without honoring " +
        'the count. Use `axis.tickCount` to influence tick density instead.',
      severity: 'partial',
      path: `${first.unit.path}.encoding.${channel}.scale.nice`,
    });
  }

  // `scale.zero` forces the domain to include the origin (Vega-Lite's default
  // for quantitative). x-charts has no `zero` toggle, so we approximate it: when
  // no explicit `domain` bound covers the relevant side and the data is entirely
  // single-signed, pin that side to 0 (`min: 0` for all-positive data, `max: 0`
  // for all-negative). Data already straddling zero needs nothing. It is only an
  // approximation — a `partial` gap records it — because the opposite end is
  // still subject to `domainLimit` rounding. `scale.zero: false` forces nothing,
  // matching x-charts' floating default.
  let zeroMin: number | undefined;
  let zeroMax: number | undefined;
  if (scale?.zero === true) {
    const extent = channelNumericExtent(occurrences);
    if (extent) {
      if (extent.min > 0 && explicitMin === undefined) {
        zeroMin = 0;
      } else if (extent.max < 0 && explicitMax === undefined) {
        zeroMax = 0;
      }
    }
    if (zeroMin !== undefined || zeroMax !== undefined) {
      gaps.add({
        code: 'scale:zero-approximation',
        message:
          '`scale.zero` is approximated by pinning the quantitative domain to include the origin ' +
          '(min: 0 for all-positive data, max: 0 for all-negative); x-charts has no dedicated `zero` toggle, so the ' +
          'opposite end is still subject to `domainLimit` rounding. Set an explicit `scale.domain` for exact bounds.',
        severity: 'partial',
        path: `${first.unit.path}.encoding.${channel}.scale.zero`,
      });
    }
  }

  const config = {
    ...commonConfig,
    scaleType,
    min: explicitMin ?? zeroMin,
    max: explicitMax ?? zeroMax,
    domainLimit,
    // The symlog scale's linear-around-zero threshold (`scale.constant`) maps
    // straight to x-charts' symlog `constant`; Vega-Lite only reads it on
    // symlog, so it is ignored for other scale types.
    ...(scaleType === 'symlog' && typeof scale?.constant === 'number'
      ? { constant: scale.constant }
      : {}),
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

/**
 * Numeric [min, max] extent of a quantitative channel across all its
 * occurrences' rows, or `undefined` when no finite numeric value is present.
 * Used to decide which side of the domain `scale.zero` should pin to the origin.
 */
function channelNumericExtent(
  occurrences: ChannelOccurrence[],
): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const occurrence of occurrences) {
    const field = fieldOf(occurrence.def);
    if (!field) {
      continue;
    }
    for (const row of occurrence.rows) {
      const raw = row[field];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        if (raw < min) {
          min = raw;
        }
        if (raw > max) {
          max = raw;
        }
      }
    }
  }
  return min <= max ? { min, max } : undefined;
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
  // Forces a quantitative bar category axis onto a band scale (see
  // `forcesDiscreteBarCategory`). The caller detects this from the
  // **pre-transform** encoding because the encoding aggregate pass strips the
  // `aggregate` marker before these `units` are prepared; when omitted the flag
  // is derived from `units` directly (correct for callers that pass un-aggregated
  // encodings, e.g. tests).
  forceDiscreteBarCategory?: { x?: boolean; y?: boolean },
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

  const forceX = forceDiscreteBarCategory?.x ?? forcesDiscreteBarCategory('x', units);
  const forceY = forceDiscreteBarCategory?.y ?? forcesDiscreteBarCategory('y', units);
  let x = resolveChannelAxis('x', xOccurrences, gaps, forceX) as AxisResolution<XAxis> | undefined;
  let y = resolveChannelAxis('y', yOccurrences, gaps, forceY) as AxisResolution<YAxis> | undefined;

  // Synthesize a one-category band axis for the perpendicular side of a mark
  // that encodes only one positional field:
  //   - an aggregate-only bar (a value channel, no category channel) → Vega-Lite
  //     draws one bar over an implicit "all" category;
  //   - a 1D `tick` strip/rug plot (only `x` or only `y`) → the ticks span the
  //     full perpendicular extent of that lone band.
  // The axis is marked `synthetic` (no backing data field); the bar/tick
  // compilers place every row on its single category.
  const hasSingleAxisMarkWith = (channel: 'x' | 'y') =>
    units.some(
      ({ unit }) =>
        (unit.mark.type === 'bar' || unit.mark.type === 'tick') &&
        isFieldDef(unit.encoding[channel]),
    );
  if (!x && xOccurrences.length === 0 && hasSingleAxisMarkWith('y')) {
    x = syntheticBandAxis('x') as AxisResolution<XAxis>;
  }
  if (!y && yOccurrences.length === 0 && hasSingleAxisMarkWith('x')) {
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
