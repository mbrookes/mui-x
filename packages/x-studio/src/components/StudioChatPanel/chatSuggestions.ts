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
          value: localeText.aiSuggestionBarChartPrompt(
            numericField.label,
            catField.label,
            source.label,
          ),
        });
        suggestions.push({
          label: localeText.aiSuggestionKpi(numericField.label),
          value: localeText.aiSuggestionKpiPrompt(numericField.label, source.label),
        });
      } else if (source.fields.length > 0) {
        suggestions.push({
          label: localeText.aiSuggestionTable(source.label),
          value: localeText.aiSuggestionTablePrompt(source.label),
        });
      }
    }

    if (suggestions.length < 3) {
      suggestions.push({
        label: localeText.aiSuggestionWhatDataAvailable,
        value: localeText.aiSuggestionWhatDataAvailablePrompt,
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
          value: localeText.aiSuggestionChangeToLinePrompt(first.title),
        });
      }
    }

    if (kpiWidgets.length > 0) {
      const first = kpiWidgets[0];
      if (first) {
        suggestions.push({
          label: localeText.aiSuggestionAddSparkline(first.title),
          value: localeText.aiSuggestionAddSparklinePrompt(first.title),
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
          value: localeText.aiSuggestionAddDateFilterPrompt,
        });
      }
    }

    suggestions.push({
      label: localeText.aiSuggestionAddPage,
      value: localeText.aiSuggestionAddPagePrompt,
    });

    suggestions.push({
      label: localeText.aiSuggestionSummarisePage,
      value: localeText.aiSuggestionSummarisePagePrompt,
    });
  }

  return suggestions.slice(0, 4);
}
