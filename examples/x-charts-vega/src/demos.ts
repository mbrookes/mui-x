import { feature as topojsonFeature } from 'topojson-client';
import worldTopology from 'visionscarto-world-atlas/world/110m.json';
import type { DatasetRow, VegaLiteSpec } from '@mui/x-charts-vega';

/**
 * Shared rows for the cartesian demos: monthly revenue by product category
 * and region. Deliberately un-aggregated (multiple rows per category/month)
 * so the "aggregate: sum" demos exercise the wrapper's inline aggregation
 * transform, not just pass-through rows.
 */
export const salesRows: DatasetRow[] = [
  { month: 'Jan', category: 'Electronics', region: 'West', revenue: 4200, units: 120 },
  { month: 'Jan', category: 'Electronics', region: 'East', revenue: 3100, units: 95 },
  { month: 'Jan', category: 'Apparel', region: 'West', revenue: 2400, units: 210 },
  { month: 'Jan', category: 'Apparel', region: 'East', revenue: 1800, units: 160 },
  { month: 'Feb', category: 'Electronics', region: 'West', revenue: 4600, units: 130 },
  { month: 'Feb', category: 'Electronics', region: 'East', revenue: 3400, units: 100 },
  { month: 'Feb', category: 'Apparel', region: 'West', revenue: 2100, units: 190 },
  { month: 'Feb', category: 'Apparel', region: 'East', revenue: 2000, units: 175 },
  { month: 'Mar', category: 'Electronics', region: 'West', revenue: 5100, units: 145 },
  { month: 'Mar', category: 'Electronics', region: 'East', revenue: 3700, units: 108 },
  { month: 'Mar', category: 'Apparel', region: 'West', revenue: 2600, units: 225 },
  { month: 'Mar', category: 'Apparel', region: 'East', revenue: 2200, units: 180 },
  { month: 'Apr', category: 'Electronics', region: 'West', revenue: 4900, units: 138 },
  { month: 'Apr', category: 'Electronics', region: 'East', revenue: 3900, units: 112 },
  { month: 'Apr', category: 'Apparel', region: 'West', revenue: 2750, units: 230 },
  { month: 'Apr', category: 'Apparel', region: 'East', revenue: 2050, units: 170 },
];

/**
 * Rows for the scatter demo: one point per (units, revenue) sample, derived
 * from salesRows so the two datasets cannot drift apart.
 */
export const scatterRows: DatasetRow[] = salesRows.map(({ units, revenue, region }) => ({
  units,
  revenue,
  region,
}));

/** Rows for the donut demo: market share by category. */
export const shareRows: DatasetRow[] = [
  { category: 'Electronics', share: 42 },
  { category: 'Apparel', share: 28 },
  { category: 'Home', share: 18 },
  { category: 'Other', share: 12 },
];

/** Rows for the heatmap demo: activity by weekday/daypart. */
export const activityRows: DatasetRow[] = (() => {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const parts = ['Morning', 'Afternoon', 'Evening'];
  const rows: DatasetRow[] = [];
  days.forEach((day, dayIndex) => {
    parts.forEach((part, partIndex) => {
      rows.push({
        day,
        part,
        visits: 20 + dayIndex * 7 + partIndex * 13 + ((dayIndex * partIndex) % 5) * 9,
      });
    });
  });
  return rows;
})();

/** Rows for the ranged-bar demo: daily temperature spans. */
export const temperatureRows: DatasetRow[] = [
  { day: 'Mon', low: 8, high: 17 },
  { day: 'Tue', low: 10, high: 21 },
  { day: 'Wed', low: 12, high: 24 },
  { day: 'Thu', low: 9, high: 19 },
  { day: 'Fri', low: 6, high: 14 },
];

/** Planar (shoelace) area of a single lon/lat ring, in square degrees. */
function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

/** Rough relative area of a Polygon / MultiPolygon geometry (exterior rings). */
function geometryArea(geometry: { type: string; coordinates: unknown }): number {
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as number[][][];
    return rings.length > 0 ? ringArea(rings[0]) : 0;
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates as number[][][][];
    return polys.reduce((total, poly) => total + (poly.length > 0 ? ringArea(poly[0]) : 0), 0);
  }
  return 0;
}

