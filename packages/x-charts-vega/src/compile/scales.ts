import type { XAxis, YAxis } from '@mui/x-charts/models';
import type {
  DatasetRow,
  VegaAggregateOp,
  VegaChannelDef,
  VegaFieldDef,
  VegaFieldType,
  VegaSort,
} from '../types';
import { isFieldDef } from '../types';
import type { GapCollector } from '../gaps';
import type { NormalizedSpec, NormalizedUnit } from '../normalize';
import type { AxisResolution } from './context';
import { categoryKey, toAxisCategory } from './context';
import { resolveFieldPath, resolveFieldType, toDate, toNumber } from './fieldTypes';
import { createValueFormatter } from '../format';
import { compileExpression, UnsupportedExpressionError } from '../transforms/calculate';
import { evaluateAggregate } from '../transforms/aggregateOps';

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
 *     origin when the data is single-signed — this is Vega-Lite's *default* for
 *     linear position scales (applied silently), and only an *explicit*
 *     `scale.zero: true` additionally records a `scale:zero-approximation`
 *     `partial` gap (the opposite end is still `domainLimit`-rounded);
 *   - axis-config enrichment (`title`, `labelAngle`, `tickCount`, `values`,
 *     `grid`, `labels`, `format`, `labelExpr`, `orient`, `ticks`→`disableTicks`,
 *     `domain`→`disableLine`) from the field def's `axis`, with
 *     the `format` d3 pattern compiled to a `valueFormatter` (see ../format)
 *     when it can be translated, and reported as a gap otherwise; `labelExpr`
 *     (a per-tick Vega expression, evaluated via ../transforms/calculate's
 *     safe evaluator) takes priority over `format` and is compiled the same
 *     way, joining an array result with `'\n'` for a multi-line label;
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

/**
 * Vega-Lite's default axis typography (config.axis defaults): 10px tick labels,
 * an 11px bold axis title, both pure black. x-charts' own defaults are larger
 * (12px labels, a 16px regular title) and 87%-opacity ink, so we override them
 * to read like the reference.
 */
const VEGA_TICK_LABEL_FONT_SIZE = 10;
const VEGA_AXIS_TITLE_FONT_SIZE = 11;
const VEGA_AXIS_INK = 'rgb(0, 0, 0)';

// Vega-Lite labels every category on a discrete axis; x-charts' default
// (`tickLabelInterval: 'auto'`) hides labels that would overlap, so a month axis
// drops to "Jan Apr Jul …". Force every discrete tick to keep its label to match
// the reference. (Continuous axes keep 'auto', which spaces numeric ticks.)
const SHOW_ALL_DISCRETE_LABELS = () => true;

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

