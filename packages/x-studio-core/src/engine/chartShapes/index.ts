/**
 * Chart-type-specific data preparation. Each module shapes already-resolved rows
 * into the structure a particular chart kind renders from. Kept separate from the
 * generic aggregators (`aggregators.ts`) because these are one-off, per-chart-type
 * transforms rather than reusable grouping primitives.
 */
export * from './scatter';
export * from './heatmap';
export * from './sankey';
export * from './funnel';
export * from './gantt';
