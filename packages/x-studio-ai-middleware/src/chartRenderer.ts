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

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
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

function renderBar(input: ChartRendererInput): string {
  const { title, data = [], colors = DEFAULT_COLORS } = input;
  const W = input.width ?? 600;
  const H = input.height ?? 400;

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

function renderLine(input: ChartRendererInput): string {
  const { title, data, xLabels: rawXLabels, series: rawSeries, colors = DEFAULT_COLORS } = input;
  const W = input.width ?? 600;
  const H = input.height ?? 400;

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

function renderPie(input: ChartRendererInput): string {
  const { title, data = [], colors = DEFAULT_COLORS } = input;
  const W = input.width ?? 600;
  const H = input.height ?? 400;

  const PAD = { top: title ? 50 : 20, right: 20, bottom: 20, left: 20 };
  const legendH = Math.ceil(data.length / 3) * 22 + 10;
  const pieH = H - PAD.top - PAD.bottom - legendH;
  const cx = W / 2;
  const cy = PAD.top + pieH / 2;
  const r = Math.min(W / 2 - 40, pieH / 2) * 0.9;

  const total = data.reduce((s, d) => s + d.value, 0);
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
    lines.push(
      `<path d="${arcPath(cx, cy, r, angle, angle + slice)}" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`,
    );

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

function renderScatter(input: ChartRendererInput): string {
  const { title, series: rawSeries, xLabels: rawXLabels, colors = DEFAULT_COLORS } = input;
  const W = input.width ?? 600;
  const H = input.height ?? 400;

  // Expect data as series with numeric values (x from xLabels, y from values)
  // or simple data[] where label is parsed as x and value is y.
  let points: { x: number; y: number; label?: string; seriesName?: string; color: string }[] = [];

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

  const PAD = { top: title ? 50 : 20, right: 20, bottom: 60, left: 60 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = niceMax(Math.max(...ys, 0));
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

function renderDonut(input: ChartRendererInput): string {
  const { title, data = [], colors = DEFAULT_COLORS } = input;
  const W = input.width ?? 600;
  const H = input.height ?? 400;

  const PAD = { top: title ? 50 : 20, right: 20, bottom: 20, left: 20 };
  const legendH = Math.ceil(data.length / 3) * 22 + 10;
  const pieH = H - PAD.top - PAD.bottom - legendH;
  const cx = W / 2;
  const cy = PAD.top + pieH / 2;
  const r = Math.min(W / 2 - 40, pieH / 2) * 0.9;
  const innerR = r * 0.45;

  const total = data.reduce((s, d) => s + d.value, 0);
  const svgLines: string[] = [];

  if (title) {
    svgLines.push(
      `<text x="${W / 2}" y="24" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`,
    );
  }

  // Slices with inner hole
  let angle = 0;
  data.forEach((d, i) => {
    if (d.value <= 0) return;
    const slice = (d.value / total) * 360;
    const fill = color(colors, i);

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
    `<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="16" font-weight="700" fill="#1a1a2e">${total.toLocaleString()}</text>`,
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

function renderStackedBar(input: ChartRendererInput): string {
  const { title, xLabels: rawXLabels, series: rawSeries, colors = DEFAULT_COLORS } = input;
  const W = input.width ?? 600;
  const H = input.height ?? 400;

  if (!rawSeries || !rawXLabels || rawSeries.length === 0 || rawXLabels.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="10" y="20" font-family="${FONT_FAMILY}" fill="red">stacked_bar requires xLabels and series.</text></svg>`;
  }

  const totals = rawXLabels.map((_, i) =>
    rawSeries.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const maxTotal = niceMax(Math.max(...totals, 0));

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
      const y = yBase - (stackBase + val) / maxTotal * chartH;
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
export function renderChartSvg(input: ChartRendererInput): string {
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