/**
 * Real-world choropleth data: the 110m world-atlas countries (converted from
 * TopoJSON via `topojson-client`, exactly as the Charts docs do), each tagged
 * with a rough `area` metric baked into `feature.properties`. Coloring every
 * country by its relative land area needs no external dataset and fills the
 * whole map, so the result reads unmistakably as a world map. `Math.sqrt`
 * compresses the enormous area range (Russia vs. a small island) into a
 * legible color spread.
 */
export const worldFeatures: DatasetRow[] = (() => {
  const collection = topojsonFeature(worldTopology as never, 'countries' as never) as unknown as {
    features: Array<{
      type: 'Feature';
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
  };
  return collection.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      area: Math.round(Math.sqrt(geometryArea(feature.geometry))),
    },
  })) as unknown as DatasetRow[];
})();

/**
 * Rows for the boxplot demos: several revenue samples per category, each split
 * into two regions. Six categories keep the single box plot from looking bare
 * and give the grouped (color-split) variant enough dodged boxes to read.
 */
export const distributionRows: DatasetRow[] = (() => {
  const bases: Array<[string, number]> = [
    ['Electronics', 4600],
    ['Apparel', 2500],
    ['Home', 3300],
    ['Sports', 2900],
    ['Books', 1700],
    ['Toys', 2100],
  ];
  const spreads = [-0.32, -0.12, 0.05, 0.28];
  const rows: DatasetRow[] = [];
  bases.forEach(([category, base], ci) => {
    ['West', 'East'].forEach((region, ri) => {
      const center = base + (ri === 0 ? 250 : -250);
      spreads.forEach((factor, si) => {
        rows.push({
          category,
          region,
          revenue: Math.round(center * (1 + factor * 0.35) + ((ci + si) % 3) * 80),
        });
      });
    });
  });
  return rows;
})();

/**
 * Rows for the continuous-time-scale demo: daily active users over an
 * irregular set of ISO dates, so the time axis must space points by their
 * real temporal distance rather than treating them as ordinal categories.
 */
export const timeSeriesRows: DatasetRow[] = [
  { date: '2024-01-01', users: 120 },
  { date: '2024-01-08', users: 145 },
  { date: '2024-01-10', users: 138 },
  { date: '2024-01-24', users: 190 },
  { date: '2024-02-05', users: 210 },
  { date: '2024-02-19', users: 265 },
  { date: '2024-03-01', users: 240 },
];

/**
 * Rows for the regression demo: a noisy but upward relationship between ad
 * spend and conversions, so the `regression` transform fits a visible trend.
 */
export const spendRows: DatasetRow[] = [
  { spend: 10, conversions: 22 },
  { spend: 15, conversions: 30 },
  { spend: 20, conversions: 35 },
  { spend: 25, conversions: 48 },
  { spend: 30, conversions: 52 },
  { spend: 35, conversions: 67 },
  { spend: 40, conversions: 71 },
  { spend: 45, conversions: 85 },
];

/**
 * Rows for the error-band demo: real Amazon (AMZN) daily closing prices grouped
 * by month (Aug 2023 – Jul 2024), copied from the Charts docs' AMZN dataset.
 * Each month's daily closes feed the error band (real intra-month volatility),
 * and the mean line is the monthly average close — a genuinely natural series.
 */
