import type {
  StudioCustomWidgetDef,
  StudioDataSource,
  StudioState,
  StudioWidget,
  StudioWidgetKind,
  StudioFilterState,
} from '../models';

// ── Widget kind / chart type descriptions ─────────────────────────────────────

const WIDGET_KIND_DESCRIPTIONS: Record<StudioWidgetKind, string> = {
  chart:
    'Chart (bar, line, area, pie, donut, scatter, heatmap, funnel, gantt, gauge, mixed multi-series)',
  grid: 'Data grid / table',
  kpi: 'KPI card (single metric with optional sparkline/gauge and trend)',
  text: 'Text / markdown card',
  filter: 'Interactive filter widget (date range, multi-select, toggle, slider)',
  pivot: 'Pivot table (cross-tabulation with row/column dimensions and value aggregation)',
  map: 'Choropleth world map (country-level data visualisation)',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function describeSource(source: StudioDataSource): string {
  const visibleFields = source.fields.filter((f) => !f.hidden);
  const fieldList = visibleFields
    .map((f) => {
      const label = f.label !== f.id ? `, label: "${f.label}"` : '';
      const aiDesc = f.aiDescription ? ` — ${f.aiDescription}` : '';
      return `${f.id} (${f.type}${label}${aiDesc})`;
    })
    .join(', ');
  const sourceDesc = source.aiDescription ? `\n  Description: ${source.aiDescription}` : '';
  return `- ${source.label} [id: ${source.id}]:${sourceDesc} ${visibleFields.length} fields: ${fieldList}`;
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
  } else if (widget.kind === 'pivot') {
    const cfg2 = cfg as {
      pivotRowField?: string;
      pivotColField?: string;
      pivotValueField?: string;
    };
    if (cfg2.pivotRowField) {
      parts.push(`rowField: ${cfg2.pivotRowField}`);
    }
    if (cfg2.pivotColField) {
      parts.push(`colField: ${cfg2.pivotColField}`);
    }
    if (cfg2.pivotValueField) {
      parts.push(`valueField: ${cfg2.pivotValueField}`);
    }
  } else if (widget.kind === 'map') {
    const cfg2 = cfg as { mapCountryField?: string; mapValueField?: string };
    if (cfg2.mapCountryField) {
      parts.push(`countryField: ${cfg2.mapCountryField}`);
    }
    if (cfg2.mapValueField) {
      parts.push(`valueField: ${cfg2.mapValueField}`);
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
export function buildAISystemPrompt(
  state: StudioState,
  customWidgets?: StudioCustomWidgetDef[],
  focusedWidgetId?: string,
): string {
  const { dashboard, pages, widgets, dataSources, filters, mode } = state;

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
    // Active filters on this page
    const activeFilters = filters.filter(
      (f: StudioFilterState) =>
        (f.scope === 'page' && f.pageId === activePage.id) ||
        (f.scope === 'widget' && activeWidgetIds.includes(f.widgetId ?? '')),
    );
    if (activeFilters.length > 0) {
      lines.push(
        '## Active Filters (use remove_page_filter or remove_widget_filter with the filter id to remove)',
      );
      for (const f of activeFilters) {
        const scopeLabel = f.scope === 'page' ? 'page' : `widget:${f.widgetId}`;
        lines.push(
          `  - [id: ${f.id}] scope:${scopeLabel} — ${f.field} ${f.operator} ${JSON.stringify(f.value)}`,
        );
      }
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
  if (customWidgets && customWidgets.length > 0) {
    lines.push('Custom widget kinds (registered by the app):');
    for (const cw of customWidgets) {
      const needsSource = cw.requiresDataSource !== false ? ' (requires sourceId)' : '';
      const configKeys =
        cw.defaultConfig && Object.keys(cw.defaultConfig).length > 0
          ? ` Config keys: ${Object.keys(cw.defaultConfig).join(', ')}.`
          : '';
      lines.push(
        `- ${cw.kind}: ${cw.label}${cw.description ? ` — ${cw.description}` : ''}${needsSource}.${configKeys}`,
      );
    }
  }
  lines.push('');
  lines.push(
    'Chart types: bar, bar-stacked, bar-100, line, area, area-stacked, area-100, pie, donut, scatter, ' +
      'heatmap (xField×heatYField heat intensity), ' +
      'funnel (xField=stages, yField+yAggregation), ' +
      'gantt (ganttLabelField, ganttStartField, ganttEndField, ganttColorField?), ' +
      'gauge (yField+yAggregation, gaugeMin, gaugeMax), ' +
      'mixed (ySeries array with {fieldId, label, type: bar|line, yAggregation}; set dualYAxis:true for dual axes).',
  );
  lines.push(
    'KPI sparkline plotType options: line, bar, gauge (kpiSparklineGaugeMin, kpiSparklineGaugeMax).',
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

  if (focusedWidgetId) {
    const focused = state.widgets[focusedWidgetId];
    if (focused) {
      lines.push('');
      lines.push('## Per-widget focus');
      lines.push(
        `The user is asking about widget "${focused.title}" (id: ${focusedWidgetId}, kind: ${focused.kind}).`,
      );
      lines.push('Focus your assistance on this specific widget.');
      lines.push(
        'Prefer update_widget over other tools. Only create/delete widgets if explicitly requested.',
      );
    }
  }

  return lines.join('\n');
}
