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

/** Rows for the deliberately-unsupported boxplot demo. */
export const distributionRows: DatasetRow[] = [
  { category: 'Electronics', revenue: 4200 },
  { category: 'Electronics', revenue: 4600 },
  { category: 'Electronics', revenue: 5100 },
  { category: 'Electronics', revenue: 3900 },
  { category: 'Apparel', revenue: 2400 },
  { category: 'Apparel', revenue: 2100 },
  { category: 'Apparel', revenue: 2600 },
  { category: 'Apparel', revenue: 2750 },
];

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
    id: 'unsupported-boxplot',
    title: 'Unsupported mark: boxplot',
    description:
      'mark: "boxplot" has no x-charts equivalent in any tier. The chart renders with no marks ' +
      'and the gap is reported as "unsupported" through onGaps instead of throwing.',
    data: distributionRows,
    spec: {
      mark: 'boxplot',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'revenue', type: 'quantitative' },
      },
    },
  },
];
