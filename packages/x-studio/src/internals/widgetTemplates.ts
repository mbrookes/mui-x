/**
 * Widget Template Library
 *
 * Pre-built widget configurations the user can drop onto the canvas.
 * Field placeholders (`__NUMERIC_1__`, `__CATEGORY_1__`, `__DATE_1__`, etc.) are
 * resolved to actual field IDs from the active data source by `applyWidgetTemplate`.
 */

import type { StudioDataSource, StudioWidget, StudioWidgetConfig, StudioWidgetKind } from '../models';

/** Placeholder IDs used in template `config` and `title` strings. */
const NUMERIC_1 = '__NUMERIC_1__';
const NUMERIC_2 = '__NUMERIC_2__';
const CATEGORY_1 = '__CATEGORY_1__';
const CATEGORY_2 = '__CATEGORY_2__';
const DATE_1 = '__DATE_1__';

export interface StudioWidgetTemplate {
  id: string;
  label: string;
  description: string;
  kind: StudioWidgetKind;
  /** Title override for the created widget (may contain placeholders). */
  titleHint: string;
  /**
   * Widget config with field placeholder IDs.
   * Placeholders are replaced by field IDs from the active data source.
   */
  config: StudioWidgetConfig;
  /** Preferred column span (3–12). Defaults to the row's equal share. */
  colSpan?: number;
  /**
   * Minimum requirements. If the data source lacks fields of these types,
   * the template will appear disabled.
   */
  requires?: {
    numeric?: number;
    category?: number;
    date?: number;
  };
}

export const WIDGET_TEMPLATES: StudioWidgetTemplate[] = [
  // ── KPI templates ────────────────────────────────────────────────────────
  {
    id: 'tpl-kpi-sum',
    label: 'Total KPI',
    description: 'Sum of a numeric field',
    kind: 'kpi',
    titleHint: 'Total',
    colSpan: 3,
    config: {
      kpiAggregation: 'sum',
      kpiValueField: NUMERIC_1,
    },
    requires: { numeric: 1 },
  },
  {
    id: 'tpl-kpi-count',
    label: 'Record Count KPI',
    description: 'Count of all records',
    kind: 'kpi',
    titleHint: 'Count',
    colSpan: 3,
    config: {
      kpiAggregation: 'count',
      kpiValueField: CATEGORY_1,
    },
    requires: {},
  },
  {
    id: 'tpl-kpi-avg',
    label: 'Average KPI',
    description: 'Average of a numeric field',
    kind: 'kpi',
    titleHint: 'Average',
    colSpan: 3,
    config: {
      kpiAggregation: 'avg',
      kpiValueField: NUMERIC_1,
    },
    requires: { numeric: 1 },
  },
  // ── Chart templates ───────────────────────────────────────────────────────
  {
    id: 'tpl-chart-bar-category',
    label: 'Bar by Category',
    description: 'Grouped bar chart of a measure per category',
    kind: 'chart',
    titleHint: 'By Category',
    config: {
      chartType: 'bar',
      xField: CATEGORY_1,
      ySeries: [{ fieldId: NUMERIC_1 }],
    },
    requires: { numeric: 1, category: 1 },
  },
  {
    id: 'tpl-chart-bar-horizontal',
    label: 'Horizontal Bar',
    description: 'Horizontal bar chart sorted by value',
    kind: 'chart',
    titleHint: 'Ranking',
    config: {
      chartType: 'bar',
      barLayout: 'horizontal',
      xField: CATEGORY_1,
      ySeries: [{ fieldId: NUMERIC_1 }],
    },
    requires: { numeric: 1, category: 1 },
  },
  {
    id: 'tpl-chart-trend',
    label: 'Trend Line',
    description: 'Monthly trend of a numeric measure over time',
    kind: 'chart',
    titleHint: 'Over Time',
    config: {
      chartType: 'line',
      xField: DATE_1,
      xGroupBy: 'month',
      ySeries: [{ fieldId: NUMERIC_1 }],
    },
    requires: { numeric: 1, date: 1 },
  },
  {
    id: 'tpl-chart-area',
    label: 'Area Chart',
    description: 'Stacked area chart of a measure over time',
    kind: 'chart',
    titleHint: 'Over Time',
    config: {
      chartType: 'area',
      xField: DATE_1,
      xGroupBy: 'month',
      ySeries: [{ fieldId: NUMERIC_1 }],
    },
    requires: { numeric: 1, date: 1 },
  },
  {
    id: 'tpl-chart-bar-stacked',
    label: 'Stacked Bar',
    description: 'Stacked bar chart split by a category over time',
    kind: 'chart',
    titleHint: 'by Category Over Time',
    config: {
      chartType: 'bar-stacked',
      xField: DATE_1,
      xGroupBy: 'month',
      ySeries: [{ fieldId: NUMERIC_1 }],
      seriesField: CATEGORY_1,
    },
    requires: { numeric: 1, category: 1, date: 1 },
  },
  {
    id: 'tpl-chart-multi-bar',
    label: 'Multi-Measure Bar',
    description: 'Side-by-side bars for two numeric measures per category',
    kind: 'chart',
    titleHint: 'Comparison',
    config: {
      chartType: 'bar',
      xField: CATEGORY_1,
      ySeries: [{ fieldId: NUMERIC_1 }, { fieldId: NUMERIC_2 }],
    },
    requires: { numeric: 2, category: 1 },
  },
  {
    id: 'tpl-chart-donut',
    label: 'Donut Chart',
    description: 'Proportion breakdown by category',
    kind: 'chart',
    titleHint: 'Breakdown',
    config: {
      chartType: 'donut',
      xField: CATEGORY_1,
      ySeries: [{ fieldId: NUMERIC_1 }],
      pieArcLabel: 'percent',
    },
    requires: { numeric: 1, category: 1 },
  },
  {
    id: 'tpl-chart-scatter',
    label: 'Scatter Plot',
    description: 'Two numeric measures plotted against each other',
    kind: 'chart',
    titleHint: 'vs',
    config: {
      chartType: 'scatter',
      xField: NUMERIC_1,
      ySeries: [{ fieldId: NUMERIC_2 }],
    },
    requires: { numeric: 2 },
  },
  {
    id: 'tpl-chart-funnel',
    label: 'Funnel Chart',
    description: 'Ordered stages with drop-off between each',
    kind: 'chart',
    titleHint: 'Funnel',
    config: {
      chartType: 'funnel',
      xField: CATEGORY_1,
      yField: NUMERIC_1,
      ySeries: [{ fieldId: NUMERIC_1 }],
    },
    requires: { numeric: 1, category: 1 },
  },
  // ── Table template ────────────────────────────────────────────────────────
  {
    id: 'tpl-grid-basic',
    label: 'Data Table',
    description: 'Grid showing all columns from the data source',
    kind: 'grid',
    titleHint: 'Data',
    config: {
      columns: [],
    },
    requires: {},
  },
];

