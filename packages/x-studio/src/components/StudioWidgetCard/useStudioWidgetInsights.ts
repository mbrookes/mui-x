'use client';
import * as React from 'react';
import type { StudioWidget } from '../../models';
import type { StudioChartAnnotation } from '../../models/widgetTypes';
import {
  buildInsightPrompt,
  buildAnomalyExplainPrompt,
  type StudioWidgetInsightType,
} from './widgetInsightPrompts';

interface UseStudioWidgetInsightsParams {
  widget: StudioWidget | undefined;
  widgetId: string;
  onInsightRequest?: (widgetId: string, prompt: string) => void;
}

interface StudioWidgetInsights {
  /** Routes a summary/analysis/forecast insight action to `onInsightRequest`. */
  handleInsightRequest: (type: StudioWidgetInsightType) => void;
  /** Whether anomaly detection is currently enabled for the widget's chart. */
  anomalyEnabled: boolean;
  /** Anomaly annotations reported by the chart while detection is enabled. */
  anomalyAnnotations: StudioChartAnnotation[];
  /** Setter passed to the chart so it can report detected anomalies. */
  setAnomalyAnnotations: React.Dispatch<React.SetStateAction<StudioChartAnnotation[]>>;
  /** Toggles anomaly detection; clears annotations immediately when disabling. */
  handleAnomalyToggle: () => void;
  /** Routes an "explain these anomalies" insight action to `onInsightRequest`. */
  handleAnomalyExplain: () => void;
}

/**
 * Owns a widget card's AI-insight routing and anomaly-detection state. Extracted from
 * `StudioWidgetCard` so the card no longer inlines this cohesive concern; the returned
 * handlers are wired straight into `StudioWidgetCardActionsOverlay`.
 */
export function useStudioWidgetInsights({
  widget,
  widgetId,
  onInsightRequest,
}: UseStudioWidgetInsightsParams): StudioWidgetInsights {
  const handleInsightRequest = React.useCallback(
    (type: StudioWidgetInsightType) => {
      if (!onInsightRequest || !widget) {
        return;
      }
      onInsightRequest(widgetId, buildInsightPrompt(type, widget.title || widget.kind));
    },
    [onInsightRequest, widget, widgetId],
  );

  const [anomalyEnabled, setAnomalyEnabled] = React.useState(false);
  const [anomalyAnnotations, setAnomalyAnnotations] = React.useState<StudioChartAnnotation[]>([]);
  // Toggle anomaly detection; clear annotations immediately when disabling
  const handleAnomalyToggle = React.useCallback(() => {
    setAnomalyEnabled((prev) => {
      if (prev) {
        setAnomalyAnnotations([]);
      }
      return !prev;
    });
  }, []);

  const handleAnomalyExplain = React.useCallback(() => {
    if (!onInsightRequest || !anomalyAnnotations.length || !widget) {
      return;
    }
    onInsightRequest(
      widgetId,
      buildAnomalyExplainPrompt(widget.title || widget.kind, anomalyAnnotations),
    );
  }, [onInsightRequest, anomalyAnnotations, widget, widgetId]);

  return {
    handleInsightRequest,
    anomalyEnabled,
    anomalyAnnotations,
    setAnomalyAnnotations,
    handleAnomalyToggle,
    handleAnomalyExplain,
  };
}
