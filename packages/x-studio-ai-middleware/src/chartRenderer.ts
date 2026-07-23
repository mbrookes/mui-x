/**
 * Pure-TypeScript SVG chart renderer for @mui/x-studio-ai-middleware.
 *
 * Generates standalone SVG markup without any DOM, React, or external dependencies.
 * Intended for server-side use (MCP tool, Node.js) where a browser is unavailable.
 *
 * Supported chart types: 'bar', 'line', 'pie'.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single data point for bar and pie charts, or a single-series line chart. */
export interface ChartDataPoint {
  label: string;
  value: number;
}

/** A named series for multi-series line charts. */
export interface ChartSeries {
  name: string;
  /** One value per x-axis label. */
  values: number[];
}

export type ChartType = 'bar' | 'line' | 'pie' | 'scatter' | 'donut' | 'stacked_bar';

export interface ChartRendererInput {
  /** Chart type. */
  type: ChartType;
  /** Optional title displayed above the chart. */
  title?: string;
  /**
   * Data points for bar and pie charts, or a single-series line chart.
   * For multi-series line charts use `xLabels` + `series` instead.
   */
  data?: ChartDataPoint[];
  /**
   * X-axis labels for multi-series line charts.
   * Must be provided when `series` is set.
   */
  xLabels?: string[];
  /**
   * Multiple named series for multi-series line charts.
   * Each series must have exactly `xLabels.length` values.
   */
  series?: ChartSeries[];
  /** SVG canvas width in pixels. Default: 600. */
  width?: number;
  /** SVG canvas height in pixels. Default: 400. */
  height?: number;
  /** Custom colour palette. Cycles through when there are more series than colours. */
  colors?: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_COLORS = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#bab0ac',
];

const FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

/** Default canvas dimensions, used when `width`/`height` are absent or invalid. */
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 400;
/** Upper bound for a sane canvas dimension; anything larger falls back to the default. */
const MAX_DIMENSION = 10000;
/** Strict hex-color pattern matching the `DEFAULT_COLORS` format (#rgb … #rrggbbaa). */
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Hard upper bound on the number of entries accepted in `render_chart`'s
 * `data` / `xLabels` / `series` arrays, and in each per-series `values` array
 * (Tier 3 finding 3). `renderChartSvg` already bounds dimensions and validates
 * colors/values/text (see `sanitizeDimension`/`sanitizeColors`/`sanitizeValue`/
 * `sanitizeText` above), but — unlike every other untrusted-array tool argument
 * in this package (`MAX_QUERY_ARRAY_LENGTH` in `mcp/queryTools.ts`,
 * `MAX_COMPUTE_FIELD_STATS_FIELDS`, the streaming buffer caps) — had no cap on
 * the NUMBER of entries. An unbounded array turns one tool call into unbounded
 * SVG-generation work (and an unbounded response payload) rather than the
 * bounded chart a legitimate call needs. Truncated (not rejected) at this single
 * `sanitizeInput` choke point so every renderer stays covered by one fix and a
 * caller still gets a chart back, just capped.
 */
const MAX_CHART_ARRAY_LENGTH = 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Coerce a caller-supplied dimension to a finite, positive, in-range number,
 * falling back to `fallback` otherwise. `width`/`height` are interpolated raw
 * into SVG attribute positions, so an unvalidated value is both a rendering
 * hazard and a markup-injection vector.
 */
function sanitizeDimension(value: number | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DIMENSION) {
    return fallback;
  }
  return n;
}

/**
 * Validate each palette entry against a strict hex pattern, replacing any entry
 * that does not match with the corresponding `DEFAULT_COLORS` value. Colors are
 * interpolated verbatim into SVG `fill`/`stroke` attributes, so a malformed
 * entry could break out of the attribute and inject markup (e.g. a `<script>`).
 * Bad entries are replaced individually so a partially-valid palette still works.
 */