export const amznRows: DatasetRow[] = (() => {
  const monthlyCloses: Array<[string, number[]]> = [
    [
      "Aug '23",
      [
        131.69, 128.21, 128.91, 139.57, 142.22, 139.94, 137.85, 138.56, 138.41, 140.57, 137.67,
        135.07, 133.98, 133.22, 134.68, 134.25, 135.52, 131.84, 133.26, 133.14, 134.91, 135.07,
        138.01,
      ],
    ],
    [
      "Sep '23",
      [
        138.12, 137.27, 135.36, 137.85, 138.23, 143.1, 141.23, 144.85, 144.72, 140.39, 139.98,
        137.63, 135.29, 129.33, 129.12, 131.27, 125.98, 125.98, 125.98, 127.12,
      ],
    ],
    [
      "Oct '23",
      [
        129.46, 124.72, 127, 125.96, 127.96, 128.26, 129.48, 131.83, 132.33, 129.79, 132.55, 131.47,
        128.13, 128.4, 125.17, 126.56, 128.56, 121.39, 119.57, 127.74, 132.71, 133.09,
      ],
    ],
    [
      "Nov '23",
      [
        137, 138.07, 138.6, 139.74, 142.71, 142.08, 140.6, 143.56, 142.59, 145.8, 143.2, 142.83,
        145.18, 146.13, 143.9, 146.71, 146.74, 147.73, 147.03, 146.32, 146.09,
      ],
    ],
    [
      "Dec '23",
      [
        147.03, 144.84, 146.88, 144.52, 146.88, 147.42, 145.89, 147.48, 148.84, 147.42, 149.97,
        154.07, 153.79, 152.12, 153.84, 153.42, 153.41, 153.34, 153.38, 151.94,
      ],
    ],
    [
      "Jan '24",
      [
        149.93, 148.47, 144.57, 145.24, 149.1, 151.37, 153.73, 155.18, 154.62, 153.16, 151.71,
        153.5, 155.34, 154.78, 156.02, 156.87, 157.75, 159.12, 161.26, 159, 155.2,
      ],
    ],
    [
      "Feb '24",
      [
        159.28, 171.81, 170.31, 169.15, 170.53, 169.84, 174.45, 172.34, 168.64, 170.98, 169.8,
        169.51, 167.08, 168.59, 174.58, 174.99, 174.73, 173.54, 173.16, 176.76,
      ],
    ],
    [
      "Mar '24",
      [
        178.22, 177.58, 174.12, 173.51, 176.82, 175.35, 171.96, 175.39, 176.56, 178.75, 174.42,
        174.48, 175.9, 178.15, 178.15, 178.87, 179.71, 178.3, 179.83, 180.38,
      ],
    ],
    [
      "Apr '24",
      [
        180.97, 180.69, 182.41, 180, 185.07, 185.19, 185.67, 185.95, 189.05, 186.13, 183.62, 183.32,
        181.28, 179.22, 174.63, 177.23, 179.54, 176.59, 173.67, 179.62, 180.96, 175,
      ],
    ],
    [
      "May '24",
      [
        179, 184.72, 186.21, 188.7, 188.76, 188, 189.5, 187.48, 186.57, 187.07, 185.99, 183.63,
        184.7, 183.54, 183.15, 183.13, 181.05, 180.75, 182.15, 182.02, 179.32, 176.44,
      ],
    ],
    [
      "Jun '24",
      [
        178.34, 179.34, 181.28, 185, 184.3, 187.06, 187.23, 186.89, 183.83, 183.66, 184.06, 182.81,
        186.1, 189.08, 185.57, 186.34, 193.61, 197.85, 193.25,
      ],
    ],
    [
      "Jul '24",
      [
        197.2, 200, 197.59, 200, 199.29, 199.34, 199.79, 195.05, 194.49, 192.72, 193.02, 187.93,
        183.75, 183.13, 182.55,
      ],
    ],
  ];
  const rows: DatasetRow[] = [];
  monthlyCloses.forEach(([month, closes]) => {
    closes.forEach((close) => rows.push({ month, close }));
  });
  return rows;
})();

export interface Demo {
  id: string;
  title: string;
  description: string;
  data: DatasetRow[];
  spec: VegaLiteSpec;
}