function axisTitle(
  def: VegaChannelDef | undefined,
  configAxisDisable?: boolean,
): string | undefined {
  if (!def || !isFieldDef(def)) {
    return undefined;
  }
  // `axis: null` removes the axis entirely — including its title.
  const axis = def.axis;
  if (axis === null) {
    return undefined;
  }
  // `config.axis.disable` is a chart-wide default to hide every axis; a
  // channel's own explicit `axis` config (even `{}`) still wins over it.
  if (axis === undefined && configAxisDisable) {
    return undefined;
  }
  // An explicit `axis.title` (including `null` to suppress it) wins over the
  // field def's own `title` and the derived name.
  if (axis && typeof axis === 'object' && 'title' in axis) {
    return axis.title == null ? undefined : axis.title;
  }
  // `title: null` and an explicit empty `title: ""` both suppress the title
  // (Vega-Lite draws no axis title in either case — the marginal-histogram
  // count axes use `""` to hide their label).
  if (def.title === null || def.title === '') {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compiles an axis `labelExpr` (a Vega expression evaluated per tick, with
 * `datum.value` bound to the tick's raw value) into a `valueFormatter`. An
 * array result — Vega's convention for a multi-line label, e.g. `line_
 * conditional_axis`'s `[timeFormat(datum.value, '%b'), ...]` — is joined into
 * a single line with a space (blank elements dropped), rather than stacked
 * as separate lines: x-charts' `ChartsText` multi-line rendering measures
 * each line's height to compute its `<tspan dy>` offset, and that
 * measurement resolves to 0 for an axis tick label in practice, collapsing
 * every line onto the same baseline instead of stacking them
 * (`axis:labelExpr-multiline`, `ignored`/x-charts). Returns `null` (after
 * recording a gap) when the expression can't be parsed, or a given tick
 * can't be evaluated (unsupported syntax reached only from some tick
 * values), in which case the caller falls back to `axis.format`/the default
 * label.
 */
function createLabelExprFormatter(
  source: string,
  gaps: GapCollector,
  path: string,
): ((value: unknown) => string) | null {
  let evaluator: (datum: DatasetRow) => unknown;
  try {
    evaluator = compileExpression(source);
  } catch (err) {
    if (!(err instanceof UnsupportedExpressionError)) {
      throw err;
    }
    gaps.add({
      code: 'scale:axis-labelExpr',
      message: `Axis \`labelExpr\` "${source}" could not be parsed (${errorMessage(err)}); x-charts applies its default label formatting instead.`,
      severity: 'partial',
      path,
    });
    return null;
  }
  // A one-time probe (rather than checking on every real tick evaluation)
  // so the gap shows up in the compiled gap list even though the actual
  // per-tick formatter only runs later, during rendering.
  try {
    const probe = evaluator({ value: new Date() } as DatasetRow);
    if (Array.isArray(probe) && probe.length > 1) {
      gaps.add({
        code: 'axis:labelExpr-multiline',
        message:
          `Axis \`labelExpr\` "${source}" returns a multi-line label (an array); x-charts' tick-label ` +
          'multi-line height measurement resolves to 0 in practice, so the lines are joined onto one ' +
          'line with a space instead of stacked.',
        severity: 'ignored',
        path,
      });
    }
  } catch {
    // The real per-tick evaluation below reports its own gap if a tick's
    // value hits unsupported syntax; a probe failure alone isn't reportable.
  }
  return (value: unknown) => {
    try {
      const result = evaluator({ value } as DatasetRow);
      const parts = Array.isArray(result) ? result : [result];
      return parts
        .map((part) => (part == null ? '' : String(part)))
        .filter((part) => part !== '')
        .join(' ');
    } catch (err) {
      if (!(err instanceof UnsupportedExpressionError)) {
        throw err;
      }
      gaps.add({
        code: 'scale:axis-labelExpr',
        message: `Axis \`labelExpr\` "${source}" uses unsupported syntax (${errorMessage(err)}) for some ticks; x-charts applies its default label formatting there instead.`,
        severity: 'partial',
        path,
      });
      return String(value ?? '');
    }
  };
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
  configAxisDisable?: boolean,
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
    // `config.axis.disable` is a chart-wide default to hide every axis
    // (line, ticks, labels, title); a channel's own explicit `axis` config
    // still wins over it, matching `axis: null`'s per-channel behavior.
    if (configAxisDisable) {
      extras.position = 'none';
    }
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
  let labelExprHandled = false;
  if (typeof axis.labelExpr === 'string') {
    // `labelExpr` fully overrides the default label (Vega-Lite's own
    // precedence — it wins over `format` too), so it's checked first. An
    // unparseable `labelExpr` still falls through to `format` below (rather
    // than leaving the axis with no custom formatter at all) when one is
    // also given.
    const formatter = createLabelExprFormatter(
      axis.labelExpr,
      gaps,
      `${path}.encoding.${channel}.axis.labelExpr`,
    );
    if (formatter) {
      extras.valueFormatter = formatter;
      labelExprHandled = true;
    }
  }
  if (!labelExprHandled && typeof axis.format === 'string') {
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

/**
 * Formats a `timeUnit`-truncated Date for an axis label the way Vega-Lite does:
 * a `month` axis reads "Jan" (not "1/1/2012"), `yearmonth` "Jan 2012", `year`
 * "2012", `quarter` "Q1", `day` "Mon", etc. Falls back to a locale date string
 * for units without a dedicated format. Selected by the `__timeUnit_<unit>_`
 * synthetic column name the encoding pass emits.
 */
function timeUnitAxisFormatter(unit: string): (value: unknown) => string {
  const base = unit.replace(/^utc/, '');
  const asDate = (value: unknown): Date | null => (value instanceof Date ? value : toDate(value));
  const withOptions =
    (options: Intl.DateTimeFormatOptions) =>
    (value: unknown): string => {
      const date = asDate(value);
      return date ? date.toLocaleDateString('en-US', options) : String(value);
    };
  switch (base) {
    case 'year':
      return withOptions({ year: 'numeric' });
    case 'quarter':
    case 'yearquarter':
      return (value) => {
        const date = asDate(value);
        if (!date) {
          return String(value);
        }
        const quarter = `Q${Math.floor(date.getMonth() / 3) + 1}`;
        return base === 'yearquarter' ? `${quarter} ${date.getFullYear()}` : quarter;
      };
    case 'month':
      return withOptions({ month: 'short' });
    case 'yearmonth':
      return withOptions({ year: 'numeric', month: 'short' });
    case 'date':
    case 'monthdate':
    case 'yearmonthdate':
      return withOptions({ month: 'short', day: 'numeric' });
    case 'day':
      return withOptions({ weekday: 'short' });
    case 'hours':
    case 'hoursminutes':
      return withOptions({
        hour: 'numeric',
        ...(base === 'hoursminutes' ? { minute: '2-digit' } : {}),
      });
    default:
      return (value) => {
        const date = asDate(value);
        return date ? date.toLocaleDateString() : String(value);
      };
  }
}

/** Numeric-, date-, then lexicographic-aware comparison for sort orders. */
function compareValues(a: unknown, b: unknown): number {
  // Vega leads a nominal domain with its null band rather than sorting "null"
  // in among the labels alphabetically.
  if (a === null || b === null) {
    return a === b ? 0 : (a === null && -1) || 1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  return String(a).localeCompare(String(b));
}

interface CategoryPair {
  /** `null` is a legitimate nominal/ordinal category — see `nullIsCategory`. */
  value: string | number | Date | null;
  key: string;
}

/**
 * Resolves the field (and, for an object sort, aggregate op) a `sort` should
 * rank categories by:
 * - an object sort `{field, op}` reads `field`/`op` directly;
 * - a channel-shorthand string (`"x"`/`"-x"`/`"color"`/…, Vega-Lite's compact
 *   "sort by another encoding channel" form — the `-` prefix is stripped by
 *   the caller before this runs) resolves that channel's OWN field from any
 *   occurrence's unit that defines it. No `op` is needed here: the encoding-
 *   transform pass (`transforms/encoding.ts`) already rewrote a channel-level
 *   `aggregate` into a synthetic field name and collapsed the rows to one per
 *   category before this ever runs, so the channel's field already holds the
 *   resolved per-category value.
 * Returns `undefined` when nothing resolves (an object sort with no `field`,
 * or a channel name no occurrence's unit actually encodes).
 */
function resolveSortField(
  sort: { field?: string; op?: VegaAggregateOp } | string,
  occurrences: ChannelOccurrence[],
): { field: string; op?: VegaAggregateOp } | undefined {
  if (typeof sort === 'string') {
    for (const occurrence of occurrences) {
      const channelDef = occurrence.unit.encoding[sort] as VegaChannelDef | undefined;
      if (channelDef && !Array.isArray(channelDef) && isFieldDef(channelDef) && channelDef.field) {
        return { field: channelDef.field };
      }
    }
    return undefined;
  }
  return sort.field ? { field: sort.field, op: sort.op } : undefined;
}

/**
 * A category's sort key for `resolveSortField`'s resolved field/op: the
 * aggregate of every row sharing that category when `op` is given, else the
 * (already-resolved, one-row-per-category) value straight off the first
 * matching row. `null` for a category with no matching rows or an
 * unresolvable/non-numeric aggregate — sorted to the end, same as an
 * explicit-array sort's unlisted values.
 */
function sortKeyForCategory(
  key: string,
  field: string,
  op: VegaAggregateOp | undefined,
  rowsByCategoryKey: Map<string, DatasetRow[]>,
): number | null {
  const rows = rowsByCategoryKey.get(key);
  if (!rows || rows.length === 0) {
    return null;
  }
  if (op) {
    const values = rows.map((row) => resolveFieldPath(row, field));
    const result = evaluateAggregate(op, values, rows);
    return typeof result === 'number' ? result : null;
  }
  return toNumber(resolveFieldPath(rows[0], field));
}

/**
 * Applies a discrete-axis `sort` to the collected category/key pairs. Data
 * order is preserved for `null`/`undefined`. An object sort (`{field, op,
 * order}`) or a channel-shorthand string (`"x"`/`"-x"`/…) ranks categories by
 * that field's (aggregated) numeric value via `resolveSortField`/
 * `sortKeyForCategory`; a category whose key can't be resolved to a number
 * keeps its data order at the end. A sort that can't be resolved at all (no
 * `field`, or a channel name nothing encodes) reports a `partial` gap and
 * falls back to data order, same as before.
 */
function applySort(
  pairs: CategoryPair[],
  sort: VegaSort | undefined,
  isTemporal: boolean,
  rowsByCategoryKey: Map<string, DatasetRow[]>,
  occurrences: ChannelOccurrence[],
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

  // Object ({field, op, order}) or channel-shorthand string ("x"/"-x"/…)
  // sorts rank categories by another field's (aggregated) value.
  let descending: boolean;
  let sortFieldSource: { field?: string; op?: VegaAggregateOp } | string;
  if (typeof sort === 'string') {
    descending = sort.startsWith('-');
    sortFieldSource = descending ? sort.slice(1) : sort;
  } else {
    descending = sort.order === 'descending';
    sortFieldSource = sort;
  }
  const resolved = resolveSortField(sortFieldSource, occurrences);
  if (!resolved) {
    gaps.add({
      code: 'scale:sort-by-field',
      message:
        'Sorting a discrete axis by another field or aggregate could not be resolved (no `field`, ' +
        'or a channel-shorthand name nothing in this chart actually encodes); ' +
        'the domain keeps its data order. Pre-sort or pre-aggregate the rows to control the order.',
      severity: 'partial',
      path: `${path}.sort`,
    });
    return pairs;
  }

  const keyed = pairs.map((pair) => ({
    pair,
    sortKey: sortKeyForCategory(pair.key, resolved.field, resolved.op, rowsByCategoryKey),
  }));
  const resolvedEntries = keyed.filter(
    (entry): entry is { pair: CategoryPair; sortKey: number } => entry.sortKey !== null,
  );
  const unresolvedEntries = keyed.filter((entry) => entry.sortKey === null);
  resolvedEntries.sort((a, b) => a.sortKey - b.sortKey);
  if (descending) {
    resolvedEntries.reverse();
  }
  // A category whose sort key couldn't be resolved keeps data order, appended
  // after the successfully-ranked ones (mirroring the explicit-array sort's
  // handling of unlisted values above).
  return [...resolvedEntries, ...unresolvedEntries].map((entry) => entry.pair);
}

/**
 * Marks that need a discrete **band** scale (interior room per category) rather
 * than a point scale: bar/rect derive their width from the band, and
 * boxplot/errorbar center + dodge their per-category summary geometry inside it.
 * A span `rule` (x→x2 anchored on a categorical axis) is bar-like too — a Gantt
 * row per category. On a point scale the first/last categories sit exactly on
 * the drawing-area edges, so a dodged box/whisker (or the last span bar) spills
 * onto or outside the axis.
 */
const BAND_SCALE_MARKS = new Set(['bar', 'rect', 'boxplot', 'errorbar', 'rule']);

/**
 * `true` when any occurrence of the channel is drawn with a band-requiring mark.
 *
 * A RANGED occurrence is exempt: a mark that also encodes the channel's `x2`/
 * `y2` twin states its own start and end in data space and derives nothing from
 * the band width, so it sits happily on a continuous scale. This matters most
 * in a layered spec, where one ranged rect used to drag the whole shared axis
 * onto a band scale — `layer_falkensee` draws two `x`→`x2` era-highlight
 * rectangles behind a population line, and banding the axis for their sake
 * spaced its irregular yearly readings evenly, visibly deforming the curve
 * (1875→1950 taking the same width as 1990→2014). The exemption is per
 * CHANNEL, so a Gantt-style span rule still bands its category axis (no `y2`)
 * while leaving its time axis (`x`→`x2`) continuous.
 */
function channelNeedsBandScale(occurrences: ChannelOccurrence[], channel: 'x' | 'y'): boolean {
  const twin = channel === 'x' ? 'x2' : 'y2';
  const otherTwin = channel === 'x' ? 'y2' : 'x2';
  return occurrences.some((occurrence) => {
    if (!BAND_SCALE_MARKS.has(occurrence.unit.mark.type)) {
      return false;
    }
    if (occurrence.unit.encoding[twin] != null) {
      return false;
    }
    // `rule` is in this set only for the Gantt idiom — a span on ONE axis laid
    // out per category on the other — so it needs a band solely on that
    // category axis, i.e. when the OPPOSITE channel is the one carrying the
    // span. A plain rule with no span at all is a zero-width marker line (the
    // hover indicator in `interactive_multi_line_tooltip`) and derives nothing
    // from a band, so it must not drag a time axis off its continuous scale.
    if (occurrence.unit.mark.type === 'rule') {
      return occurrence.unit.encoding[otherTwin] != null;
    }
    return true;
  });
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
function channelHasDiscreteTemporalMark(
  occurrences: ChannelOccurrence[],
  channel: 'x' | 'y',
): boolean {
  return channelNeedsBandScale(occurrences, channel);
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
  // `spec.config.axis.disable` — see `buildAxisExtras`/`axisTitle`.
  configAxisDisable = false,
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
  const extras = buildAxisExtras(def, channel, fieldType, gaps, first.unit.path, configAxisDisable);
  // Axis props shared by the discrete and quantitative branches — assembled in
  // one place so new props cannot drift between the two.
  const commonConfig = {
    id: `vega-${channel}`,
    label: axisTitle(def, configAxisDisable),
    reverse: scale?.reverse === true || undefined,
    tickNumber: extras.tickNumber,
    tickInterval: extras.tickInterval,
    // Match Vega-Lite's axis typography: 10px black tick labels and an 11px bold
    // black axis title (x-charts defaults are larger — 12px labels, a 16px
    // regular-weight title). Any explicit `tickLabelStyle` (angle/hidden labels)
    // is layered on top of the font default.
    tickLabelStyle: {
      fontSize: VEGA_TICK_LABEL_FONT_SIZE,
      fill: VEGA_AXIS_INK,
      ...extras.tickLabelStyle,
    },
    labelStyle: { fontSize: VEGA_AXIS_TITLE_FONT_SIZE, fontWeight: 700, fill: VEGA_AXIS_INK },
    // `axis.ticks: false` / `axis.domain: false` → hide the tick marks / axis line.
    disableTicks: extras.disableTicks,
    disableLine: extras.disableLine,
    // Let x-charts size the axis to its tick labels (opt-in in v9) instead of
    // using the narrow default width/height, which otherwise ellipsizes long
    // category names ("Glabron" → "Gla…") and large numbers ("20,000" → "20,0…").
    ...(channel === 'y' ? { width: 'auto' as const } : { height: 'auto' as const }),
  };

  const forcedQuantitativeDiscrete = forceDiscrete && fieldType === 'quantitative';
  if (
    fieldType === 'nominal' ||
    fieldType === 'ordinal' ||
    fieldType === 'temporal' ||
    forcedQuantitativeDiscrete
  ) {
    const isTemporal = fieldType === 'temporal';
    // Computed once up front: a per-category mark (bar/rect/boxplot/errorbar)
    // needs a band scale to derive its width/summary geometry, and an explicit
    // `scale.type` on any occurrence can request a specific discrete scale —
    // both the temporal continuous-vs-discrete decision below and the
    // band-vs-point decision further down depend on them.
    const forcedDiscreteMark = channelHasDiscreteTemporalMark(occurrences, channel);
    const explicitDiscrete = explicitDiscreteScaleType(occurrences);
    // On a nominal/ordinal scale a missing value is a category in its own
    // right, not a row to drop: Vega gives it a band of its own, labelled
    // "null" (`movies.json`'s 30 films with no `Major Genre`, say). That only
    // holds for a genuinely discrete field — for a temporal or quantitative
    // channel `null` means the value failed to parse or isn't there, and those
    // rows still drop out rather than collapsing into a spurious band.
    //
    // A `bin`/`timeUnit` synthetic column is excluded even though it resolves
    // to an ordinal band: there `null` means the row had nothing to bin, and
    // Vega drops it rather than banding it. Banding it would also resurrect
    // the phantom null-bin group that the rect color extent deliberately
    // ignores (see `marks/rect.ts`).
    const nullIsCategory =
      (fieldType === 'nominal' || fieldType === 'ordinal') &&
      !(
        typeof field === 'string' &&
        (field.startsWith('__bin_') || field.startsWith('__timeUnit_'))
      );
    const pairs: CategoryPair[] = [];
    const seen = new Set<string>();
    // Rows keyed by their category, for a `sort` that ranks categories by
    // another field's (aggregated) value (`applySort`'s object/channel-
    // shorthand forms) — every row sharing a category, not deduped like
    // `pairs`, since an aggregate op needs the full group.
    const rowsByCategoryKey = new Map<string, DatasetRow[]>();
    for (const occurrence of occurrences) {
      const occurrenceField = fieldOf(occurrence.def);
      if (!occurrenceField) {
        continue;
      }
      for (const row of occurrence.rows) {
        const raw = resolveFieldPath(row, occurrenceField);
        const value = isTemporal ? toDate(raw) : (raw as string | number | Date);
        if (value == null && !nullIsCategory) {
          continue;
        }
        const key = categoryKey(value ?? null);
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ value: value ?? null, key });
        }
        const group = rowsByCategoryKey.get(key);
        if (group) {
          group.push(row);
        } else {
          rowsByCategoryKey.set(key, [row]);
        }
      }
    }

    // A `bar`/`rect` mark's unmatched "2" companion field (x2 alongside a
    // discrete x, with no real y2 to pair it into a genuine ranged bar/rect)
    // shares this same discrete scale — each row's shape spans from its own
    // category value to its own companion value (marks/bar.ts's category-
    // ranged-rect path, `histogram_nonlinear`'s irregular bin widths; marks/
    // rect.ts's `compileRangedRect`, `layer_falkensee`'s highlight bands). A
    // companion-only value (`histogram_nonlinear`'s final "∞" endTime, which
    // never appears as a startTime; `layer_falkensee`'s "1945"/"1948" end
    // dates, which don't all coincide with the line layer's own year values)
    // is appended after every primary-field value has already been
    // collected, so it lands at the end of an unsorted (`sort: null`) domain —
    // matching Vega-Lite's own append-on-first-appearance order. The
    // companion field is never itself run through the inline-timeUnit
    // rewrite (only x/y/color are, see transforms/encoding.ts's
    // `INLINE_TRANSFORM_CHANNELS`), so a temporal axis's raw companion value
    // needs the same `toDate` coercion as the primary field loop above.
    const twinChannel = channel === 'x' ? 'x2' : 'y2';
    const otherTwinChannel = channel === 'x' ? 'y2' : 'x2';
    for (const occurrence of occurrences) {
      if (occurrence.unit.mark.type !== 'bar' && occurrence.unit.mark.type !== 'rect') {
        continue;
      }
      const twinDef = occurrence.unit.encoding[twinChannel];
      const otherTwinDef = occurrence.unit.encoding[otherTwinChannel];
      const twinField =
        twinDef && !Array.isArray(twinDef) && isFieldDef(twinDef) ? twinDef.field : undefined;
      if (!twinField || otherTwinDef !== undefined) {
        continue;
      }
      for (const row of occurrence.rows) {
        const raw = resolveFieldPath(row, twinField);
        const value = isTemporal ? toDate(raw) : (raw as string | number | Date | null);
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

    // A discrete axis defaults to ascending order (numeric, then chronological,
    // then locale-alphabetical), matching Vega-Lite's default nominal/ordinal
    // sort — unless an explicit `sort` overrides it below, or a `bin`/`timeUnit`
    // synthetic column already carries a deliberate order (those keep first-seen
    // order so bins/months stay in their natural sequence rather than sorting
    // "10–20" before "2–3" or "Apr" before "Jan").
    const isPreOrderedSynthetic =
      typeof field === 'string' && (field.startsWith('__bin_') || field.startsWith('__timeUnit_'));
    if (!isTemporal && sort === undefined && pairs.length > 0 && !isPreOrderedSynthetic) {
      pairs.sort((a, b) => compareValues(a.value, b.value));
    }

    const ordered = applySort(
      pairs,
      sort,
      isTemporal,
      rowsByCategoryKey,
      occurrences,
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
    // channel forced discrete above. Bars need a band scale to derive width —
    // that need wins even over an explicit `scale.type: "point"`/`"ordinal"`,
    // since x-charts has no way to size a bar series without one (an explicit
    // point scale on a bar/rect/boxplot/errorbar channel would otherwise
    // reach x-charts with no band width to draw from and crash).
    const explicitConflictsWithBar = forcedDiscreteMark && explicitDiscrete === 'point';
    if (explicitConflictsWithBar) {
      gaps.add({
        code: 'scale:point-forced-band',
        message:
          `An explicit \`scale.type: "point"\` is not usable here — this channel's mark ` +
          '(bar/rect/boxplot/errorbar) needs a band scale to derive its width/summary geometry, ' +
          'so "band" is used instead.',
        severity: 'partial',
        path: `${first.unit.path}.encoding.${channel}.scale.type`,
      });
    }
    const scaleType = forcedDiscreteMark ? 'band' : (explicitDiscrete ?? 'point');

    // A temporal discrete axis defaults to a locale date string (unless a
    // translatable `axis.format` overrides it); nominal/ordinal axes only carry
    // a formatter when `axis.format` produced one (e.g. via `formatType`).
    let discreteValueFormatter = extras.valueFormatter;
    if (isTemporal && discreteValueFormatter === undefined) {
      // A `timeUnit` channel is rewritten to a `__timeUnit_<unit>_<field>`
      // synthetic column; label the axis by that unit (month → "Jan") like
      // Vega-Lite, rather than a raw locale date.
      const timeUnitMatch = typeof field === 'string' ? /^__timeUnit_([a-z]+)_/.exec(field) : null;
      discreteValueFormatter = timeUnitMatch
        ? timeUnitAxisFormatter(timeUnitMatch[1])
        : (value) => (value as Date).toLocaleDateString();
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
      // A binned histogram axis (the synthetic `__bin_*` column produced by an
      // inline `bin`) should render contiguous bars — Vega-Lite draws bins edge
      // to edge with no inter-bar gap. Default the band gap to 0 when the spec
      // didn't set its own padding.
      if (
        categoryGapRatio === undefined &&
        typeof field === 'string' &&
        field.startsWith('__bin_')
      ) {
        categoryGapRatio = 0;
      }
      // A `rect` mark's discrete band scale defaults to no padding in
      // Vega-Lite — a heatmap's cells tile edge to edge, unlike a `bar`'s band
      // (which keeps x-charts' own default inter-bar gap). The band scale is
      // shared by the whole view, so a text/point layer annotating the same
      // heatmap cells (sharing this axis) shouldn't block the zero gap —
      // only check that *some* occurrence is a rect, not all of them.
      if (
        categoryGapRatio === undefined &&
        occurrences.some((occurrence) => occurrence.unit.mark.type === 'rect')
      ) {
        categoryGapRatio = 0;
      }
    }

    // x-charts places the first discrete category at the TOP of a y-axis. That
    // is right for a categorical band (nominal/ordinal — including numeric
    // ordinals like `age`, which Vega-Lite also lays out first-at-top), but a
    // *binned* quantitative y-axis represents a continuous range that Vega-Lite
    // draws low-to-high from the bottom up. Reverse only the binned case so the
    // smallest bin sits at the bottom; combine with an explicit `scale.reverse`.
    const isBinnedField = typeof field === 'string' && field.startsWith('__bin_');
    const reverseForBinnedY = channel === 'y' && isBinnedField;
    const reverse = (scale?.reverse === true) !== reverseForBinnedY ? true : undefined;

    const config = {
      ...commonConfig,
      scaleType,
      reverse,
      data: categories.map(toAxisCategory),
      tickLabelInterval: SHOW_ALL_DISCRETE_LABELS,
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
  // Vega-Lite defaults `zero: true` for a quantitative position scale (so e.g. a
  // Horsepower axis runs 0→240, not 46→240), unless the spec sets `zero: false`
  // or an explicit domain. Apply that default on linear scales (log/pow/sqrt/
  // symlog can't sensibly include 0, and Vega-Lite doesn't zero them either).
  // A `stack: 'center'` (silhouette) y field renders symmetrically about 0 —
  // x-charts' own d3-shape stacking computes genuinely negative values for the
  // lower half — so pinning the axis min to 0 (as if the raw, pre-stack field
  // were all-positive) would chop that negative half off outside the domain
  // and squeeze the whole stack into the remaining half, clipping the peaks
  // that need the full range. `zero`/`normalize` stacks keep a 0 baseline, so
  // only `center` is exempted here.
  const isCenterStacked = occurrences.some((occurrence) => {
    const def = occurrence.def;
    return isFieldDef(def) && (def as VegaFieldDef).stack === 'center';
  });
  let zeroMin: number | undefined;
  let zeroMax: number | undefined;
  if (scale?.zero !== false && scaleType === 'linear' && !isCenterStacked) {
    const extent = channelNumericExtent(occurrences);
    if (extent) {
      if (extent.min > 0 && explicitMin === undefined) {
        zeroMin = 0;
      } else if (extent.max < 0 && explicitMax === undefined) {
        zeroMax = 0;
      }
    }
    // Only note the approximation (the opposite end is still `domainLimit`-
    // rounded) when the spec *explicitly* asked for zero — the default case is
    // standard Vega-matching behavior and shouldn't add gap noise to every chart.
    if ((zeroMin !== undefined || zeroMax !== undefined) && scale?.zero === true) {
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

  // Take over the nice rounding on linear scales. x-charts' built-in `'nice'`
  // rounds against the tick count the axis can FIT, so the identical data rounds
  // coarser in a small composite cell than in a full-size chart; Vega always
  // nices with d3's fixed count of 10. Handing x-charts a `domainLimit` FUNCTION
  // is what makes this safe: x-charts invokes it with the extent IT computed —
  // already stacked — so a stacked bar/area still nices against its true total.
  // Computing a `max` here from the raw field values instead would clip every
  // stack to its tallest single segment.
  //
  // The zero pin is applied inside the function so the rounding sees the same
  // zero-based extent Vega rounds (Vega zeroes first, then nices); `min`/`max`
  // below still win afterwards, and agree with what the function produced.
  type DomainLimit = NonNullable<(XAxis | YAxis)['domainLimit']>;
  const niceLimit: DomainLimit | undefined =
    scaleType === 'linear' && domainLimit !== 'strict'
      ? (dataMin, dataMax) => {
          let lo = Number(dataMin.valueOf());
          let hi = Number(dataMax.valueOf());
          if (zeroMin !== undefined) {
            lo = Math.min(zeroMin, lo);
          }
          if (zeroMax !== undefined) {
            hi = Math.max(zeroMax, hi);
          }
          const nice = niceExtent(lo, hi);
          return nice ? { min: nice[0], max: nice[1] } : { min: lo, max: hi };
        }
      : undefined;

  const config = {
    ...commonConfig,
    scaleType,
    min: explicitMin ?? zeroMin,
    max: explicitMax ?? zeroMax,
    domainLimit: niceLimit ?? domainLimit,
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
    hasExplicitDomain: explicitMin !== undefined || explicitMax !== undefined,
  };
}

// d3's tick sizing, which Vega-Lite's `nice` rounding is built on. Reproduced
// here (rather than reused from x-charts) because the two disagree in a way that
// shows up as squashed marks: x-charts' `domainLimit: 'nice'` rounds relative to
// the tick count the axis can FIT, so the same data in a small composite cell
// rounds far coarser than in a full-size chart — a `repeat_histogram` cell whose
// counts peak at 113 rounded up to 200 (bars at ~56% height) where Vega drew
// 120. Vega always nices with d3's default count of 10 regardless of pixel size.
const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);
const NICE_TICK_COUNT = 10;

function tickIncrement(start: number, stop: number, count: number): number {
  const step = (stop - start) / Math.max(0, count);
  const power = Math.floor(Math.log10(step));
  const error = step / 10 ** power;
  let factor = 1;
  if (error >= E10) {
    factor = 10;
  } else if (error >= E5) {
    factor = 5;
  } else if (error >= E2) {
    factor = 2;
  }
  return power >= 0 ? factor * 10 ** power : -(10 ** -power) / factor;
}

/**
 * d3's `nice`: widen [start, stop] outward to the round values implied by a
 * tick step, iterating until the step stops changing (rounding one end can
 * change the span, and so the step). Returns the input unchanged for a degenerate
 * or non-finite extent, so a single-value or empty channel is left to x-charts.
 */
function niceExtent(start: number, stop: number): [number, number] | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(stop) || start === stop) {
    return undefined;
  }
  let lo = start;
  let hi = stop;
  let prestep: number | undefined;
  for (let i = 0; i < 10; i += 1) {
    const step = tickIncrement(lo, hi, NICE_TICK_COUNT);
    if (step === prestep) {
      return [lo, hi];
    }
    if (step > 0) {
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
    } else if (step < 0) {
      lo = Math.ceil(lo * step) / step;
      hi = Math.floor(hi * step) / step;
    } else {
      return undefined;
    }
    prestep = step;
  }
  return [lo, hi];
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
      const raw = resolveFieldPath(row, field);
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
  // `spec.config.axis.grid` sets the chart-wide grid default (e.g. forcing
  // grid lines onto an otherwise-ungridded discrete band axis); a per-field
  // `encoding.<channel>.axis.grid` still overrides it.
  configAxisGrid?: boolean,
  // `spec.config.axis.disable` hides every axis by default (line, ticks,
  // labels, title); a channel's own explicit `axis` config still overrides it.
  configAxisDisable?: boolean,
): ResolvedAxes {
  const xOccurrences: ChannelOccurrence[] = [];
  const yOccurrences: ChannelOccurrence[] = [];
  const grid: ResolvedAxes['grid'] = {};
  // An explicit `axis.grid` (true/false) on any layer overrides the per-axis
  // default computed after resolution below.
  let explicitXGrid: boolean | undefined;
  let explicitYGrid: boolean | undefined;

  const readExplicitGrid = (def: VegaChannelDef | undefined): boolean | undefined => {
    const axis = isFieldDef(def) ? (def.axis as { grid?: unknown } | null | undefined) : undefined;
    return axis && typeof axis === 'object' && 'grid' in axis ? !!axis.grid : undefined;
  };

  for (const { unit, rows } of units) {
    if (unit.encoding.x) {
      xOccurrences.push({ unit, rows, def: unit.encoding.x });
      explicitXGrid = readExplicitGrid(unit.encoding.x) ?? explicitXGrid;
    }
    if (unit.encoding.y) {
      yOccurrences.push({ unit, rows, def: unit.encoding.y });
      explicitYGrid = readExplicitGrid(unit.encoding.y) ?? explicitYGrid;
    }
    // Range channels (x2/y2) describe interval marks. Bar marks translate
    // them to Premium rangeBar series, rule marks report their own segment
    // gaps, and rect marks draw a filled interval/span rect (`marks/rect.ts`
    // `compileRangedRect`) — only the remaining marks drop the second
    // endpoint here.
    const handlesRangeChannels =
      unit.mark.type === 'bar' || unit.mark.type === 'rule' || unit.mark.type === 'rect';
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
  let x = resolveChannelAxis('x', xOccurrences, gaps, forceX, configAxisDisable) as
    AxisResolution<XAxis> | undefined;
  let y = resolveChannelAxis('y', yOccurrences, gaps, forceY, configAxisDisable) as
    AxisResolution<YAxis> | undefined;

  // Vega-Lite draws grid lines on continuous (quantitative/temporal) axes by
  // default and omits them on discrete band/point axes; an explicit `axis.grid`
  // overrides that. Match it: a bar chart gets horizontal grid lines only, a
  // scatter/line chart gets both.
  const isContinuousAxis = (axis: AxisResolution | undefined): boolean => {
    const scaleType = (axis?.config as { scaleType?: string } | undefined)?.scaleType;
    return scaleType !== undefined && scaleType !== 'band' && scaleType !== 'point';
  };
  // A chart-wide `config.axis.disable` implies no grid either — there's no
  // axis guide left to draw one from — unless an explicit `axis.grid` still
  // asks for it (handled by `explicitXGrid`/`explicitYGrid` above).
  grid.vertical = explicitXGrid ?? configAxisGrid ?? (!configAxisDisable && isContinuousAxis(x));
  grid.horizontal = explicitYGrid ?? configAxisGrid ?? (!configAxisDisable && isContinuousAxis(y));

  // Synthesize a one-category band axis for the perpendicular side of a mark
  // that encodes only one positional field:
  //   - an aggregate-only bar (a value channel, no category channel) → Vega-Lite
  //     draws one bar over an implicit "all" category;
  //   - a 1D `tick` strip/rug plot (only `x` or only `y`) → the ticks span the
  //     full perpendicular extent of that lone band;
  //   - a `point`/`circle`/`square`/`text` mark with only one positional field
  //     (e.g. `brush_table`'s single-column text table, only `y`; or
  //     `concat_bar_scales_discretize`'s size/color-only circle panels) →
  //     Vega-Lite centers every row on one implicit position along the unset
  //     axis, varying only along the one it did encode.
  // The axis is marked `synthetic` (no backing data field); each of these
  // compilers places every row on its single category.
  const SINGLE_AXIS_MARK_TYPES = new Set(['bar', 'tick', 'point', 'circle', 'square', 'text']);
  // `missingChannel` must be entirely unset (not just non-field) on that same
  // unit — a deliberate `{value}`/`{datum}` def on the "missing" side (e.g. a
  // point mark explicitly pinning `y: {value: 0}`) is a different, distinct
  // case this wrapper doesn't otherwise resolve, and must keep reporting its
  // own missing-axis gap rather than silently being overridden by a synthetic
  // band it never asked for.
  const hasSingleAxisMarkWith = (presentChannel: 'x' | 'y', missingChannel: 'x' | 'y') =>
    units.some(
      ({ unit }) =>
        SINGLE_AXIS_MARK_TYPES.has(unit.mark.type) &&
        isFieldDef(unit.encoding[presentChannel]) &&
        unit.encoding[missingChannel] === undefined,
    );
  if (!x && xOccurrences.length === 0 && hasSingleAxisMarkWith('y', 'x')) {
    x = syntheticBandAxis('x') as AxisResolution<XAxis>;
  }
  if (!y && yOccurrences.length === 0 && hasSingleAxisMarkWith('x', 'y')) {
    y = syntheticBandAxis('y') as AxisResolution<YAxis>;
  }

  return { x, y, grid };
}

/**
 * A one-category band axis for aggregate-only bars (implicit "all" category).
 *
 * Drawn as `position: 'none'`: the channel is absent from the spec, so
 * Vega-Lite renders no axis guide for it at all, and the sole category is the
 * empty string — there is nothing to label. Reserving axis space for it also
 * shortened the plot by ~25px, which broke alignment with sibling concat cells
 * (`concat_population_pyramid`'s age-label column rendered 355px tall against
 * its neighbours' 381px, so the labels no longer lined up with their bars).
 */
function syntheticBandAxis(channel: 'x' | 'y'): AxisResolution {
  const category = '';
  return {
    config: { id: `vega-${channel}`, scaleType: 'band', data: [category], position: 'none' },
    fieldType: 'nominal',
    categories: [category],
    categoryKeys: [categoryKey(category)],
    synthetic: true,
  };
}
