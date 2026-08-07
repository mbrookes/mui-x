import type { StudioController } from '@mui/x-studio-core/store';
import type { StudioChartConfig } from '../../../models';

/**
 * Which picks may re-point the widget at the picked field's source.
 *
 * `createDefaultWidget` never sets `sourceId`, so EVERY chart and map starts source-less and
 * `useWidgetRows` early-returns with no rows until something adopts one. A chart has no separate
 * source picker, so the only thing that ever can is a field pick — which is why this argument is
 * REQUIRED rather than defaulted: a new picker cannot be added without its author stating which of
 * the two policies it follows. Ten pickers silently omitted the source argument while it was
 * optional, and a "measure-first" configuration (add a chart → pick a Y measure) produced a
 * permanently blank widget with every option enabled and no warning.
 *
 * - `'anchor'` — the picker IS the widget's source anchor (the X field, the gauge value field,
 *   every gantt field, the map's region field). Any cross-source pick re-anchors the whole
 *   widget onto the picked field's source.
 * - `'if-unset'` — a NON-anchor picker (Y measure, split-by, heatmap row axis, sankey target,
 *   scatter colour/size, map value). It adopts only to give a source-less widget its first
 *   source; once anchored, a reachable cross-source pick is resolved by the anchor-grain
 *   mechanism (`analyzeChartSupport` / `resolveChartRowsForAggregation`) or, for `mixed`, by a
 *   blended `StudioChartSeries.sourceId` — re-anchoring there would orphan the X field.
 */
export type ChartSourceAdoption = 'anchor' | 'if-unset';

/**
 * Commits a chart config patch that may also ADOPT the picked field's data source.
 *
 * A chart has no separate source picker — a field pick IS how it acquires or changes its
 * source — so EVERY field picker in `ChartSetupPanel` and its per-type sections routes its
 * write through here, alongside the gauge value picker and the gantt field pickers. The
 * two-part write is the source (plus the widget-scoped filters that no longer resolve against
 * it) and the config keys the pick changed.
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
  /**
   * The source the picked field belongs to, or `undefined` when the gesture CLEARS the field
   * (clearing must never adopt anything).
   */
  sourceId: string | undefined;
  /** The widget's current source id. */
  widgetSourceId: string | undefined;
  /** Whether this picker may re-anchor the widget. See {@link ChartSourceAdoption}. */
  adopt: ChartSourceAdoption;
  /** Widget-scoped filters that no longer resolve against the adopted source. */
  removeFilterIds?: string[];
}) {
  const { controller, widgetId, configPatch, sourceId, widgetSourceId, adopt, removeFilterIds } =
    options;

  const adopts =
    !!sourceId &&
    sourceId !== widgetSourceId &&
    (adopt === 'anchor' || widgetSourceId === undefined);

  if (!adopts) {
    controller.updateWidgetConfig(widgetId, configPatch);
    return;
  }

  controller.updateWidget(widgetId, { sourceId }, { removeFilterIds });
  // Non-undoable: the undo entry pushed by the source commit above already covers this
  // half of the same gesture. A second undoable commit would make Ctrl+Z stop on the
  // intermediate state instead.
  controller.updateWidgetConfig(widgetId, configPatch, { undoable: false });
}
