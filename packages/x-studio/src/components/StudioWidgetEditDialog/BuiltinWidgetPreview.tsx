'use client';
import * as React from 'react';
import { resolveWidgetPageId } from '@mui/x-studio-core/engine';
import {
  useStudioSelector,
  selectWidgets,
  selectPages,
  selectActivePageId,
  makeSelectWidgetSource,
} from '../../context';
import { useWidgetDefMap } from '../widgets/builtinWidgetDefs';
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
  const pages = useStudioSelector(selectPages);
  const activePageId = useStudioSelector(selectActivePageId);
  // The widget's OWN page, not whichever page happens to be active. `pageId` is the
  // page SCOPE the widget renders under: `StudioFilterWidget` reads its own interactive
  // filter back with it (`makeSelectActiveInteractiveFilter(widgetId, pageId)`) while the
  // write side stamps the widget's actual page via `StudioController.resolveWidgetPageId`, so
  // when the two disagree the control writes correctly but never reads its own selection
  // back — it renders as unset immediately after the user picks a value. Every other render
  // path (`StudioCanvas`, `StudioWidgetCard`, the expand dialog) passes the widget's own
  // page; only this preview did not, and `StudioWidgetEditDialog` is publicly exported and
  // takes only a `widgetId`, so a host can legitimately open it for an off-page widget.
  //
  // Shares `resolveWidgetPageId` (`internals/widgetPageResolution.ts`) with
  // `StudioController.resolveWidgetPageIdInDoc`, including its "not in any
  // layout" fallback to the active page (a widget created but not yet placed).
  const pageId = React.useMemo(
    () => resolveWidgetPageId(pages, activePageId, widgetId),
    [pages, activePageId, widgetId],
  );
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