export const demos: Demo[] = [
  {
    id: 'stacked-bar',
    title: 'Aggregated bar chart, stacked by color',
    description:
      'mark: "bar" with a "sum" aggregate on y and a nominal color split — exercises inline ' +
      'aggregation plus the default (zero) stack.',
    data: salesRows,
    spec: {
      mark: 'bar',
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
        color: { field: 'category', type: 'nominal' },
      },
    },
  },
  {
    id: 'normalized-bar',
    title: 'Normalized stacked bar',
    description: 'Same spec as above with "stack: normalize" on the y channel (100% stacking).',
    data: salesRows,
    spec: {
      mark: 'bar',
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'revenue', type: 'quantitative', aggregate: 'sum', stack: 'normalize' },
        color: { field: 'category', type: 'nominal' },
      },
    },
  },
  {
    id: 'line-with-points',
    title: 'Multi-series line with point overlay',
    description:
      'A "layer" composition: a line mark and a point mark share the inherited x/y/color ' +
      'encoding — exercises layer flattening plus the LinePlot/MarkPlot combination.',
    data: salesRows,
    spec: {
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
        color: { field: 'category', type: 'nominal' },
      },
      layer: [{ mark: 'line' }, { mark: { type: 'point' } }],
    },
  },
  {
    id: 'area',
    title: 'Area chart',
    description: 'mark: "area" with a sum aggregate — exercises the AreaPlot translation.',
    data: salesRows,
    spec: {
      mark: 'area',
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
        color: { field: 'region', type: 'nominal' },
      },
    },
  },
  {
    id: 'scatter',
    title: 'Scatter plot with color groups',
    description:
      'mark: "point" with two quantitative channels and a nominal color split — exercises the ' +
      'ScatterPlot translation.',
    data: scatterRows,
    spec: {
      mark: 'point',
      encoding: {
        x: { field: 'units', type: 'quantitative' },
        y: { field: 'revenue', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    },
  },
  {
    id: 'donut',
    title: 'Donut chart',
    description:
      'mark: {type: "arc", innerRadius: 60} with a theta channel — exercises the arc → PiePlot ' +
      'translation.',
    data: shareRows,
    spec: {
      mark: { type: 'arc', innerRadius: 60 },
      encoding: {
        theta: { field: 'share', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    },
  },
  {
    id: 'heatmap',
    title: 'Heatmap (rect mark — Premium tier)',
    description:
      'mark: "rect" with two ordinal channels and an aggregated quantitative color — translates ' +
      'to the x-charts-pro Heatmap (renders watermarked without a license key).',
    data: activityRows,
    spec: {
      mark: 'rect',
      encoding: {
        x: { field: 'day', type: 'ordinal' },
        y: { field: 'part', type: 'ordinal' },
        color: { field: 'visits', type: 'quantitative', aggregate: 'sum' },
      },
    },
  },
  {
    id: 'range-bar',
    title: 'Ranged bars (bar mark with y2 — Premium tier)',
    description:
      'mark: "bar" with y and y2 quantitative fields — translates to the x-charts-premium ' +
      'RangeBar series (renders watermarked without a license key).',
    data: temperatureRows,
    spec: {
      mark: 'bar',
      encoding: {
        x: { field: 'day', type: 'ordinal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { field: 'high' },
      },
    },
  },
  {
    id: 'geoshape',
    title: 'Choropleth world map (geoshape mark — Premium tier)',
    description:
      'mark: "geoshape" over the 110m world-atlas countries (GeoJSON), colored by each country’s ' +
      'relative land area — translates to the x-charts-premium Map (renders watermarked without a ' +
      'license key).',
    data: worldFeatures,
    spec: {
      projection: { type: 'naturalEarth1' },
      mark: 'geoshape',
      encoding: {
        color: { field: 'properties.area', type: 'quantitative' },
      },
    },
  },
  {
    id: 'boxplot',
    title: 'Box plot (custom overlay)',
    description:
      'mark: "boxplot" — quartiles, 1.5×IQR whiskers, and outliers drawn by a custom SVG overlay ' +
      'composed with the public useXScale/useYScale hooks (no x-charts series involved).',
    data: distributionRows,
    spec: {
      mark: 'boxplot',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'revenue', type: 'quantitative' },
      },
    },
  },
  {
    id: 'errorband-line',
    title: 'Line with error band (custom overlay)',
    description:
      'Real Amazon (AMZN) daily closing prices grouped by month: mark: "errorband" (stdev extent) ' +
      'shows each month’s price volatility, under a monthly-mean line. The band is a custom ' +
      'overlay path; the line is a regular LinePlot series.',
    data: amznRows,
    spec: {
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'close', type: 'quantitative' },
      },
      layer: [
        { mark: { type: 'errorband', extent: 'stdev' } },
        { mark: 'line', encoding: { y: { field: 'close', aggregate: 'mean' } } },
      ],
    },
  },
  {
    id: 'bar-labels',
    title: 'Bar chart with text value labels',
    description:
      'A layer of mark: "text" over bars — value labels drawn as a custom SVG overlay, dy-offset ' +
      'above each bar.',
    data: shareRows,
    spec: {
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'share', type: 'quantitative' },
      },
      layer: [
        { mark: 'bar' },
        { mark: { type: 'text', dy: -8 }, encoding: { text: { field: 'share' } } },
      ],
    },
  },
  {
    id: 'faceted-bars',
    title: 'Faceted bar chart (column facet)',
    description:
      'A "column" facet channel — the wrapper partitions the data and renders a grid of ' +
      'sub-charts with shared y domains and facet headers.',
    data: salesRows,
    spec: {
      mark: 'bar',
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
        color: { field: 'category', type: 'nominal' },
        column: { field: 'region', type: 'nominal' },
      },
    },
  },
  {
    id: 'time-line',
    title: 'Continuous time-scale line',
    description:
      'A temporal x channel over irregular ISO dates — the wrapper builds a continuous ' +
      'time axis (scaleType "time") so points are spaced by their real date distance, not ' +
      'as evenly-spaced ordinal ticks.',
    data: timeSeriesRows,
    spec: {
      mark: { type: 'line', point: true },
      encoding: {
        x: { field: 'date', type: 'temporal', axis: { format: '%b %d' } },
        y: { field: 'users', type: 'quantitative' },
      },
    },
  },
  {
    id: 'rounded-bar',
    title: 'Bar chart with rounded corners',
    description:
      'mark: {type: "bar", cornerRadius: 8} — the corner radius maps to the BarPlot ' +
      'borderRadius, applied chart-wide.',
    data: shareRows,
    spec: {
      mark: { type: 'bar', cornerRadius: 8 },
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'share', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    },
  },
  {
    id: 'cumulative-line',
    title: 'Cumulative total (window transform)',
    description:
      'A "window" transform computes a running sum (frame [null, 0]) over the per-month totals — ' +
      'the cumulative revenue renders as a line over the ordinal month axis.',
    data: salesRows,
    spec: {
      transform: [
        { aggregate: [{ op: 'sum', field: 'revenue', as: 'monthly' }], groupby: ['month'] },
        {
          window: [{ op: 'sum', field: 'monthly', as: 'cumulative' }],
          frame: [null, 0],
        },
      ],
      mark: { type: 'line', point: true },
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'cumulative', type: 'quantitative' },
      },
    },
  },
  {
    id: 'regression-line',
    title: 'Scatter with regression trend line',
    description:
      'A "regression" transform fits a linear trend; the layer draws the raw points plus the ' +
      'fitted line. Because the x axis is continuous quantitative, the line renders as a polyline ' +
      'overlay (the wrapper has no index-aligned category domain to hang a line series on).',
    data: spendRows,
    spec: {
      encoding: {
        x: { field: 'spend', type: 'quantitative' },
        y: { field: 'conversions', type: 'quantitative' },
      },
      layer: [
        { mark: { type: 'point' } },
        {
          mark: { type: 'line', color: '#d32f2f' },
          transform: [{ regression: 'conversions', on: 'spend' }],
        },
      ],
    },
  },
  {
    id: 'param-slider',
    title: 'Bound input widget (variable param)',
    description:
      'A named param bound to a range slider drives a filter transform — dragging the slider ' +
      're-threads the live signal value through the compile pipeline and re-filters the bars.',
    data: salesRows,
    spec: {
      params: [
        {
          name: 'minRevenue',
          value: 2000,
          bind: { input: 'range', min: 0, max: 6000, step: 500, name: 'Min revenue: ' },
        },
      ],
      transform: [{ filter: 'datum.revenue >= minRevenue' }],
      mark: 'bar',
      encoding: {
        x: { field: 'month', type: 'ordinal' },
        y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
        color: { field: 'category', type: 'nominal' },
      },
    },
  },
  {
    id: 'grouped-boxplot',
    title: 'Grouped box plot (color split)',
    description:
      'mark: "boxplot" with a nominal color channel — dodged boxes, one per region within each ' +
      'category, rendered by the custom overlay pipeline.',
    data: distributionRows,
    spec: {
      mark: 'boxplot',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'revenue', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    },
  },
];
