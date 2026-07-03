'use client';
import * as React from 'react';
import {
  useStudioSelector,
  selectWidgets,
  selectActivePageId,
  makeSelectWidgetSource,
} from '../../context';
import { useWidgetDefMap } from '../../internals/builtinWidgetDefs';

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

  return <def.component widget={widget} dataSource={source} pageId={pageId} />;
}