function sanitizeColors(colors: string[] | undefined): string[] | undefined {
  // `colors` is declared `string[]` but is model-supplied and never validated at
  // runtime, so a non-array value (e.g. `"#fff"`) would throw inside `.map`. Treat any
  // non-array as absent so the renderers fall back to `DEFAULT_COLORS`, matching the
  // "coerce at one choke point" contract rather than throwing a raw `TypeError`.
  // An EMPTY array is likewise treated as absent: returning `[]` would slip past the
  // renderers' `colors = DEFAULT_COLORS` default (which only fires for `undefined`), and
  // then `color([], i)` → `[][NaN]` → `undefined` → `fill="undefined"`.
  if (!Array.isArray(colors) || colors.length === 0) {
    return undefined;
  }
  return colors.map((c, i) =>
    typeof c === 'string' && HEX_COLOR.test(c) ? c : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
  );
}

/**
 * Coerce a caller-supplied data value to a finite number, falling back to `0`.
 * `value` is declared `number` in the `render_chart` schema but is never
 * validated at runtime, so a string value would flow into `reduce`/coordinate
 * maps and — for the donut centre `total`, which is printed as text content —
 * inject arbitrary markup into the SVG. Coercing here, in the same choke point
 * that guards colors/dimensions, closes both the injection path and the
 * NaN-geometry hazard for every renderer at once.
 */
function sanitizeValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coerce a caller-supplied text value (label, series name, title, …) to a
 * string, falling back to `''` for `null`/`undefined`. `label`/`name` are
 * declared `string` in the `render_chart` schema but, like `value`, are never
 * validated at runtime — a model routinely emits a bare number (e.g. a year
 * `xLabels` entry) instead of a string. Every one of these values eventually
 * reaches `esc()`, which calls `.replace` and throws on a non-string, so
 * coercing here — at the same choke point that already guards
 * colors/dimensions/values — closes the gap for every renderer at once.
 */
function sanitizeText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Same as `sanitizeText`, but preserves `undefined` for optional fields like `title`. */
function sanitizeOptionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Rejects (throws, mirroring `renderChartSvg`'s own unknown-chart-type throw —
 * both are caught by every call site, e.g. `mcp/utilityTools.ts`'s `render_chart`
 * handler) an array argument longer than `MAX_CHART_ARRAY_LENGTH`, with the same
 * "split the request" guidance `MAX_QUERY_ARRAY_LENGTH` gives elsewhere in the
 * package (see `mcp/queryTools.ts`'s `validateQueryArrayArg`).
 */
function checkChartArrayLength(argName: string, length: number): void {
  if (length > MAX_CHART_ARRAY_LENGTH) {
    throw new Error(
      `MUI X Studio: render_chart received ${length} "${argName}" entries, which exceeds the ` +
        `limit of ${MAX_CHART_ARRAY_LENGTH}. Split the request into multiple calls of at most ` +
        `${MAX_CHART_ARRAY_LENGTH} ${argName} entries each.`,
    );
  }
}

function sanitizeData(data: ChartDataPoint[] | undefined): ChartDataPoint[] | undefined {
  // Non-array `data` (e.g. `{}`) would throw inside `.map`; coerce to absent so
  // renderers fall back to the "No data provided." placeholder.
  if (!Array.isArray(data)) {
    return undefined;
  }
  checkChartArrayLength('data', data.length);
  return data.map((d) => ({
    ...d,
    label: sanitizeText(d?.label),
    value: sanitizeValue(d?.value),
  }));
}

function sanitizeSeries(series: ChartSeries[] | undefined): ChartSeries[] | undefined {
  // Non-array `series` (e.g. `"x"`) would throw inside `.map`; coerce to absent.
  if (!Array.isArray(series)) {
    return undefined;
  }
  checkChartArrayLength('series', series.length);
  return series.map((s) => {
    const values = Array.isArray(s?.values) ? s.values : [];
    checkChartArrayLength('series[].values', values.length);
    return {
      ...s,
      name: sanitizeText(s?.name),
      values: values.map(sanitizeValue),
    };
  });
}

/**
 * Coerce every `xLabels` entry to a string (mirrors `sanitizeData`'s `label`
 * handling). Non-array `xLabels` (e.g. a bare string) would throw inside
 * `.map`; coerce to absent so renderers fall back to their "No data"/
 * "requires xLabels" placeholder, matching `colors`/`data`/`series`.
 */
function sanitizeXLabels(xLabels: string[] | undefined): string[] | undefined {
  if (!Array.isArray(xLabels)) {
    return undefined;
  }
  checkChartArrayLength('xLabels', xLabels.length);
  return xLabels.map(sanitizeText);
}

/**
 * The shape a renderer receives after `sanitizeInput`: `width`/`height` are
 * guaranteed finite numbers (never `undefined`), so renderers read them directly
 * without a `?? DEFAULT` fallback.
 */
type SanitizedChartInput = ChartRendererInput & { width: number; height: number };

/**
 * Validate/coerce the untrusted, model-supplied portions of the input
 * (`width`, `height`, `colors`, every numeric `value`, and every text field —
 * `title`, data `label`s, series `name`s, `xLabels`) before any renderer
 * interpolates them into SVG markup. Coercing text here means every text
 * value reaching `esc()` is already guaranteed to be a string, so `esc()`
 * itself never has to guard against a non-string input.
 */
function sanitizeInput(input: ChartRendererInput): SanitizedChartInput {
  return {
    ...input,
    title: sanitizeOptionalText(input.title),
    width: sanitizeDimension(input.width, DEFAULT_WIDTH),
    height: sanitizeDimension(input.height, DEFAULT_HEIGHT),
    colors: sanitizeColors(input.colors),
    data: sanitizeData(input.data),
    series: sanitizeSeries(input.series),
    xLabels: sanitizeXLabels(input.xLabels),
  };
}

/**
 * Escape text content for safe interpolation into SVG markup.
 *
 * All text reaching this function should already be a string thanks to the
 * `sanitizeInput` choke point (`title`/`label`/`name`/`xLabels` entries are
 * all coerced there). This accepts `unknown` and coerces defensively anyway
 * — `.replace` throws on a non-string, so any call site that bypasses the
 * choke point (or a future one that forgets to) fails safe (empty string)
 * instead of throwing and failing the whole render.
 */
function esc(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function color(colors: string[], idx: number): string {
  return colors[idx % colors.length];
}

function nice(n: number): number {
  if (n === 0) {
    return 1;
  }
  const exp = Math.pow(10, Math.floor(Math.log10(Math.abs(n))));
  const frac = n / exp;
  if (frac <= 1) {
    return exp;
  }
  if (frac <= 2) {
    return 2 * exp;
  }
  if (frac <= 5) {
    return 5 * exp;
  }
  return 10 * exp;
}

/** Round a max value up to a "nice" tick ceiling. */
function niceMax(rawMax: number, tickCount = 5): number {
  const step = nice(rawMax / tickCount);
  return Math.ceil(rawMax / step) * step;
}

function ticks(max: number, count = 5): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round(step * i * 100) / 100);
}

