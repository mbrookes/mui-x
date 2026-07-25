import type { StudioChartAnnotation } from '../../models/widgetTypes';
import type { StudioLocaleText } from '../../internals/localeText';

export type StudioWidgetInsightType = 'summary' | 'analysis' | 'forecast' | 'correlation';

/**
 * Builds the ready-to-send chat prompt for a widget's AI-insight action
 * (summary/analysis/forecast/correlation). Extracted from `StudioWidgetCard`'s
 * `handleInsightRequest`, which had grown the card past 800 lines with inline prompt
 * strings — this is the single implementation, kept pure so it can be unit tested
 * without mounting the card.
 *
 * The prompt text comes from `localeText`, not from literals here: the result is posted
 * verbatim as the USER's own chat message, so under a translated locale a hardcoded English
 * sentence would appear in the transcript as something the user themselves typed.
 */
export function buildInsightPrompt(
  type: StudioWidgetInsightType,
  widgetTitle: string,
  localeText: StudioLocaleText,
): string {
  switch (type) {
    case 'summary':
      return localeText.aiInsightSummaryPrompt(widgetTitle);
    case 'forecast':
      return localeText.aiInsightForecastPrompt(widgetTitle);
    case 'correlation':
      return localeText.aiInsightCorrelationPrompt(widgetTitle);
    case 'analysis':
    default:
      return localeText.aiInsightAnalysisPrompt(widgetTitle);
  }
}

/**
 * Builds the ready-to-send chat prompt for the "explain anomalies" AI-insight action,
 * one line per detected annotation. Extracted from `StudioWidgetCard`'s
 * `handleAnomalyExplain` alongside `buildInsightPrompt` (see there for rationale).
 *
 * `privateMode` is a hard client-side trust boundary: with `aiConfig.privateMode`
 * on, no real row/x-axis data values may reach the outgoing chat message — the same
 * stance enforced by `studioBackendAdapter`, `createWidgetFromDescription`, and
 * `useTextWidgetAI`. Each anomaly annotation's `value` is a literal x-axis data
 * value (e.g. a date, region, or customer name), so under private mode the
 * per-annotation value lines are omitted entirely and only the anomaly count is sent.
 */
export function buildAnomalyExplainPrompt(
  widgetTitle: string,
  annotations: StudioChartAnnotation[],
  localeText: StudioLocaleText,
  privateMode = false,
): string {
  if (privateMode) {
    return localeText.aiAnomalyExplainPrivatePrompt(widgetTitle, annotations.length);
  }
  const annotationDetails = annotations
    .map((annotation) =>
      localeText.aiAnomalyDetailLine(
        annotation.axis === 'x' ? localeText.aiAnomalyAxisX : localeText.aiAnomalyAxisY,
        JSON.stringify(annotation.value),
        annotation.label ?? '',
      ),
    )
    .join('\n');
  return localeText.aiAnomalyExplainPrompt(widgetTitle, annotationDetails);
}
