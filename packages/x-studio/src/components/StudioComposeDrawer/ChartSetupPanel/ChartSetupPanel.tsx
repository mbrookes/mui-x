'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { normalizeChartSeries } from '@mui/x-studio-schema';
import { fieldsForCapability } from '@mui/x-studio-core/utils';
import {
  analyzeChartSupport,
  chartTypeSupportsMeasure,
  getReachableSourceIds,
  buildFieldCatalog,
} from '@mui/x-studio-core/engine';
import { useStudioFeatures } from '../../../internals/StudioUIConfigContext';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectRelationships,
  selectFilters,
  useStudioLocaleText,
} from '../../../context';
import { getChartTypeDef } from '../../widgets/StudioChartWidget/chartTypeDefs';
import type {
  StudioChartType,
  StudioBarLayout,
  StudioChartConfig,
  StudioChartWidgetConfig,
  StudioCrossFilterMode,
} from '../../../models';
import { ChartTypePicker } from '../ChartTypePicker';
import { DataSourceFieldSelect } from '../DataSourceFieldSelect';
import { CrossFilterModeSection } from '../CrossFilterModeSection';
import { collectStaleWidgetFilterIds } from '../collectStaleWidgetFilterIds';
import { GaugeConfigSection } from './GaugeConfigSection';
import { ScatterConfigSection } from './ScatterConfigSection';
import { FunnelConfigSection } from './FunnelConfigSection';
import { HeatmapAxesSection } from './HeatmapAxesSection';
import { SankeyConfigSection } from './SankeyConfigSection';
import { GanttFieldsSection } from './GanttFieldsSection';
import { AnnotationsEditorSection } from './AnnotationsEditorSection';
import { PieArcLabelsSection } from './PieArcLabelsSection';
import { SortDirectionToggle } from './SortDirectionToggle';
import { buildMeasureSeriesPatch } from './commitMeasureSeries';
import { commitChartConfigWithSource } from './commitConfigWithSource';

const sortBySourceLabel = (a: { sourceLabel: string }, b: { sourceLabel: string }) =>
  a.sourceLabel.localeCompare(b.sourceLabel);

/**
 * Orchestrator for the chart widget's setup panel: chart-type selector, fields
 * shared across (most) chart types (X field/group-by/sort, Y measure series,
 * split-by, interactions), and dispatch to the per-chart-type section
 * components for the fields that are specific to one chart type
 * (`GaugeConfigSection`, `ScatterConfigSection`, `FunnelConfigSection`,
 * `HeatmapAxesSection`, `SankeyConfigSection`, `GanttFieldsSection`,
 * `AnnotationsEditorSection`) — mirroring how `StudioChartWidget` delegates
 * per-type rendering to its own sibling files.
 */