// ── Bar chart ─────────────────────────────────────────────────────────────────

function renderBar(input: SanitizedChartInput): string {
  const { title, data = [], colors = DEFAULT_COLORS } = input;
  const W = input.width;
  const H = input.height;

  // Guard against empty / all-non-positive data: with maxVal === 0 every bar's
  // geometry becomes `v / 0` → NaN. Render a placeholder like line/stacked_bar do.
  if (data.length === 0 || !data.some((d) => d.value > 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const PAD = { top: title ? 50 : 20, right: 20, bottom: 60, left: 60 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const maxVal = niceMax(Math.max(...data.map((d) => d.value), 0));
  const tickValues = ticks(maxVal);

  const barPad = 0.2;
  const totalBars = data.length;
  const barW = (chartW / totalBars) * (1 - barPad);
  const barGap = (chartW / totalBars) * barPad;

  const xOf = (i: number) => PAD.left + (chartW / totalBars) * i + barGap / 2;
  const yOf = (v: number) => PAD.top + chartH - (v / maxVal) * chartH;

  const lines: string[] = [];

  // ── Title
  if (title) {
    lines.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`,
    );
  }

  // ── Y axis gridlines + tick labels
  for (const tv of tickValues) {
    const y = yOf(tv);
    lines.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#e0e0e0" stroke-dasharray="4 3"/>`,
      `<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${tv}</text>`,
    );
  }

  // ── Bars
  data.forEach((d, i) => {
    const x = xOf(i);
    const barH = (d.value / maxVal) * chartH;
    const y = PAD.top + chartH - barH;
    const fill = color(colors, i);
    lines.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${fill}" rx="2"/>`,
    );

    // Value label on top of bar
    if (barH > 16) {
      lines.push(
        `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="10" fill="#333">${d.value}</text>`,
      );
    }

    // X label
    const labelY = PAD.top + chartH + 18;
    lines.push(
      `<text x="${(x + barW / 2).toFixed(1)}" y="${labelY}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(String(d.label))}</text>`,
    );
  });

  // ── Axes
  lines.push(
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="#aaa" stroke-width="1"/>`,
    `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="#aaa" stroke-width="1"/>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${lines.join('\n')}\n</svg>`;
}

// ── Line chart ────────────────────────────────────────────────────────────────

function renderLine(input: SanitizedChartInput): string {
  const { title, data, xLabels: rawXLabels, series: rawSeries, colors = DEFAULT_COLORS } = input;
  const W = input.width;
  const H = input.height;

  // Normalise: single-series (data) or multi-series (xLabels + series)
  let xLabels: string[];
  let allSeries: ChartSeries[];

  if (rawSeries && rawXLabels) {
    xLabels = rawXLabels;
    allSeries = rawSeries;
  } else if (data && data.length > 0) {
    xLabels = data.map((d) => String(d.label));
    allSeries = [{ name: title ?? 'Value', values: data.map((d) => d.value) }];
  } else {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const hasLegend = allSeries.length > 1;
  const legendH = hasLegend ? 24 : 0;
  const PAD = { top: title ? 50 : 20, right: 20, bottom: 60 + legendH, left: 60 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const allValues = allSeries.flatMap((s) => s.values);
  const maxVal = niceMax(Math.max(...allValues, 0));

  // Guard against empty / all-non-positive values: with no positive value
  // `maxVal` is 0, so every `yOf(v)` computes `v / 0` → NaN and the whole SVG
  // fills with `y1="NaN"` gridlines/points (BOTH the multi-series and
  // single-series paths reach here). Render the same "No data provided."
  // placeholder bar/donut/scatter use (finding 2.2).
  if (maxVal <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const tickValues = ticks(maxVal);

  const xOf = (i: number) => PAD.left + (i / Math.max(xLabels.length - 1, 1)) * chartW;
  const yOf = (v: number) => PAD.top + chartH - (v / maxVal) * chartH;

  const lines: string[] = [];

  // ── Title
  if (title) {
    lines.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`,
    );
  }

  // ── Y gridlines + tick labels
  for (const tv of tickValues) {
    const y = yOf(tv);
    lines.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#e0e0e0" stroke-dasharray="4 3"/>`,
      `<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${tv}</text>`,
    );
  }

  // ── Series polylines
  allSeries.forEach((s, si) => {
    const fill = color(colors, si);
    const pts = s.values.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
    lines.push(
      `<polyline points="${pts}" fill="none" stroke="${fill}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
    );

    // Dots
    s.values.forEach((v, i) => {
      lines.push(
        `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.5" fill="${fill}"/>`,
      );
    });
  });

  // ── X axis labels
  xLabels.forEach((lbl, i) => {
    if (xLabels.length <= 20 || i % Math.ceil(xLabels.length / 20) === 0) {
      lines.push(
        `<text x="${xOf(i).toFixed(1)}" y="${PAD.top + chartH + 18}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(lbl)}</text>`,
      );
    }
  });

  // ── Axes
  lines.push(
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="#aaa" stroke-width="1"/>`,
    `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="#aaa" stroke-width="1"/>`,
  );

  // ── Legend (multi-series only)
  if (hasLegend) {
    const legendY = H - legendH + 6;
    let legendX = PAD.left;
    allSeries.forEach((s, si) => {
      const fill = color(colors, si);
      lines.push(
        `<rect x="${legendX}" y="${legendY}" width="12" height="12" fill="${fill}" rx="2"/>`,
        `<text x="${legendX + 16}" y="${legendY + 10}" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(s.name)}</text>`,
      );
      legendX += 16 + s.name.length * 7 + 16;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${lines.join('\n')}\n</svg>`;
}

