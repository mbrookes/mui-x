import type { StudioDataSource, StudioState, StudioWidget, StudioWidgetKind } from '../models';

// ── Widget kind / chart type descriptions ─────────────────────────────────────

const WIDGET_KIND_DESCRIPTIONS: Record<StudioWidgetKind, string> = {
  chart: 'Chart (bar, line, area, pie, donut, scatter)',
  grid: 'Data grid / table',
  kpi: 'KPI card (single metric with optional sparkline and trend)',
  text: 'Text / markdown card',
  filter: 'Interactive filter widget (date range, multi-select, toggle, slider)',
  pivot: 'Pivot table (cross-tabulation with row/column dimensions and value aggregation)',
  map: 'Choropleth world map (country-level data visualisation)',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function describeSource(source: StudioDataSource): string {
  const visibleFields = source.fields.filter((f) => !f.hidden);
  const fieldList = visibleFields
    .map((f) => `${f.id} (${f.type}${f.label !== f.id ? `, label: "${f.label}"` : ''})`)
    .join(', ');
  return `- ${source.label} [id: ${source.id}]: ${visibleFields.length} fields: ${fieldList}`;
}

function describeWidget(widget: StudioWidget, sources: Record<string, StudioDataSource>): string {
  const source = widget.sourceId ? sources[widget.sourceId] : undefined;
  const cfg = widget.config;
  const parts: string[] = [
    `id: ${widget.id}`,
    `kind: ${widget.kind}`,
    `title: "${widget.title}"`,
    source ? `source: "${source.label}" (${source.id})` : 'no source',
  ];

  if (widget.kind === 'chart') {
    if (cfg.chartType) {
      parts.push(`chartType: ${cfg.chartType}`);
    }
    if (cfg.xField) {
      parts.push(`xField: ${cfg.xField}`);
    }
    if (cfg.yField) {
      parts.push(`yField: ${cfg.yField}`);
    }
    if (cfg.ySeries?.length) {
      parts.push(`ySeries: [${cfg.ySeries.map((s) => s.fieldId).join(', ')}]`);
    }
    if (cfg.seriesField) {
      parts.push(`seriesField: ${cfg.seriesField}`);
    }
  } else if (widget.kind === 'kpi') {
    if (cfg.kpiValueField) {
      parts.push(`valueField: ${cfg.kpiValueField}`);
    }
    if (cfg.kpiAggregation) {
      parts.push(`aggregation: ${cfg.kpiAggregation}`);
    }
  } else if (widget.kind === 'grid') {
    if (cfg.columns?.length) {
      parts.push(`columns: [${cfg.columns.map((c) => c.fieldId).join(', ')}]`);
    }
  } else if (widget.kind === 'filter') {
    if (cfg.filterWidgetType) {
      parts.push(`filterType: ${cfg.filterWidgetType}`);
    }
    if (cfg.filterWidgetField) {
      parts.push(`filterField: ${cfg.filterWidgetField}`);
    }
  }

  return `  - ${parts.join(', ')}`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Builds an OpenAI-compatible system prompt that describes the current
 * x-studio dashboard state to the LLM.
 *
 * Designed to be concise (low token count) while giving the model enough
 * context to create/modify widgets and answer simple data questions.
 */
export function buildAISystemPrompt(state: StudioState): string {
  const { dashboard, pages, widgets, dataSources, mode } = state;

  const pageList = Object.values(pages);
  const activePage = pages[dashboard.activePageId];
  const activeWidgetIds = (activePage?.widgetRows ?? []).flat();
  const activeWidgets = activeWidgetIds
    .map((id) => widgets[id])
    .filter((w): w is StudioWidget => w != null);

  const sourceList = Object.values(dataSources);

  const lines: string[] = [
    'You are an AI dashboard assistant for an x-studio analytics dashboard builder.',
    'You help users configure their dashboard by creating pages, adding widgets, and modifying them.',
    'Always prefer to use tool calls over long explanations — act on requests directly.',
    'When the user asks about data, reason from the field names and widget configuration.',
    '',
    `## Dashboard: "${dashboard.title || '(untitled)'}"`,
    `Mode: ${mode}`,
    '',
  ];

  // Pages
  if (pageList.length === 0) {
    lines.push('No pages yet.');
  } else {
    lines.push(`## Pages (${pageList.length})`);
    for (const page of pageList) {
      const isActive = page.id === dashboard.activePageId;
      const widgetCount = (page.widgetRows ?? []).flat().length;
      lines.push(
        `- ${page.title} [id: ${page.id}]${isActive ? ' (active)' : ''} — ${widgetCount} widget${widgetCount !== 1 ? 's' : ''}`,
      );
    }
    lines.push('');
  }

  // Widgets on active page
  if (activePage) {
    if (activeWidgets.length === 0) {
      lines.push(`## Active page: "${activePage.title}"\nNo widgets on this page yet.`);
    } else {
      lines.push(`## Widgets on "${activePage.title}" (${activeWidgets.length})`);
      for (const widget of activeWidgets) {
        lines.push(describeWidget(widget, dataSources));
      }
    }
    lines.push('');

    // Layout: show current widgetRows so the LLM can reason about rearrangements
    const widgetRows = activePage.widgetRows ?? [];
    const widgetColSpans = activePage.widgetColSpans ?? {};
    if (widgetRows.length > 0) {
      lines.push(
        '## Layout (current widgetRows — use set_widget_layout to rearrange, set_widget_width to resize)',
      );
      widgetRows.forEach((row, i) => {
        const rowDesc = row
          .map((id) => {
            const w = widgets[id];
            const span = widgetColSpans[id];
            const spanSuffix = span != null ? `, ${span}col` : '';
            return w ? `${id} ("${w.title}", ${w.kind}${spanSuffix})` : id;
          })
          .join(', ');
        lines.push(`Row ${i + 1}: ${rowDesc}`);
      });
      lines.push('');
    }
  }

  // Data sources
  if (sourceList.length === 0) {
    lines.push('No data sources configured.');
  } else {
    lines.push(`## Data Sources (${sourceList.length})`);
    for (const source of sourceList) {
      lines.push(describeSource(source));
    }
    lines.push('');
  }

  // Available widget types
  lines.push('## Available Widget Kinds');
  for (const [kind, desc] of Object.entries(WIDGET_KIND_DESCRIPTIONS)) {
    lines.push(`- ${kind}: ${desc}`);
  }
  lines.push('');
  lines.push(
    'Chart types: bar, bar-stacked, bar-100, line, area, area-stacked, area-100, pie, donut, scatter',
  );
  lines.push('');

  // Guidelines
  lines.push('## Guidelines');
  lines.push('- When adding a widget, pick sensible defaults from the available fields.');
  lines.push(
    '- For charts, choose xField (categorical/date) and yField (numeric) from the source fields.',
  );
  lines.push('- Use the widget id from the state when updating or removing a widget.');
  lines.push('- For data questions, reason from the field names and aggregations described above.');
  lines.push(
    '- To rearrange widgets (e.g. "put the KPI widgets on the same row"), use set_widget_layout with a full rows array. Every widget on the page must appear in the new layout.',
  );

  return lines.join('\n');
}