export function ChartSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const allWidgets = useStudioSelector(selectWidgets);
  const widget = allWidgets[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);

  // MUI's `Select` emits `aria-labelledby` only when it is given a `labelId` — its `label`
  // prop merely sizes the outlined notch, and `InputLabel` generates no id of its own from
  // `FormControl` context. Without the pairing below each of these comboboxes reports no
  // accessible name at all (`combobox` is not a name-from-content role), so a screen-reader
  // user hears only the selected value. Ids are minted per mount (`React.useId`) so two
  // mounted `<Studio>` instances can't emit duplicate DOM ids — same pattern as
  // `FieldDetailView`. Declared here, unconditionally, because the controls they name are
  // rendered conditionally further down.
  const groupByLabelId = React.useId();
  const sortByLabelId = React.useId();
  const aggregationLabelId = React.useId();

  const relationships = useStudioSelector(selectRelationships);
  const allFilters = useStudioSelector(selectFilters);

  const allFields = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields),
    [dataSources, expressionFields],
  );

  // Every field EXCEPT measure expression fields.
  //
  // A measure (`isMeasure: true`) has no per-row value at all — `enrichRowsWithExpressions`
  // deliberately skips measures — so it can only ever be a chart's MEASURE, never its category
  // axis, split-by, heatmap row axis, gantt label/date, scatter colour-by, or anything else that
  // reads a value off a row. `buildFieldCatalog` defaults to `expression: 'all'` and stamps
  // `type: ef.type ?? 'number'`, which handed every measure the `numeric`/`categorical`
  // capability and therefore a slot in every picker in this panel (HIGH 1). This is the catalog
  // every DIMENSION picker below draws from.
  const dimensionFields = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields, { expression: 'non-measure' }),
    [dataSources, expressionFields],
  );

  // The shared top controls span several chart families (xField / xGroupBy / sort /
  // ySeries / seriesField / dualYAxis / annotations / crossFilterMode), so they read
  // through the flat `StudioChartConfig` patch type. `chartConfig` is the SAME object
  // viewed as the closed `StudioChartWidgetConfig` union — a bare
  // `chartConfig.chartType === 'x'` check narrows it natively to the matching family,
  // which is how each per-type section below is handed its precise family config with
  // no guard and no per-call cast. (`{}` is a valid bar-family config since that
  // family's discriminant is optional, so the `?? {}` fallback type-checks too.)
  const rawConfig = widget?.config ?? {};
  const config = rawConfig as StudioChartConfig;
  const chartConfig = rawConfig as StudioChartWidgetConfig;
  const widgetSourceId = widget?.sourceId;

  const chartType: StudioChartType = config.chartType ?? 'bar';
  const chartTypeDef = getChartTypeDef(chartType);
  // Whether THIS chart family can actually evaluate a measure expression field as its measure —
  // the single source of truth is `CHART_TYPE_MEASURE_SUPPORT` (`internals/chartSupport.ts`),
  // the same table `analyzeChartSupport` fails closed on. Scatter/heatmap/funnel/sankey/gantt
  // answer `false`, so their measure pickers must not offer a measure that would then be
  // rejected by the support guard the moment it is picked (HIGH 1).
  const measuresSupported = chartTypeSupportsMeasure(chartType);
  // The catalog the MEASURE pickers draw from: measures only where they can be evaluated.
  const measureCatalog = measuresSupported ? allFields : dimensionFields;

  // selectedXField is used to conditionally show the Group By control below, and its
  // `sourceId` anchors `reachableFields` for every other picker. Resolve it scoped to the
  // widget's OWN source first: `buildFieldCatalog` sorts by source label, so a
  // bare-id lookup across the multi-source catalog can match a related source that shares the
  // field id and sorts earlier — re-anchoring the whole panel on the wrong source and hiding
  // the widget's own valid fields. Fall back to the unscoped lookup only when the widget has
  // no source yet (the X pick will then adopt one).
  //
  // Resolved against `dimensionFields`: the X field is a dimension, so a measure sharing its id
  // must never be what the panel decides the current X field is.
  const selectedXField =
    (widgetSourceId
      ? dimensionFields.find((f) => f.id === config.xField && f.sourceId === widgetSourceId)
      : undefined) ??
    dimensionFields.find((f) => f.id === config.xField) ??
    null;
  // Gantt hides the X-field picker entirely (`config.xField` is never
  // set — see `!isGauge && !isGantt` below), so `selectedXField` never resolves and
  // `supportSourceId` stayed `undefined` forever, even after the widget's OWN source was
  // already established by an earlier gantt field pick (`GanttFieldsSection`'s `commitField`
  // adopts a source exactly like the X-field picker does for every other chart type). Fall
  // back to the widget's already-adopted `sourceId` for gantt so it gets the same
  // "anchor once a source exists" restriction every other chart type gets from its X
  // field — without this, `reachableFields` below stayed unrestricted (every source,
  // forever) for the one chart family with no visible field to naturally serve as anchor.
  const supportSourceId =
    selectedXField?.sourceId ?? (config.chartType === 'gantt' ? widgetSourceId : undefined);

  // Once the X field anchors a source, restrict all other pickers to reachable sources.
  // Applied to the MEASURE catalog, since `numericFields` (its only consumer) feeds the measure
  // pickers; the dimension pickers get their own reachability-restricted list below.
  const reachableFields = React.useMemo(() => {
    if (!supportSourceId) {
      return measureCatalog;
    }
    const reachableIds = getReachableSourceIds(supportSourceId, relationships);
    return measureCatalog.filter((f) => reachableIds.has(f.sourceId));
  }, [measureCatalog, relationships, supportSourceId]);

  const reachableDimensionFields = React.useMemo(() => {
    if (!supportSourceId) {
      return dimensionFields;
    }
    const reachableIds = getReachableSourceIds(supportSourceId, relationships);
    return dimensionFields.filter((f) => reachableIds.has(f.sourceId));
  }, [dimensionFields, relationships, supportSourceId]);

  const numericFields = React.useMemo(
    () => fieldsForCapability(reachableFields, 'numeric').sort(sortBySourceLabel),
    [reachableFields],
  );

  // Split-by / colour-by / sankey-target are DIMENSIONS — never a measure, whatever type it
  // declares (`buildFieldCatalog` stamps `type: ef.type ?? 'number'`, so a measure declared
  // `type: 'string'` would otherwise land here with the `categorical` capability).
  const categoryFields = React.useMemo(
    () => fieldsForCapability(reachableDimensionFields, 'categorical').sort(sortBySourceLabel),
    [reachableDimensionFields],
  );

  const dateFields = React.useMemo(
    () =>
      reachableDimensionFields
        .filter((f) => f.type === 'date' || f.type === 'datetime')
        .sort(sortBySourceLabel),
    [reachableDimensionFields],
  );

  // Heatmap Y axis: any field type, but restricted to the primary source so that aggregateHeatmap()
  // can resolve values directly from the row objects. With no primary source yet the restriction
  // would match NOTHING (`f.sourceId === undefined` is never true), leaving this required picker
  // empty on a brand-new heatmap — offer the whole catalog instead, exactly as the X-field picker
  // does, since the pick establishes the source it is then restricted to. Drawn from
  // `dimensionFields`: the heatmap row axis buckets rows by a per-row value, which a measure does
  // not have.
  const heatYFields = React.useMemo(
    () =>
      widgetSourceId
        ? dimensionFields.filter((f) => f.sourceId === widgetSourceId).sort(sortBySourceLabel)
        : [...dimensionFields].sort(sortBySourceLabel),
    [dimensionFields, widgetSourceId],
  );

  const isHorizontalBarChart =
    (chartType === 'bar' || chartType === 'bar-stacked' || chartType === 'bar-100') &&
    config.barLayout === 'horizontal';

  // Y series: prefer ySeries, else seed from yField
  const ySeries = React.useMemo(
    () => config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []),
    [config.ySeries, config.yField],
  );

  // Stable, collision-free React keys for the Y-series rows. Keying on `fieldId` alone
  // collided on a blended mixed chart, where two series legitimately reference the SAME
  // field id from two DIFFERENT sources (`StudioChartSeries.sourceId`): React then treated
  // the two rows as one, so removing the first row left the second rendering the removed
  // row's buffered picker state. Qualify by source, and disambiguate any remaining exact
  // duplicate (a doc/AI-authored config can carry one even though the picker's
  // `usedYFieldIds` guard prevents creating one in the UI) with an occurrence counter.
  const ySeriesKeys = React.useMemo(() => {
    const seen = new Map<string, number>();
    return ySeries.map((s, index) => {
      const base = `${s.sourceId ?? ''}::${s.fieldId || `series-${index}`}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return occurrence === 0 ? base : `${base}#${occurrence}`;
    });
  }, [ySeries]);

  // Blended mixed charts carry foreign-source series
  // (`StudioChartSeries.sourceId`). The renderer resolves those separately
  // (`useChartWidgetData.ts` `activeYFields`) and validates only native-source fields
  // against the widget's own source. The panel must validate the SAME field set —
  // feeding a foreign series id into `analyzeChartSupport` against the widget's own
  // source spuriously reports the chart "unsupported" (and disables valid options)
  // while the canvas renders fine.
  const nativeYFieldIds = React.useMemo(
    () =>
      ySeries.flatMap((series) =>
        series.fieldId && !(series.sourceId && series.sourceId !== widgetSourceId)
          ? [series.fieldId]
          : [],
      ),
    [ySeries, widgetSourceId],
  );

  const supportsMultipleSeries =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100' ||
    chartType === 'mixed';

  const supportsSeriesField =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100' ||
    chartType === 'pie' ||
    chartType === 'donut';

  // BL-186: a "count" aggregation tallies rows and needs no measure field, so a chart with
  // an X field but no Y field is valid — it renders a row count per category (e.g. "contacts
  // by department" over a source with no visible numeric field). When no Y field is chosen we
  // lock the aggregation to Count; picking a field re-derives the usual per-field aggregation.
  const hasYField = ySeries.some((s) => s.fieldId);
  const isFieldlessCount = !hasYField && config.yAggregation === 'count';

  // Split-by is mutually exclusive with multiple Y-series: keep the control
  // visible so users can see why it's unavailable, but disable it. It is also
  // unavailable for a fieldless count — aggregateByTwoFields sums the measure and
  // can't tally rows, so a split-by + no-field-count would render an empty chart.
  const seriesFieldDisabled = ySeries.length > 1 || isFieldlessCount;

  const isScatter = chartType === 'scatter';

  // Dimension-like fields that the non-xy chart families (heatmap / funnel / sankey / gantt)
  // actually read but that are not expressed via x / y / series. Mirrors
  // `useChartWidgetData.ts`'s `chartTypeExtraFields` exactly so the panel's support check
  // validates the same fields the canvas renderer does — otherwise picking an unresolvable
  // cross-source `heatYField` (or another extra field) shows no warning here while the
  // rendered widget falls back to the "unsupported chart configuration" overlay.
  //
  const chartTypeExtraFields = React.useMemo((): (string | undefined)[] => {
    switch (chartType) {
      case 'heatmap':
        return [config.heatYField];
      case 'funnel':
        return [config.funnelReachedField];
      case 'sankey':
        return [config.sankeyTargetField];
      case 'gantt':
        return [
          config.ganttLabelField,
          config.ganttStartField,
          config.ganttEndField,
          config.ganttColorField,
        ];
      default:
        return [];
    }
  }, [
    chartType,
    config.heatYField,
    config.funnelReachedField,
    config.sankeyTargetField,
    config.ganttLabelField,
    config.ganttStartField,
    config.ganttEndField,
    config.ganttColorField,
  ]);

  const chartSupport = React.useMemo(
    () =>
      analyzeChartSupport(
        widgetSourceId ?? supportSourceId,
        config.xField,
        nativeYFieldIds,
        config.seriesField,
        chartType,
        dataSources,
        relationships,
        expressionFields,
        config.scatterColorField,
        config.scatterSizeField,
        chartTypeExtraFields,
      ),
    [
      widgetSourceId,
      supportSourceId,
      config.xField,
      nativeYFieldIds,
      config.seriesField,
      chartType,
      dataSources,
      relationships,
      expressionFields,
      config.scatterColorField,
      config.scatterSizeField,
      chartTypeExtraFields,
    ],
  );

  const analyzeCombination = React.useCallback(
    (overrides: {
      // Anchor the support check on a DIFFERENT source than the widget's current one. Used
      // by the X-field picker to validate an unrelated-source candidate against the source it
      // would ADOPT on selection, instead of the current (old) source.
      sourceId?: string | undefined;
      xField?: string | undefined;
      yFields?: string[];
      seriesField?: string | undefined;
      scatterColorField?: string | undefined;
      scatterSizeField?: string | undefined;
      extraFields?: (string | undefined)[];
    }) =>
      // Every optional-string override MUST be merged with a KEY-PRESENCE check, not
      // `??`. These overrides are all `string | undefined`, so `??` collapses "explicitly
      // cleared" into "not supplied" and silently re-injects the current config value —
      // defeating the one thing the caller asked for. The X-field picker's unrelated-source
      // branch below passes `seriesField: undefined` precisely so the candidate is validated
      // ALONE against the source it would adopt; with `??` the widget's existing split-by
      // field was re-anchored on the new source, reported `field_not_found_or_not_direct`,
      // and disabled EVERY unrelated-source X option — permanently locking a chart (which
      // has no separate source picker) to its current source, with no explanation shown.
      // `yFields`/`extraFields` are arrays, so `[]` is already distinguishable from absent.
      analyzeChartSupport(
        // `sourceId` is exempt: there is no "no anchor" override semantics — an absent
        // anchor always falls back to the widget's own source.
        overrides.sourceId ?? widgetSourceId ?? supportSourceId,
        'xField' in overrides ? overrides.xField : config.xField,
        overrides.yFields ?? nativeYFieldIds,
        'seriesField' in overrides ? overrides.seriesField : config.seriesField,
        chartType,
        dataSources,
        relationships,
        expressionFields,
        'scatterColorField' in overrides ? overrides.scatterColorField : config.scatterColorField,
        'scatterSizeField' in overrides ? overrides.scatterSizeField : config.scatterSizeField,
        overrides.extraFields ?? chartTypeExtraFields,
      ),
    [
      widgetSourceId,
      supportSourceId,
      config.xField,
      config.seriesField,
      config.scatterColorField,
      config.scatterSizeField,
      nativeYFieldIds,
      chartType,
      dataSources,
      relationships,
      expressionFields,
      chartTypeExtraFields,
    ],
  );

  const handleChartTypeChange = (newType: StudioChartType, newBarLayout?: StudioBarLayout) => {
    controller.updateWidgetConfig(widgetId, {
      chartType: newType,
      barLayout: newBarLayout,
    });
  };

  const usedYFieldIds = ySeries.flatMap((s) => (s.fieldId ? [s.fieldId] : []));

  const handleAddSeries = () => {
    controller.updateWidgetConfig(widgetId, { ySeries: [...ySeries, { fieldId: '' }] });
  };

  // Widget-scoped filters that stop resolving once the widget adopts `sourceId`. Left in
  // place, a stale filter's field is absent from the new source's rows and the `between`/`gte`
  // date branches in `filterUtils.ts` then exclude EVERY row, silently blanking the chart.
  // Folded into the same undoable commit as the adoption.
  const staleFilterIdsFor = (sourceId: string) =>
    collectStaleWidgetFilterIds(allFilters, widgetId, sourceId, allFields, relationships);

  // The single commit path for every NON-anchor field pick in this panel and its
  // per-type sections (Y measure, split-by, and the scatter / funnel / heatmap / sankey
  // sections' own pickers, which receive it as a required prop).
  //
  // `createDefaultWidget` never sets `sourceId`, so a chart starts source-less and renders
  // permanently blank until something adopts one — and the X-field picker is not always the
  // control the user reaches for first. A "measure-first" gesture (add a chart → pick a Y
  // measure) used to write the field and nothing else: no source, no rows, no warning, every
  // option still enabled. These pickers therefore adopt too — but only `'if-unset'`, never
  // re-anchoring a chart that already has a source, because a reachable cross-source measure
  // is resolved by the anchor-grain mechanism and re-anchoring would orphan the X field.
  const commitFieldConfig = (
    configPatch: Partial<StudioChartConfig>,
    /** The picked field's source, or `undefined` when the gesture clears the field. */
    sourceId: string | undefined,
  ) => {
    commitChartConfigWithSource({
      controller,
      widgetId,
      configPatch,
      sourceId,
      widgetSourceId,
      adopt: 'if-unset',
      removeFilterIds: !widgetSourceId && sourceId ? staleFilterIdsFor(sourceId) : undefined,
    });
  };

  // Shared "commit ySeries + derive yField/yAggregation" transition used by both handlers
  // below, so neither can miss the BL-186 fieldless-count re-lock or the own-source `yField`
  // mirror. The patch shape itself lives in `buildMeasureSeriesPatch`,
  // which the single-measure sections (scatter / funnel / heatmap / sankey) share — see that
  // module for the invariants.
  const commitYSeries = (next: typeof ySeries) => {
    controller.updateWidgetConfig(
      widgetId,
      buildMeasureSeriesPatch(chartType, next, widgetSourceId),
    );
  };

  const handleRemoveSeries = (index: number) => {
    commitYSeries(ySeries.filter((_, i) => i !== index));
  };

  const handleSeriesFieldChange = (index: number, fieldId: string, sourceId: string) => {
    // Set/clear the series' `sourceId` from the PICKED field's source rather
    // than preserving a stale foreign one. An own-source pick clears `sourceId` (native
    // series); a foreign-source pick stamps it (blended series). Preserving the previous
    // foreign `sourceId` after re-pointing at an own-source field made the renderer
    // aggregate the new field against the OLD source's rows → a silent all-zero series.
    //
    // `StudioChartSeries.sourceId` is documented
    // (widgetTypes.ts) and implemented (`useBlendedSeriesRows.ts`'s `isBlended` gate) as
    // ONLY honoured when `chartType === 'mixed'` — that's the one family that independently
    // aggregates a foreign series in its own source and outer-joins it onto the shared x-axis.
    // Every other chart type resolves a cross-source Y field through the anchor-based grain
    // mechanism instead (`analyzeChartSupport`/`resolveChartRowsForAggregation`, already gating
    // this very picker's `getOptionDisabled` below), which needs no `sourceId` stamp. Stamping
    // it unconditionally on non-mixed types silently broke two things: `commitYSeries`'s
    // native-only mirror wrote `yField: ''` (losing the legacy single-series field), and this
    // panel's OWN `nativeYFieldIds` then permanently excluded the series from its future support
    // checks. Restrict the stamp to `mixed` so a non-mixed pick commits the same sourceId-less
    // shape the empty-list Y picker below already uses for the identical gesture.
    //
    // `widgetSourceId &&` is load-bearing on a source-LESS widget. There the pick adopts
    // the field's source (see `commitFieldConfig`), so the series becomes native and stamping
    // it would immediately make it foreign to the source it just established — excluding it
    // from `nativeYFieldIds` and writing `yField: ''`.
    const nextSourceId =
      chartType === 'mixed' && sourceId && widgetSourceId && sourceId !== widgetSourceId
        ? sourceId
        : undefined;
    const next = ySeries.map((s, i) =>
      i === index ? { ...s, fieldId, sourceId: nextSourceId } : s,
    );
    // The measure patch is derived against the source the widget will HAVE after this
    // gesture, so a field picked onto a source-less chart counts as own-source for the
    // `yField` mirror rather than being dropped as foreign.
    commitFieldConfig(
      buildMeasureSeriesPatch(chartType, next, widgetSourceId ?? sourceId),
      fieldId ? sourceId : undefined,
    );
  };

  const handleSeriesTypeChange = (index: number, seriesType: 'bar' | 'line') => {
    // Write the canonical `type` field (not the deprecated `seriesType` alias) so
    // `normalizeChartSeries`'s type-wins precedence reflects this change even if a
    // stale `seriesType` is still present on the series.
    const next = ySeries.map((s, i) => (i === index ? { ...s, type: seriesType } : s));
    controller.updateWidgetConfig(widgetId, { ySeries: next });
  };

  const isPieOrDonut = chartType === 'pie' || chartType === 'donut';
  let seriesFieldHelperText = localeText.chartSetupSplitByHelperText;
  if (isFieldlessCount) {
    seriesFieldHelperText = localeText.chartSetupSplitByFieldlessCountHelperText;
  } else if (seriesFieldDisabled) {
    seriesFieldHelperText = localeText.chartSetupSplitByDisabledHelperText;
  } else if (isPieOrDonut) {
    seriesFieldHelperText = localeText.chartSetupInnerRingHelperText;
  } else {
    seriesFieldHelperText = localeText.chartSetupSplitByHelperText;
  }
  let seriesFieldDisabledTooltip = '';
  if (isFieldlessCount) {
    seriesFieldDisabledTooltip = localeText.chartSetupFieldlessCountSplitByTooltip;
  } else if (seriesFieldDisabled) {
    seriesFieldDisabledTooltip = localeText.chartSetupRemoveSplitByTooltip;
  }
  // See the `CrossFilterModeSection` call site at the bottom of this file for the reasoning.
  const crossFilterModes: StudioCrossFilterMode[] = chartTypeDef.supportsGhost
    ? ['cross-highlight', 'cross-filter', 'none']
    : ['cross-filter', 'none'];
  const crossFilterDefaultMode: StudioCrossFilterMode = chartTypeDef.supportsGhost
    ? 'cross-highlight'
    : 'cross-filter';

  const isGauge = chartType === 'gauge';
  const isMixed = chartType === 'mixed';
  const isHeatmap = chartType === 'heatmap';
  const isFunnel = chartType === 'funnel';
  const isGantt = chartType === 'gantt';
  const isSankey = chartType === 'sankey';

  // `widget.sourceId` is doc-authored: guard the record index against inherited prototype keys
  // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
  // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
  const widgetSource =
    widget?.sourceId && Object.hasOwn(dataSources, widget.sourceId)
      ? dataSources[widget.sourceId]
      : undefined;
  // BL-179/180: calculated-field context for the in-dropdown "Add calculated field…"
  // entry on the Y-measure pickers. Gated to chart types that take measure fields and
  // to the calculatedFields feature flags. reachableSourceIds scopes operands (BL-180).
  const calcFieldsEnabled =
    !isScatter &&
    !isPieOrDonut &&
    !isGauge &&
    !isHeatmap &&
    !isFunnel &&
    !isGantt &&
    !isSankey &&
    widgetSource !== undefined &&
    features.calculatedFields !== false &&
    features.chartCalculatedFields !== false;
  const calculatedFieldContext = React.useMemo(() => {
    if (!calcFieldsEnabled || !widgetSource) {
      return undefined;
    }
    return {
      dataSource: widgetSource,
      expressionFields,
      reachableSourceIds: getReachableSourceIds(widgetSource.id, relationships),
    };
  }, [calcFieldsEnabled, widgetSource, expressionFields, relationships]);

  if (allFields.length === 0) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        {localeText.chartSetupNoDataAlert}
      </Alert>
    );
  }

  // Computed labels to avoid nested ternaries in JSX
  let xFieldLabel: string;
  if (isSankey) {
    xFieldLabel = localeText.chartSetupSankeySourceLabel;
  } else if (isScatter) {
    xFieldLabel = localeText.chartSetupXFieldNumericLabel;
  } else if (isPieOrDonut) {
    xFieldLabel = localeText.chartSetupXFieldPieDonutLabel;
  } else if (isFunnel) {
    xFieldLabel = localeText.chartSetupXFieldFunnelLabel;
  } else if (isHorizontalBarChart) {
    xFieldLabel = localeText.chartSetupXFieldCategoryVertLabel;
  } else {
    xFieldLabel = localeText.chartSetupXFieldCategoryHorizLabel;
  }

  let xFieldHelperText: string;
  if (isSankey) {
    xFieldHelperText = localeText.chartSetupSankeySourceHelperText;
  } else if (isScatter) {
    xFieldHelperText = localeText.chartSetupXFieldHorizontalHelperText;
  } else if (isPieOrDonut) {
    xFieldHelperText = localeText.chartSetupXFieldPieDonutHelperText;
  } else if (isFunnel) {
    xFieldHelperText = localeText.chartSetupXFieldFunnelHelperText;
  } else if (isHorizontalBarChart) {
    xFieldHelperText = localeText.chartSetupXFieldGroupVertHelperText;
  } else {
    xFieldHelperText = localeText.chartSetupXFieldGroupHorizHelperText;
  }

  let yMeasureLabel: string;
  if (isPieOrDonut) {
    yMeasureLabel = localeText.chartSetupYMeasurePieDonutLabel;
  } else if (supportsMultipleSeries) {
    yMeasureLabel = isHorizontalBarChart
      ? localeText.chartSetupXMeasureFieldsLabel
      : localeText.chartSetupYMeasureFieldsLabel;
  } else {
    yMeasureLabel = isHorizontalBarChart
      ? localeText.chartSetupXMeasureFieldLabel
      : localeText.chartSetupYMeasureFieldLabel;
  }

  const ySeriesLabelBase = isHorizontalBarChart
    ? localeText.chartSetupXMeasureFieldLabel
    : localeText.chartSetupYMeasureFieldLabel;

  const firstYSeriesFieldId = ySeries[0]?.fieldId;

  return (
    <Stack spacing={2}>
      {!chartSupport.supported && chartSupport.reason ? (
        <Alert severity="warning">
          {(() => {
            // Mirror the canvas renderer's reason → locale-key mapping
            // (StudioChartWidget.tsx) instead of the raw English `getChartSupportMessage`.
            switch (chartSupport.reason) {
              case 'field_not_found_or_not_direct':
                return localeText.chartUnsupportedFieldNotFound;
              case 'mixed_cross_source_fields':
                return localeText.chartUnsupportedMixedCrossSource;
              case 'scatter_cross_source_not_supported':
                return localeText.chartUnsupportedScatterCrossSource;
              case 'measure_not_supported':
                return localeText.chartUnsupportedMeasure;
              default:
                return localeText.chartUnsupportedDefault;
            }
          })()}
        </Alert>
      ) : null}

      {/* Chart type icon picker */}
      <ChartTypePicker
        chartType={chartType}
        barLayout={config.barLayout}
        onChange={handleChartTypeChange}
      />

      <Divider />

      {/* Gauge chart setup */}
      {chartConfig.chartType === 'gauge' && (
        <GaugeConfigSection
          widgetId={widgetId}
          config={chartConfig}
          allFields={allFields}
          widgetSourceId={widgetSourceId}
          allFilters={allFilters}
          relationships={relationships}
        />
      )}

      {/* Standard (non-gauge, non-gantt) fields */}
      {!isGauge && !isGantt && (
        <Stack spacing={2}>
          {/* X field */}
          <DataSourceFieldSelect
            value={config.xField ?? ''}
            // `widgetSourceId` is the natural disambiguator already in scope here
            // (mirrors `selectedXField`'s own own-source-first resolution above) — passing it
            // stops a same-id field from a different, merely-reachable source from being
            // silently displayed as the current X field.
            valueSourceId={widgetSourceId}
            onChange={(fieldId, sourceId) => {
              // BL-186: picking the X field anchors the source. For a standard category
              // chart with no measure field yet, seed a fieldless row "count" so the chart
              // renders immediately (mirrors the KPI source-picker side effect) — building a
              // count chart from scratch needs no numeric Y field. Selecting a Y field later
              // clears this back to the per-field aggregation. Scatter/funnel/heatmap/sankey
              // have their own measure pickers, so they're excluded (supportsMultipleSeries).
              const seedFieldlessCount =
                fieldId && (supportsMultipleSeries || isPieOrDonut) && !hasYField;
              const configUpdate = {
                xField: fieldId,
                ...(seedFieldlessCount && { yAggregation: 'count' as const }),
              };
              // The X-field pick and the source adoption it implies are ONE undo step,
              // and only the keys this pick changes are sent — never the
              // widget's full stored config, which would be re-validated against the current
              // chart type and lose the keys the schema deliberately retains from another
              // chart family. See `commitChartConfigWithSource` for both invariants.
              //
              // The removal of any widget-scoped filter that no longer resolves against the
              // new source rides along in the same step — left in place, a
              // stale filter's field would be absent from the new source's rows and the
              // `between`/`gte` date branches in `filterUtils.ts` would then exclude every
              // row, silently blanking the chart.
              commitChartConfigWithSource({
                controller,
                widgetId,
                configPatch: configUpdate,
                sourceId: fieldId ? sourceId : undefined,
                widgetSourceId,
                // The X field IS the chart's source anchor, so ANY cross-source pick
                // re-anchors the widget — unlike the measure/split-by pickers, which adopt
                // only when there is no anchor yet.
                adopt: 'anchor',
                removeFilterIds:
                  sourceId && sourceId !== widgetSourceId ? staleFilterIdsFor(sourceId) : undefined,
              });
            }}
            // `dimensionFields`, not `allFields`: the X field is the chart's category (or, for
            // scatter, its per-row horizontal coordinate) — both read a value off each row, which
            // a measure has none of.
            fields={isScatter ? fieldsForCapability(dimensionFields, 'numeric') : dimensionFields}
            getOptionDisabled={(option) => {
              // Exempt the CURRENT selection from validation by id AND sourceId, not
              // id alone — an id-only check lets an invalid unrelated-source candidate that
              // merely shares the current X field's id (e.g. two sources both having an `id`
              // field) slip through as "always enabled" regardless of its own validity.
              if (option.id === config.xField && option.sourceId === selectedXField?.sourceId) {
                return false;
              }
              // A chart has no separate source picker — the X field IS how it adopts a
              // source. When the candidate belongs to an unrelated source, selecting it
              // adopts that source (see onChange), so validate the candidate against its OWN
              // source as anchor. Anchoring on the current (old) source reports every
              // unrelated-source field `field_not_found_or_not_direct` and would disable the
              // panel's own adoption path forever. The candidate's X field is
              // validated alone; the post-adoption Y/split-by validity surfaces via the
              // panel's support warning, where the user re-points those fields.
              //
              // EVERY other field must be explicitly cleared here, `scatterColorField`
              // and `scatterSizeField` included — any one of them left anchored on the old
              // source reports `field_not_found_or_not_direct` and disables the candidate,
              // which is exactly the adoption path this branch exists to keep open.
              const currentAnchor = widgetSourceId ?? supportSourceId;
              if (option.sourceId !== currentAnchor) {
                return !analyzeCombination({
                  sourceId: option.sourceId,
                  xField: option.id,
                  yFields: [],
                  seriesField: undefined,
                  scatterColorField: undefined,
                  scatterSizeField: undefined,
                  extraFields: [],
                }).supported;
              }
              return !analyzeCombination({ xField: option.id }).supported;
            }}
            label={xFieldLabel}
            helperText={xFieldHelperText}
            required
          />

          {/* Group by — shown only when x field is a date/datetime type. Excluded for
              funnel and scatter: neither `buildFunnelStages`
              nor `prepareScatterData`/`prepareScatterDataGrouped` take an `xGroupBy`
              argument, so a write here would render with no effect while
              `FUNNEL_CHART_KEYS`/`SCATTER_CHART_KEYS` correctly omit the key — adding
              the key to either allow-list would just move the dead-control problem
              rather than fix it. */}
          {!isSankey &&
            !isFunnel &&
            !isScatter &&
            (selectedXField?.type === 'date' || selectedXField?.type === 'datetime') && (
              <FormControl size="small" fullWidth>
                <InputLabel id={groupByLabelId}>{localeText.chartSetupGroupByLabel}</InputLabel>
                <Select
                  labelId={groupByLabelId}
                  label={localeText.chartSetupGroupByLabel}
                  value={config.xGroupBy ?? ''}
                  onChange={(evt) => {
                    const val = evt.target.value as string;
                    controller.updateWidgetConfig(widgetId, {
                      xGroupBy: val
                        ? (val as 'day' | 'week' | 'month' | 'quarter' | 'year')
                        : undefined,
                    });
                  }}
                >
                  <MenuItem value="">{localeText.timeGranNone}</MenuItem>
                  <MenuItem value="day">{localeText.timeGranDay}</MenuItem>
                  <MenuItem value="week">{localeText.timeGranWeek}</MenuItem>
                  <MenuItem value="month">{localeText.timeGranMonth}</MenuItem>
                  <MenuItem value="quarter">{localeText.timeGranQuarter}</MenuItem>
                  <MenuItem value="year">{localeText.timeGranYear}</MenuItem>
                </Select>
              </FormControl>
            )}

          {/* Sort controls — shown when x-field is set on categorical charts (not scatter, not heatmap, not gauge, not gantt, not sankey) */}
          {config.xField && !isScatter && !isHeatmap && !isSankey && (
            <Stack direction="column" spacing={1}>
              <FormControl size="small" fullWidth>
                <InputLabel id={sortByLabelId}>{localeText.chartSetupSortByLabel}</InputLabel>
                <Select
                  labelId={sortByLabelId}
                  label={localeText.chartSetupSortByLabel}
                  value={config.chartSortBy ?? 'category'}
                  onChange={(evt) => {
                    controller.updateWidgetConfig(widgetId, {
                      chartSortBy: evt.target.value as 'category' | 'value' | 'natural',
                    });
                  }}
                  SelectDisplayProps={{
                    title: (() => {
                      const sortBy = config.chartSortBy ?? 'category';
                      if (sortBy === 'category') {
                        return selectedXField?.label ?? localeText.chartSetupSortCategory;
                      }
                      if (sortBy === 'value') {
                        return localeText.chartSetupSortValue;
                      }
                      return localeText.chartSetupSortNatural;
                    })(),
                  }}
                >
                  <MenuItem value="category">
                    {selectedXField?.label ?? localeText.chartSetupSortCategory}
                  </MenuItem>
                  <MenuItem value="value">{localeText.chartSetupSortValue}</MenuItem>
                  <MenuItem value="natural">{localeText.chartSetupSortNatural}</MenuItem>
                </Select>
              </FormControl>
              {/* Sort direction — funnel has no sort DIRECTION concept (only chartSortBy);
                  StudioFunnelChartConfig deliberately omits chartSortDirection, so the
                  toggle is hidden for funnel rather than writing a key the funnel
                  aggregation never reads. */}
              {!isFunnel && (config.chartSortBy ?? 'category') !== 'natural' && (
                <SortDirectionToggle
                  value={config.chartSortDirection ?? 'asc'}
                  onChange={(val) =>
                    controller.updateWidgetConfig(widgetId, { chartSortDirection: val })
                  }
                />
              )}
            </Stack>
          )}

          {/* Scatter: single Y field + optional color-by */}
          {chartConfig.chartType === 'scatter' && (
            <ScatterConfigSection
              widgetId={widgetId}
              config={chartConfig}
              numericFields={numericFields}
              categoryFields={categoryFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
              widgetSourceId={widgetSourceId}
              commitFieldConfig={commitFieldConfig}
            />
          )}

          {/* Funnel: single value/measure field + visual options */}
          {chartConfig.chartType === 'funnel' && (
            <FunnelConfigSection
              widgetId={widgetId}
              config={chartConfig}
              numericFields={numericFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
              widgetSourceId={widgetSourceId}
              commitFieldConfig={commitFieldConfig}
            />
          )}

          {/* Heatmap: row axis field + colour-value measure */}
          {chartConfig.chartType === 'heatmap' && (
            <HeatmapAxesSection
              widgetId={widgetId}
              config={chartConfig}
              heatYFields={heatYFields}
              numericFields={numericFields}
              allFields={allFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
              widgetSourceId={widgetSourceId}
              commitFieldConfig={commitFieldConfig}
            />
          )}

          {/* Sankey: target node field + value measure + link options */}
          {chartConfig.chartType === 'sankey' && (
            <SankeyConfigSection
              widgetId={widgetId}
              config={chartConfig}
              categoryFields={categoryFields}
              numericFields={numericFields}
              firstYSeriesFieldId={firstYSeriesFieldId}
              widgetSourceId={widgetSourceId}
              commitFieldConfig={commitFieldConfig}
            />
          )}

          {/* Y series — for non-scatter, non-gauge, non-heatmap, non-funnel, non-sankey charts */}
          {!isScatter && !isHeatmap && !isFunnel && !isSankey && (
            <div>
              <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                  {yMeasureLabel}
                </Typography>
                {supportsMultipleSeries && (
                  <Tooltip
                    title={
                      usedYFieldIds.length >= numericFields.length
                        ? localeText.chartSetupNoMoreFields
                        : localeText.chartSetupAddSeries
                    }
                  >
                    {/* The Tooltip wraps a `<span>` (the MUI idiom for keeping a tooltip on a
                        disabled control), so the name Tooltip generates lands on the roleless
                        span and never reaches the button — which therefore announced as a bare
                        "button" even when enabled (WCAG 4.1.2). Name the button directly. */}
                    <span>
                      <IconButton
                        size="small"
                        onClick={handleAddSeries}
                        disabled={usedYFieldIds.length >= numericFields.length}
                        aria-label={localeText.chartSetupAddSeries}
                      >
                        <AddIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
              </Stack>
              <Stack spacing={1}>
                {ySeries.map((s, index) => (
                  <React.Fragment key={ySeriesKeys[index]}>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                      <DataSourceFieldSelect
                        value={s.fieldId ?? ''}
                        // A blended series already carries its own `sourceId` (falling
                        // back to the widget's own source for a native series) — a natural,
                        // already-in-scope disambiguator, so thread it through the same way
                        // `fieldOwners`/`nativeYFieldIds` above already key off it.
                        valueSourceId={s.sourceId ?? widgetSourceId}
                        onChange={(fieldId, sourceId) =>
                          handleSeriesFieldChange(index, fieldId, sourceId)
                        }
                        fields={numericFields}
                        getOptionDisabled={(option) =>
                          (option.id !== s.fieldId && usedYFieldIds.includes(option.id)) ||
                          (option.id !== s.fieldId &&
                            !analyzeCombination({
                              // Mirror the support memo: validate only native-source series,
                              // with the candidate option taking this slot.
                              yFields: ySeries.flatMap((series, seriesIndex) => {
                                if (seriesIndex === index) {
                                  return option.id ? [option.id] : [];
                                }
                                if (series.sourceId && series.sourceId !== widgetSourceId) {
                                  return [];
                                }
                                return series.fieldId ? [series.fieldId] : [];
                              }),
                            }).supported)
                        }
                        label={
                          ySeries.length > 1
                            ? localeText.chartSetupSeriesLabel(index)
                            : ySeriesLabelBase
                        }
                        helperText={
                          isHorizontalBarChart
                            ? localeText.chartSetupSeriesNumericHorizHelperText
                            : localeText.chartSetupSeriesNumericSumHelperText
                        }
                        calculatedField={calculatedFieldContext}
                      />
                      {ySeries.length > 1 && (
                        <Tooltip title={localeText.chartSetupRemoveSeries}>
                          <IconButton
                            size="small"
                            aria-label={localeText.chartSetupRemoveSeries}
                            onClick={() => handleRemoveSeries(index)}
                            sx={{ mt: 1 }}
                          >
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
                    {isMixed && s.fieldId && (
                      <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={normalizeChartSeries(s).type ?? 'bar'}
                        onChange={(_, val) => {
                          if (val) {
                            handleSeriesTypeChange(index, val);
                          }
                        }}
                        sx={{ mt: 0.5, mb: 0.5 }}
                      >
                        <ToggleButton
                          value="bar"
                          sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}
                        >
                          {localeText.chartSetupMixedSeriesBar}
                        </ToggleButton>
                        <ToggleButton
                          value="line"
                          sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}
                        >
                          {localeText.chartSetupMixedSeriesLine}
                        </ToggleButton>
                      </ToggleButtonGroup>
                    )}
                  </React.Fragment>
                ))}
                {ySeries.length === 0 && (
                  <DataSourceFieldSelect
                    value=""
                    onChange={(fieldId, sourceId) => {
                      // Picking a measure field re-derives the usual per-field aggregation
                      // (sum, or count for non-numeric fields — handled by aggregateByField),
                      // so drop the fieldless-count lock. See BL-186.
                      //
                      // This is the picker a "measure-first" gesture reaches first on a
                      // brand-new chart, so it must adopt the picked field's source — it used
                      // not even to destructure `sourceId`, leaving the widget source-less and
                      // permanently blank.
                      commitFieldConfig(
                        {
                          ySeries: [{ fieldId }],
                          yField: fieldId,
                          yAggregation: undefined,
                        },
                        fieldId ? sourceId : undefined,
                      );
                    }}
                    fields={numericFields}
                    getOptionDisabled={(option) =>
                      !analyzeCombination({ yFields: [option.id] }).supported
                    }
                    label={ySeriesLabelBase}
                    helperText={
                      isHorizontalBarChart
                        ? localeText.chartSetupSeriesNumericHorizHelperText
                        : localeText.chartSetupSeriesNumericSumHelperText
                    }
                    calculatedField={calculatedFieldContext}
                  />
                )}
                {/* BL-186: with no measure field, the only meaningful aggregation is a row
                    "count" — it needs no field. Offer it as an explicit, reproducible state
                    (a locked Count select) so a count chart can be built from scratch even on
                    a source with no visible numeric field. Single-series charts only; split-by
                    and multi-Y can't tally rows, so they aren't offered fieldless. */}
                {!hasYField && (supportsMultipleSeries || isPieOrDonut) && (
                  <FormControl size="small" fullWidth disabled>
                    <InputLabel id={aggregationLabelId}>
                      {localeText.chartSetupAggregationLabel}
                    </InputLabel>
                    <Select
                      labelId={aggregationLabelId}
                      label={localeText.chartSetupAggregationLabel}
                      value="count"
                    >
                      <MenuItem value="count">{localeText.aggFnCount}</MenuItem>
                    </Select>
                    <FormHelperText>{localeText.aggregationLockedHelperText}</FormHelperText>
                  </FormControl>
                )}
              </Stack>
            </div>
          )}
          {/* Dual Y axis toggle — only for mixed chart with 2+ series */}
          {isMixed && ySeries.filter((s) => s.fieldId).length >= 2 && (
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={config.dualYAxis ?? false}
                  onChange={(event) =>
                    controller.updateWidgetConfig(widgetId, { dualYAxis: event.target.checked })
                  }
                />
              }
              label={<Typography variant="caption">{localeText.chartSetupDualYAxis}</Typography>}
              sx={{ ml: 0 }}
            />
          )}
          {/* Split by / series field */}
          {supportsSeriesField && (
            <div>
              <Tooltip title={seriesFieldDisabledTooltip} placement="top">
                <span>
                  <DataSourceFieldSelect
                    value={config.seriesField ?? ''}
                    onChange={(fieldId, sourceId) =>
                      commitFieldConfig(
                        { seriesField: fieldId || undefined },
                        fieldId ? sourceId : undefined,
                      )
                    }
                    fields={categoryFields}
                    getOptionDisabled={(option) => {
                      if (seriesFieldDisabled) {
                        return true;
                      }
                      if (option.id === config.seriesField) {
                        return false;
                      }
                      return !analyzeCombination({ seriesField: option.id }).supported;
                    }}
                    disabled={seriesFieldDisabled}
                    label={
                      isPieOrDonut
                        ? localeText.chartSetupInnerRingLabel
                        : localeText.chartSetupSplitByLabel
                    }
                    helperText={seriesFieldHelperText}
                  />
                </span>
              </Tooltip>
            </div>
          )}
          {/* Pie / donut: arc label options */}
          {(chartConfig.chartType === 'pie' || chartConfig.chartType === 'donut') && (
            <PieArcLabelsSection widgetId={widgetId} config={chartConfig} />
          )}
        </Stack>
      )}

      {/* Gantt / timeline chart fields */}
      {chartConfig.chartType === 'gantt' && (
        <GanttFieldsSection
          widgetId={widgetId}
          config={chartConfig}
          // Pass the reachability-filtered catalog (now correctly anchored on
          // the widget's own source for gantt — see `supportSourceId` above), not the raw,
          // unrestricted `allFields` — the label-field picker was the one gantt picker that
          // bypassed the reachable-source filter entirely, offering every field from every
          // source regardless of the widget's already-adopted source.
          //
          // Every gantt field (label / start / end / colour) is a per-row DIMENSION, so this is
          // the dimension-only list.
          allFields={reachableDimensionFields}
          // …but the stale-filter computation needs the FULL catalog: it asks "does this
          // filter's field resolve against the NEW source?", and `reachableFields` is
          // narrowed to the OLD anchor's reachability set, so every field of the source
          // being adopted would look non-existent and its filters would be over-deleted
          // inside the same undoable commit.
          fieldCatalog={allFields}
          dateFields={dateFields}
          categoryFields={categoryFields}
          widgetSourceId={widgetSourceId}
          allFilters={allFilters}
          relationships={relationships}
        />
      )}

      {/* Annotations — reference lines (not for pie/donut/gauge/gantt/sankey/heatmap/funnel).
          Funnel excluded because `StudioFunnelChart` has no reference-line
          rendering support at all (unlike bar/line-area/mixed/scatter, the families the section
          above is actually shared by — see `AnnotationsEditorSection`'s own config-prop comment),
          so a write here was silently stripped by `FUNNEL_CHART_KEYS` omitting `annotations` with
          no renderer to receive it either; hiding the control is correct rather than adding a
          no-op allow-list entry. */}
      {features.chartAnnotations !== false &&
        chartType !== 'pie' &&
        chartType !== 'donut' &&
        chartType !== 'gauge' &&
        chartType !== 'gantt' &&
        chartType !== 'sankey' &&
        chartType !== 'heatmap' &&
        chartType !== 'funnel' && <AnnotationsEditorSection widgetId={widgetId} config={config} />}
      {/* Interactions — cross-filter mode.

          The offered modes come from the chart-type registry's `supportsGhost` flag rather than
          being hardcoded here (HIGH 5). "Highlight" only differs from "Filter" for a family that
          actually renders the dimmed un-cross-filtered baseline; mixed / heatmap / funnel /
          sankey / gantt / gauge aggregate `enrichedRows`, which in `'cross-highlight'` mode
          already IS the cross-filtered row set, so they re-aggregate to the filtered subset and
          rebase their axis/colour scale — behaviour indistinguishable from "Filter", offered
          under a second button claiming otherwise. Those families are offered
          `['cross-filter', 'none']` and default to `'cross-filter'`, which is what the runtime
          default of `'cross-highlight'` already does for them; `CrossFilterModeSection`'s own
          legacy normalization displays a stored `'cross-highlight'` as "Filter" for exactly this
          case (the pattern the KPI panel already uses). No config is rewritten. */}
      <CrossFilterModeSection
        widgetId={widgetId}
        title={localeText.chartSetupInteractionsTitle}
        description={localeText.chartSetupInteractionsDescription}
        modes={crossFilterModes}
        defaultMode={crossFilterDefaultMode}
        value={config.crossFilterMode}
      />
    </Stack>
  );
}