// ── Pie chart ─────────────────────────────────────────────────────────────────

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const start = polarToCartesian(cx, cy, r, endDeg);
  const end = polarToCartesian(cx, cy, r, startDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

function renderPie(input: SanitizedChartInput): string {
  const { title, data = [], colors = DEFAULT_COLORS } = input;
  const W = input.width;
  const H = input.height;

  // Guard against empty / all-non-positive data (mirrors renderDonut): with no
  // positive slice `total` is 0, every `d.value / total` is NaN, and the chart body
  // renders blank. Emit the same "No data provided." placeholder the other renderers
  // use so renderPie has parity (finding T3-2).
  if (data.length === 0 || !data.some((d) => d.value > 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const PAD = { top: title ? 50 : 20, right: 20, bottom: 20, left: 20 };
  const legendH = Math.ceil(data.length / 3) * 22 + 10;
  const pieH = H - PAD.top - PAD.bottom - legendH;
  const cx = W / 2;
  const cy = PAD.top + pieH / 2;
  const r = Math.min(W / 2 - 40, pieH / 2) * 0.9;

  // Sum only POSITIVE values. Non-positive slices are skipped below anyway, but a
  // mixed-sign dataset whose negatives drag `total` to <= 0 (while a positive
  // slice exists) made `slice = (d.value / total) * 360` Infinity/negative, so
  // `polarToCartesian(∞)` produced NaN path coordinates (finding 2.2). Summing
  // positives keeps `total` a positive denominator that the drawn slices sum into.
  const total = data.reduce((s, d) => (d.value > 0 ? s + d.value : s), 0);
  const lines: string[] = [];

  // ── Title
  if (title) {
    lines.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`,
    );
  }

  // ── Slices
  let angle = 0;
  data.forEach((d, i) => {
    if (d.value <= 0) {
      return;
    }
    const slice = (d.value / total) * 360;
    const fill = color(colors, i);
    if (slice >= 359.999) {
      // Single (or effectively-360°) slice: an arc whose start and end points
      // coincide collapses to nothing after `.toFixed` rounding, so the SVG drops
      // it and the chart body renders blank while the label/legend still show
      // (finding 3.2). Emit a full circle instead.
      lines.push(
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`,
      );
    } else {
      lines.push(
        `<path d="${arcPath(cx, cy, r, angle, angle + slice)}" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`,
      );
    }

    // Percentage label inside slice (only if slice is large enough)
    if (slice > 20) {
      const midAngle = angle + slice / 2;
      const lp = polarToCartesian(cx, cy, r * 0.6, midAngle);
      const pct = Math.round((d.value / total) * 100);
      lines.push(
        `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="${FONT_FAMILY}" font-size="12" font-weight="600" fill="#fff">${pct}%</text>`,
      );
    }
    angle += slice;
  });

  // ── Legend
  const legendY = cy + r + 20;
  const itemsPerRow = 3;
  const itemW = W / itemsPerRow;
  data.forEach((d, i) => {
    const col = i % itemsPerRow;
    const row = Math.floor(i / itemsPerRow);
    const lx = col * itemW + 16;
    const ly = legendY + row * 22;
    const fill = color(colors, i);
    const pct = total > 0 ? ` (${Math.round((d.value / total) * 100)}%)` : '';
    lines.push(
      `<rect x="${lx}" y="${ly}" width="12" height="12" fill="${fill}" rx="2"/>`,
      `<text x="${lx + 16}" y="${ly + 10}" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(String(d.label))}${esc(pct)}</text>`,
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${lines.join('\n')}\n</svg>`;
}

// ── Scatter chart ─────────────────────────────────────────────────────────────

function renderScatter(input: SanitizedChartInput): string {
  const { title, series: rawSeries, xLabels: rawXLabels, colors = DEFAULT_COLORS } = input;
  const W = input.width;
  const H = input.height;

  // Expect data as series with numeric values (x from xLabels, y from values)
  // or simple data[] where label is parsed as x and value is y.
  const points: { x: number; y: number; label?: string; seriesName?: string; color: string }[] = [];

  if (rawSeries && rawXLabels) {
    rawSeries.forEach((s, si) => {
      s.values.forEach((y, i) => {
        const x = parseFloat(rawXLabels[i]);
        if (!Number.isNaN(x)) {
          points.push({ x, y, label: rawXLabels[i], seriesName: s.name, color: color(colors, si) });
        }
      });
    });
  } else if (input.data) {
    input.data.forEach((d, i) => {
      const x = parseFloat(String(d.label));
      if (!Number.isNaN(x)) {
        points.push({ x, y: d.value, label: String(d.label), color: color(colors, i) });
      } else {
        // label is not numeric — use index as x
        points.push({ x: i, y: d.value, label: String(d.label), color: color(colors, 0) });
      }
    });
  }

  // Guard against empty input: with no usable points, `Math.min()`/`Math.max()` are
  // ±Infinity and `niceMax(0)` is 0, so every `py(tv)` computes `tv / 0` → NaN and the
  // gridline/tick attributes come out as `y1="NaN"`. Render the same "No data provided."
  // placeholder that bar/line/donut/stacked_bar use (finding 2.2).
  if (points.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const PAD = { top: title ? 50 : 20, right: 20, bottom: 60, left: 60 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = niceMax(Math.max(...ys, 0));

  // Guard against all-non-positive y values (e.g. a single `{ value: 0 }`
  // point): `yMax` is 0, so every `py(y)` computes `y / 0` → NaN and the
  // gridline/tick/point attributes come out as `NaN`. Render the same "No data
  // provided." placeholder the empty-`points` branch above uses (finding 2.2).
  if (yMax <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const xRange = xMax - xMin || 1;

  const px = (x: number) => PAD.left + ((x - xMin) / xRange) * chartW;
  const py = (y: number) => PAD.top + chartH - (y / yMax) * chartH;

  const tickY = ticks(yMax);
  const svgLines: string[] = [];

  if (title) {
    svgLines.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`,
    );
  }

  for (const tv of tickY) {
    const y = py(tv);
    svgLines.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#e0e0e0" stroke-dasharray="4 3"/>`,
      `<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${tv}</text>`,
    );
  }

  for (const p of points) {
    svgLines.push(
      `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="5" fill="${p.color}" fill-opacity="0.75" stroke="${p.color}" stroke-width="1"/>`,
    );
  }

  svgLines.push(
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="#aaa" stroke-width="1"/>`,
    `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="#aaa" stroke-width="1"/>`,
  );

  // Legend for multi-series
  const seriesNames = rawSeries?.map((s, i) => ({ name: s.name, color: color(colors, i) }));
  if (seriesNames && seriesNames.length > 1) {
    let lx = PAD.left;
    const ly = H - 18;
    for (const s of seriesNames) {
      svgLines.push(
        `<circle cx="${lx + 6}" cy="${ly}" r="5" fill="${s.color}"/>`,
        `<text x="${lx + 16}" y="${ly + 4}" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(s.name)}</text>`,
      );
      lx += 16 + s.name.length * 7 + 16;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${svgLines.join('\n')}\n</svg>`;
}

