import type { StudioChartAnnotation } from '../../models/widgetTypes';

export type StudioWidgetInsightType = 'summary' | 'analysis' | 'forecast' | 'correlation';

/**
 * Builds the ready-to-send chat prompt for a widget's AI-insight action
 * (summary/analysis/forecast/correlation). Extracted from `StudioWidgetCard`'s
 * `handleInsightRequest`, which had grown the card past 800 lines with inline prompt
 * strings — this is the single implementation, kept pure so it can be unit tested
 * without mounting the card.
 */
export function buildInsightPrompt(type: StudioWidgetInsightType, widgetTitle: string): string {
  switch (type) {
    case 'summary':
      return `Give me a 2–3 sentence high-level summary of the "${widgetTitle}" widget — what it shows and the single most important takeaway. Be brief, no bullet points.`;
    case 'analysis':
      return `Analyse the "${widgetTitle}" widget — identify key trends, patterns, and notable values`;
    case 'forecast':
      return `Forecast the "${widgetTitle}" widget — what trend do you expect over the next few periods?`;
    case 'correlation':
      return `Show a correlation analysis for the "${widgetTitle}" widget`;
    default:
      return `Analyse the "${widgetTitle}" widget`;
  }
}

/**
 * Builds the ready-to-send chat prompt for the "explain anomalies" AI-insight action,
 * one line per detected annotation. Extracted from `StudioWidgetCard`'s
 * `handleAnomalyExplain` alongside `buildInsightPrompt` (see there for rationale).
 */
export function buildAnomalyExplainPrompt(
  widgetTitle: string,
  annotations: StudioChartAnnotation[],
): string {
  const annotationDetails = annotations
    .map((annotation) => {
      const axisLabel = annotation.axis === 'x' ? 'X-axis' : 'Y-axis';
      const labelPart = annotation.label ? ` (${annotation.label})` : '';
      return `- ${axisLabel} anomaly at ${JSON.stringify(annotation.value)}${labelPart}`;
    })
    .join('\n');
  return `Explain the anomalies detected in the "${widgetTitle}" widget:\n${annotationDetails}`;
}
