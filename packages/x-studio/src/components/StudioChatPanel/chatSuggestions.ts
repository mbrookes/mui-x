import type { selectDataSources, selectWidgets } from '../../context';
import type { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

// ── Suggestion generator ──────────────────────────────────────────────────────

export function generateSuggestions(
  dataSources: ReturnType<typeof selectDataSources>,
  widgets: ReturnType<typeof selectWidgets>,
  activePageWidgetIds: string[],
  localeText: ReturnType<typeof useStudioLocaleText>,
): Array<{ label: string; value: string }> {
  const sourceList = Object.values(dataSources);
  const activeWidgets = activePageWidgetIds.flatMap((id) => (widgets[id] ? [widgets[id]] : []));
  const hasWidgets = activeWidgets.length > 0;

  const suggestions: Array<{ label: string; value: string }> = [];

  if (!hasWidgets) {
    // Empty state: suggest building first widgets from available sources
    for (const source of sourceList.slice(0, 3)) {
      let numericField: (typeof source.fields)[0] | undefined;
      let catField: (typeof source.fields)[0] | undefined;
      for (const f of source.fields) {
        if (!f.hidden) {
          if (!numericField && f.type === 'number') {
            numericField = f;
          }
          if (!catField && (f.type === 'string' || f.type === 'date')) {
            catField = f;
          }
        }
        if (numericField && catField) {
          break;
        }
      }

      if (numericField && catField) {
        suggestions.push({
          label: localeText.aiSuggestionBarChart(numericField.label, catField.label),
          value: `Add a bar chart showing ${numericField.label} by ${catField.label} from the ${source.label} data.`,
        });
        suggestions.push({
          label: localeText.aiSuggestionKpi(numericField.label),
          value: `Add a KPI card showing the total ${numericField.label} from ${source.label}.`,
        });
      } else if (source.fields.length > 0) {
        suggestions.push({
          label: localeText.aiSuggestionTable(source.label),
          value: `Add a data table showing records from ${source.label}.`,
        });
      }
    }

    if (suggestions.length < 3) {
      suggestions.push({
        label: localeText.aiSuggestionWhatDataAvailable,
        value: 'What data sources and fields are available for building this dashboard?',
      });
    }
  } else {
    // Existing widgets: suggest modifications and additions
    const chartWidgets = activeWidgets.filter((w) => w?.kind === 'chart');
    const kpiWidgets = activeWidgets.filter((w) => w?.kind === 'kpi');

    if (chartWidgets.length > 0) {
      const first = chartWidgets[0];
      if (first) {
        suggestions.push({
          label: localeText.aiSuggestionChangeToLine(first.title),
          value: `Change the "${first.title}" widget to a line chart.`,
        });
      }
    }

    if (kpiWidgets.length > 0) {
      const first = kpiWidgets[0];
      if (first) {
        suggestions.push({
          label: localeText.aiSuggestionAddSparkline(first.title),
          value: `Add a sparkline to the "${first.title}" KPI widget.`,
        });
      }
    }

    // Suggest adding a date filter if not present
    const hasFilter = activeWidgets.some((w) => w?.kind === 'filter');
    if (!hasFilter) {
      const hasDateSource = Object.values(dataSources).some((s) =>
        s.fields.some((f) => f.type === 'date' || f.type === 'datetime'),
      );
      if (hasDateSource) {
        suggestions.push({
          label: localeText.aiSuggestionAddDateFilter,
          value: 'Add a date range filter widget to the dashboard.',
        });
      }
    }

    suggestions.push({
      label: localeText.aiSuggestionAddPage,
      value: 'Create a new dashboard page.',
    });

    suggestions.push({
      label: localeText.aiSuggestionSummarisePage,
      value:
        'Give me an executive summary of the key insights from this page — focus on the data, trends, and any anomalies rather than the page structure.',
    });
  }

  return suggestions.slice(0, 4);
}