// ── Donut chart ───────────────────────────────────────────────────────────────

function renderDonut(input: SanitizedChartInput): string {
  const { title, data = [], colors = DEFAULT_COLORS } = input;
  const W = input.width;
  const H = input.height;

  // Guard against empty / all-non-positive data: total === 0 makes every slice's
  // `value / total` NaN. Render a placeholder like line/stacked_bar do.
  if (data.length === 0 || !data.some((d) => d.value > 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const PAD = { top: title ? 50 : 20, right: 20, bottom: 20, left: 20 };
  const legendH = Math.ceil(data.length / 3) * 22 + 10;
  const pieH = H - PAD.top - PAD.bottom - legendH;
  const cx = W / 2;
  const cy = PAD.top + pieH / 2;
  const r = Math.min(W / 2 - 40, pieH / 2) * 0.9;
  const innerR = r * 0.45;

  // Sum only POSITIVE values (mirrors renderPie): non-positive slices are skipped
  // below, and a mixed-sign dataset whose negatives drag `total` to <= 0 while a
  // positive slice exists made `slice = (d.value / total) * 360` Infinity/negative
  // → NaN arc coordinates (finding 2.2). The all-non-positive case is already
  // handled by the placeholder guard above, so `total` here is always positive.
  const total = data.reduce((s, d) => (d.value > 0 ? s + d.value : s), 0);
  const svgLines: string[] = [];

  if (title) {
    svgLines.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`,
    );
  }

  // Slices with inner hole
  let angle = 0;
  data.forEach((d, i) => {
    if (d.value <= 0) {
      return;
    }
    const slice = (d.value / total) * 360;
    const fill = color(colors, i);

    if (slice >= 359.999) {
      // Single (or effectively-360°) slice: a wedge path whose start and end points
      // coincide collapses to nothing after `.toFixed` rounding, blanking the chart
      // body while the label/legend still show (finding 3.2). Emit a full ring (two
      // semicircle arcs, `fill-rule="evenodd"` punches the donut hole) instead.
      const oTop = polarToCartesian(cx, cy, r, 0);
      const oBot = polarToCartesian(cx, cy, r, 180);
      const iTop = polarToCartesian(cx, cy, innerR, 0);
      const iBot = polarToCartesian(cx, cy, innerR, 180);
      const ring =
        `M ${oTop.x.toFixed(2)} ${oTop.y.toFixed(2)} ` +
        `A ${r} ${r} 0 1 1 ${oBot.x.toFixed(2)} ${oBot.y.toFixed(2)} ` +
        `A ${r} ${r} 0 1 1 ${oTop.x.toFixed(2)} ${oTop.y.toFixed(2)} Z ` +
        `M ${iTop.x.toFixed(2)} ${iTop.y.toFixed(2)} ` +
        `A ${innerR} ${innerR} 0 1 1 ${iBot.x.toFixed(2)} ${iBot.y.toFixed(2)} ` +
        `A ${innerR} ${innerR} 0 1 1 ${iTop.x.toFixed(2)} ${iTop.y.toFixed(2)} Z`;
      svgLines.push(
        `<path d="${ring}" fill="${fill}" fill-rule="evenodd" stroke="#fff" stroke-width="1.5"/>`,
      );
    } else {
      const outerStart = polarToCartesian(cx, cy, r, angle + slice);
      const outerEnd = polarToCartesian(cx, cy, r, angle);
      const innerStart = polarToCartesian(cx, cy, innerR, angle + slice);
      const innerEnd = polarToCartesian(cx, cy, innerR, angle);
      const largeArc = slice > 180 ? 1 : 0;

      const path =
        `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)} ` +
        `A ${r} ${r} 0 ${largeArc} 0 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)} ` +
        `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)} ` +
        `A ${innerR} ${innerR} 0 ${largeArc} 1 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)} Z`;

      svgLines.push(`<path d="${path}" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`);
    }

    if (slice > 20) {
      const midAngle = angle + slice / 2;
      const lp = polarToCartesian(cx, cy, (r + innerR) / 2, midAngle);
      const pct = Math.round((d.value / total) * 100);
      svgLines.push(
        `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="${FONT_FAMILY}" font-size="11" font-weight="600" fill="#fff">${pct}%</text>`,
      );
    }
    angle += slice;
  });

  // Total label in center
  svgLines.push(
    `<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#888">Total</text>`,
    // `total` is a coerced finite number (see sanitizeValue), so `toLocaleString()`
    // yields only digits/grouping separators; `esc()` is defense-in-depth for the
    // one value-derived number printed as SVG text content.
    `<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="700" fill="#1a1a2e">${esc(total.toLocaleString())}</text>`,
  );

  // Legend
  const legendY = cy + r + 20;
  const itemsPerRow = 3;
  const itemW = W / itemsPerRow;
  data.forEach((d, i) => {
    const col = i % itemsPerRow;
    const row = Math.floor(i / itemsPerRow);
    const lx = col * itemW + 16;
    const ly = legendY + row * 22;
    const fill = color(colors, i);
    const pct = total > 0 ? ` (${Math.round((d.value / total) * 100)}%)` : '';
    svgLines.push(
      `<rect x="${lx}" y="${ly}" width="12" height="12" fill="${fill}" rx="2"/>`,
      `<text x="${lx + 16}" y="${ly + 10}" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(String(d.label))}${esc(pct)}</text>`,
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${svgLines.join('\n')}\n</svg>`;
}

// ── Stacked bar chart ─────────────────────────────────────────────────────────

function renderStackedBar(input: SanitizedChartInput): string {
  const { title, xLabels: rawXLabels, series: rawSeries, colors = DEFAULT_COLORS } = input;
  const W = input.width;
  const H = input.height;

  if (!rawSeries || !rawXLabels || rawSeries.length === 0 || rawXLabels.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">stacked_bar requires xLabels and series.</text></svg>`;
  }

  const totals = rawXLabels.map((_, i) =>
    rawSeries.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const maxTotal = niceMax(Math.max(...totals, 0));

  // Guard against all-zero / all-non-positive stacks: `maxTotal` is 0, so every
  // tick's `(tv / maxTotal) * chartH` and every bar's `(val / maxTotal) * chartH`
  // is NaN. Render the same "No data provided." placeholder the other renderers
  // use (finding 2.2) rather than the "requires xLabels and series" message,
  // which is reserved for genuinely missing series above.
  if (maxTotal <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">No data provided.</text></svg>`;
  }

  const hasLegend = rawSeries.length > 0;
  const legendH = hasLegend ? 24 : 0;
  const PAD = { top: title ? 50 : 20, right: 20, bottom: 60 + legendH, left: 60 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const barPad = 0.2;
  const barW = (chartW / rawXLabels.length) * (1 - barPad);
  const barGap = (chartW / rawXLabels.length) * barPad;
  const xOf = (i: number) => PAD.left + (chartW / rawXLabels.length) * i + barGap / 2;
  const yBase = PAD.top + chartH;

  const tickValues = ticks(maxTotal);
  const svgLines: string[] = [];

  if (title) {
    svgLines.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`,
    );
  }

  for (const tv of tickValues) {
    const y = yBase - (tv / maxTotal) * chartH;
    svgLines.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#e0e0e0" stroke-dasharray="4 3"/>`,
      `<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${tv}</text>`,
    );
  }

  rawXLabels.forEach((lbl, i) => {
    let stackBase = 0;
    rawSeries.forEach((s, si) => {
      const val = s.values[i] ?? 0;
      if (val <= 0) {
        stackBase += val;
        return;
      }
      const barH = (val / maxTotal) * chartH;
      const x = xOf(i);
      const y = yBase - ((stackBase + val) / maxTotal) * chartH;
      svgLines.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color(colors, si)}" rx="1"/>`,
      );
      stackBase += val;
    });

    const labelY = yBase + 18;
    svgLines.push(
      `<text x="${(xOf(i) + barW / 2).toFixed(1)}" y="${labelY}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(String(lbl))}</text>`,
    );
  });

  svgLines.push(
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${yBase}" stroke="#aaa" stroke-width="1"/>`,
    `<line x1="${PAD.left}" y1="${yBase}" x2="${PAD.left + chartW}" y2="${yBase}" stroke="#aaa" stroke-width="1"/>`,
  );

  if (hasLegend) {
    const legendY = H - legendH + 6;
    let legendX = PAD.left;
    rawSeries.forEach((s, si) => {
      const fill = color(colors, si);
      svgLines.push(
        `<rect x="${legendX}" y="${legendY}" width="12" height="12" fill="${fill}" rx="2"/>`,
        `<text x="${legendX + 16}" y="${legendY + 10}" font-family="${FONT_FAMILY}" font-size="11" fill="#555">${esc(s.name)}</text>`,
      );
      legendX += 16 + s.name.length * 7 + 16;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${svgLines.join('\n')}\n</svg>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Renders a chart to a standalone SVG string.
 *
 * Works in Node.js without a DOM or React — suitable for MCP tool handlers,
 * CLI utilities, and other server-side contexts.
 *
 * @example
 * ```ts
 * const svg = renderChartSvg({
 *   type: 'bar',
 *   title: 'Revenue by Country',
 *   data: [
 *     { label: 'USA', value: 1234 },
 *     { label: 'UK',  value: 567  },
 *   ],
 * });
 * ```
 */
export function renderChartSvg(rawInput: ChartRendererInput): string {
  // Validate/coerce the untrusted attribute-position fields (width/height/colors)
  // at this single choke point so every chart-type renderer is covered by one fix.
  const input = sanitizeInput(rawInput);
  switch (input.type) {
    case 'bar':
      return renderBar(input);
    case 'line':
      return renderLine(input);
    case 'pie':
      return renderPie(input);
    case 'scatter':
      return renderScatter(input);
    case 'donut':
      return renderDonut(input);
    case 'stacked_bar':
      return renderStackedBar(input);
    default: {
      const never: never = input.type;
      throw new Error(
        `MUI X Studio: Unknown chart type "${never}". Supported types: bar, line, pie, scatter, donut, stacked_bar.`,
      );
    }
  }
}
