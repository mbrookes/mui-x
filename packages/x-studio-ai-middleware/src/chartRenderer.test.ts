/* eslint-disable testing-library/render-result-naming-convention */
import { describe, it, expect } from 'vitest';
import { renderChartSvg } from './chartRenderer';

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