/**
 * Resolves field placeholders in a config value (string or object) by replacing
 * `__NUMERIC_1__`, `__CATEGORY_1__`, `__DATE_1__`, etc. with actual field IDs.
 */
function replacePlaceholders(value: unknown, map: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    return map[value] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, map));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replacePlaceholders(v, map);
    }
    return out;
  }
  return value;
}

/**
 * Checks whether a data source has enough fields to satisfy a template's requirements.
 */
export function templateIsSatisfied(
  template: StudioWidgetTemplate,
  source: StudioDataSource | undefined,
): boolean {
  if (!source) {
    return template.kind === 'text';
  }
  const { requires } = template;
  if (!requires) {
    return true;
  }
  const visibleFields = source.fields.filter((f) => !f.hidden);
  const numericCount = visibleFields.filter((f) => f.type === 'number').length;
  const categoryCount = visibleFields.filter((f) => f.type === 'string').length;
  const dateCount = visibleFields.filter((f) => f.type === 'date' || f.type === 'datetime').length;
  if ((requires.numeric ?? 0) > numericCount) {
    return false;
  }
  if ((requires.category ?? 0) > categoryCount) {
    return false;
  }
  if ((requires.date ?? 0) > dateCount) {
    return false;
  }
  return true;
}

/**
 * Creates a `StudioWidget` from a template, with field placeholders resolved
 * using the first matching fields from `source`.
 *
 * For the `grid` template, all visible numeric and string columns are added.
 */
export function applyWidgetTemplate(
  template: StudioWidgetTemplate,
  source: StudioDataSource | undefined,
): StudioWidget {
  const id = `widget-tpl-${template.id}-${Date.now()}`;

  if (!source) {
    return {
      id,
      kind: template.kind,
      title: template.titleHint,
      config: { ...template.config },
    };
  }

  const visibleFields = source.fields.filter((f) => !f.hidden);
  const numericFields = visibleFields.filter((f) => f.type === 'number');
  const categoryFields = visibleFields.filter((f) => f.type === 'string');
  const dateFields = visibleFields.filter(
    (f) => f.type === 'date' || f.type === 'datetime',
  );

  const placeholderMap: Record<string, string | undefined> = {
    [NUMERIC_1]: numericFields[0]?.id,
    [NUMERIC_2]: numericFields[1]?.id,
    [CATEGORY_1]: categoryFields[0]?.id,
    [CATEGORY_2]: categoryFields[1]?.id,
    [DATE_1]: dateFields[0]?.id,
  };

  let config = replacePlaceholders({ ...template.config }, placeholderMap) as StudioWidgetConfig;

  // Grid template: populate all columns from the source
  if (template.id === 'tpl-grid-basic') {
    config = {
      ...config,
      columns: visibleFields.map((f) => ({ fieldId: f.id })),
    };
  }

  // Remove any ySeries entries whose fieldId resolved to a placeholder (field not found)
  if (config.ySeries) {
    config = {
      ...config,
      ySeries: config.ySeries.filter(
        (s) => s.fieldId && !s.fieldId.startsWith('__'),
      ),
    };
  }

  return {
    id,
    kind: template.kind,
    title: '',
    sourceId: source.id,
    config,
  };
}
