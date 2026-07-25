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
  // `widgetId` is doc-authored (persisted doc / AI-authored / host-supplied), so guard the
  // record index against inherited keys ("toString"/"constructor"/…): a bare bracket lookup
  // would resolve a function off `Object.prototype` instead of "not found", and that truthy
  // non-widget object slips past the `!widget` guard below (prototype-chain key lookup fix,
  // matching `makeSelectWidget`/`StudioCanvas`).
  const widget = Object.hasOwn(widgets, widgetId) ? widgets[widgetId] : undefined;
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
  // `resetKeys` mirrors the canvas card's own keys (config identity + `sourceId` + the
  // resolved source, which is the data/fetch generation) so editing the widget after a
  // transient error clears the fallback instead of latching it. They are compared by
  // identity, never serialized: `JSON.stringify(widget.config)` used to run in THIS
  // component's render — above the boundary — so a cyclic/`BigInt` custom-widget
  // `defaultConfig` copied into `config` took down the whole tree from the very prop
  // meant to protect it.
  return (
    <StudioWidgetErrorBoundary resetKeys={[widget.config, widget.sourceId, source]}>
      <def.component widget={widget} dataSource={source} pageId={pageId} />
    </StudioWidgetErrorBoundary>
  );
}
