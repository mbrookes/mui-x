'use client';
import * as React from 'react';
import {
  useStudioSelector,
  selectWidgets,
  selectActivePageId,
  makeSelectWidgetSource,
} from '../../context';
import { useWidgetDefMap } from '../../internals/builtinWidgetDefs';
import { StudioWidgetErrorBoundary } from '../../internals/StudioWidgetErrorBoundary';

// ── Built-in widget preview ───────────────────────────────────────────────────

export function BuiltinWidgetPreview({ widgetId }: { widgetId: string }) {
  const widgets = useStudioSelector(selectWidgets);
  const widget = widgets[widgetId];
  const selectSource = React.useMemo(() => makeSelectWidgetSource(widgetId), [widgetId]);
  const source = useStudioSelector(selectSource);
  const pageId = useStudioSelector(selectActivePageId);
  const widgetDefMap = useWidgetDefMap();
  const def = widget ? widgetDefMap.get(widget.kind) : undefined;

  if (!widget || !def) {
    return null;
  }

  // Defense-in-depth (Tier1 whole-dashboard-crash fix): this preview renders the same
  // `def.component` the canvas card wraps in `StudioWidgetErrorBoundary`, but the edit
  // dialog had no boundary of its own — a render throw here (a not-yet-hardened chart
  // edge case, or a third-party `customWidgets` component) previously propagated all the
  // way up and unmounted the whole `<Studio>` tree instead of just the preview panel.
  // `resetKey` mirrors the canvas card's own key so editing the widget's config after a
  // transient error clears the fallback instead of latching it.
  return (
    <StudioWidgetErrorBoundary resetKey={JSON.stringify(widget.config)}>
      <def.component widget={widget} dataSource={source} pageId={pageId} />
    </StudioWidgetErrorBoundary>
  );
}
