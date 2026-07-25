import type { StudioChartConfig } from '../../../models';
import type { StudioController } from '../../../store/StudioController';

/**
 * Commits a chart config patch that may also ADOPT the picked field's data source.
 *
 * A chart has no separate source picker — a field pick IS how it acquires or changes its
 * source — so the shared X-field picker (`ChartSetupPanel`), the gauge value-field picker
 * and every gantt field picker all need the same two-part write: the source (plus the
 * widget-scoped filters that no longer resolve against it) and the config keys the pick
 * changed.
 *
 * Invariants upheld here:
 *
 *  - **The whole gesture is ONE undo step.** The source change (and its folded stale-filter
 *    removals) commits first and undoably, which is what pushes the pre-gesture doc onto the
 *    undo stack; the config patch then rides along non-undoably. A single Ctrl+Z therefore
 *    reverts source, filters and config together, never landing on a torn "new source, old
 *    field" state the UI never produced. The order is load-bearing: committing the config
 *    first would snapshot a doc that already carries it, so undo would revert only the
 *    source.
 *  - **Config keys retained from another chart family survive.** `updateWidget`'s `config`
 *    channel is a wholesale REPLACEMENT, so the controller re-validates everything handed to
 *    it against the widget's current chart type — replaying the full stored config through it
 *    strips exactly the cross-family keys the schema deliberately retains (a chart authored
 *    as scatter and switched to bar keeps `scatterColorField`/`scatterSizeField` so switching
 *    back restores them). Sending only the changed keys, through the merging
 *    `updateWidgetConfig` channel, leaves the retained keys untouched — the same result the
 *    identical edit already has when no source change is involved.
 *
 * The two commits exist only because the controller has no "update the source and MERGE a
 * config patch" entry point; the reducer itself already supports it (`updateWidget`'s
 * `args.config` is a patch, distinct from `args.changes.config`'s replacement). Once
 * `StudioController.updateWidget` forwards a config patch, both writes collapse into the
 * single `commitMutations` fold and this helper becomes one call.
 */
export function commitChartConfigWithSource(options: {
  controller: Pick<StudioController, 'updateWidget' | 'updateWidgetConfig'>;
  widgetId: string;
  /** ONLY the keys this gesture changes — never the widget's full stored config. */
  configPatch: Partial<StudioChartConfig>;
  /** The source the picked field belongs to. */
  sourceId: string | undefined;
  /** The widget's current source id. */
  widgetSourceId: string | undefined;
  /** Widget-scoped filters that no longer resolve against the adopted source. */
  removeFilterIds?: string[];
}) {
  const { controller, widgetId, configPatch, sourceId, widgetSourceId, removeFilterIds } = options;

  if (!sourceId || sourceId === widgetSourceId) {
    controller.updateWidgetConfig(widgetId, configPatch);
    return;
  }

  controller.updateWidget(widgetId, { sourceId }, { removeFilterIds });
  // Non-undoable: the undo entry pushed by the source commit above already covers this
  // half of the same gesture. A second undoable commit would make Ctrl+Z stop on the
  // intermediate state instead.
  controller.updateWidgetConfig(widgetId, configPatch, { undoable: false });
}
