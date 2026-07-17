'use client';
import * as React from 'react';
import {
  Alert,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectFilters,
  selectRelationships,
  useStudioLocaleText,
} from '../../context';
import { useStudioGeographies } from '../../internals/StudioUIConfigContext';
import { getReachableSourceIds } from '../../internals/dataSourceGraph';
import { buildFieldCatalog } from '../../internals/fieldCatalog';
import type { StudioWidgetConfig, StudioWidgetConfigForKind } from '../../models';
import type { DataSourceFieldEntry } from './DataSourceFieldSelect';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';
import { CrossFilterModeSection } from './CrossFilterModeSection';
import { collectStaleWidgetFilterIds } from './collectStaleWidgetFilterIds';

interface MapSetupPanelProps {
  widgetId: string;
}

export function MapSetupPanel({ widgetId }: MapSetupPanelProps) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const allFilters = useStudioSelector(selectFilters);
  const relationships = useStudioSelector(selectRelationships);
  const allGeographies = useStudioGeographies();
  const localeText = useStudioLocaleText();
  const widget = widgets[widgetId];
  // `widget` comes from a broad selector, so its `config` is the cross-kind union.
  // Narrow to the map config shape for reading map-specific keys.
  const config = (widget?.config ?? {}) as StudioWidgetConfigForKind<'map'>;

  const aggFn = config.mapAggregation ?? 'sum';
  const colorScheme = config.mapColorScheme ?? 'blues';
  const mapGeography = config.mapGeography ?? 'world';
  const legendZeroMin = config.mapLegendZeroMin ?? false;
  const crossFilterEmit = config.mapCrossFilterEmit ?? false;

  // All string fields from every visible source — country pickers show the full universe
  // so the widget can be configured even before a sourceId is established.
  // Includes string expression fields (e.g. a joined country field).
  const allStringFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    const all: DataSourceFieldEntry[] = [];
    Object.values(dataSources).forEach((ds) => {
      if (ds.hidden) {
        return;
      }
      ds.fields.forEach((f) => {
        if (f.hidden || f.type !== 'string') {
          return;
        }
        all.push({
          id: f.id,
          label: f.label,
          type: f.type as DataSourceFieldEntry['type'],
          sourceId: ds.id,
          sourceLabel: ds.label,
        });
      });
    });
    // Include string expression fields (e.g. expr-order-country via join)
    expressionFields.forEach((ef) => {
      if (ef.hidden || ef.type !== 'string') {
        return;
      }
      const ds = dataSources[ef.sourceId];
      if (ds?.hidden) {
        return;
      }
      all.push({
        id: ef.id,
        label: ef.label,
        type: 'string',
        sourceId: ef.sourceId,
        sourceLabel: ds?.label ?? ef.sourceId,
        generated: true,
      });
    });
    return all;
  }, [dataSources, expressionFields]);

  // Numeric fields: from all visible sources + expression fields.
  // Similar to allStringFields, we show the full universe so the value field
  // can be picked from any source (including related ones). The join enrichment
  // in useWidgetRows handles the actual data binding for cross-source fields, and
  // `StudioMapWidget`'s region aggregation FK-dedups a fanned-out many-to-one value so
  // a cross-source measure is not double-counted per widget row (finding 1.1) — matching
  // how the grid's group-by aggregation (`utils/gridGrouping.ts`'s `symmetricAggregate`)
  // handles the same fan-in topology.
  const numericFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    const all: DataSourceFieldEntry[] = [];

    Object.values(dataSources).forEach((ds) => {
      if (ds.hidden) {
        return;
      }
      ds.fields.forEach((f) => {
        if (f.hidden || f.type !== 'number') {
          return;
        }
        all.push({
          id: f.id,
          label: f.label,
          type: f.type,
          sourceId: ds.id,
          sourceLabel: ds.label,
        });
      });
    });
    expressionFields.forEach((ef) => {
      // Only genuinely numeric expression fields belong in the value-field list — mirroring
      // `allStringFields`'s `ef.type !== 'string'` check. Offering a non-numeric expression
      // field routed into the map renderer's numeric coercion, which skips every row and
      // silently rendered a blank map (finding 2.1).
      if (ef.hidden || ef.type !== 'number') {
        return;
      }
      const ds = dataSources[ef.sourceId];
      if (ds?.hidden) {
        return;
      }
      all.push({
        id: ef.id,
        label: ef.label,
        type: 'number',
        sourceId: ef.sourceId,
        sourceLabel: ds?.label ?? ef.sourceId,
        generated: true,
      });
    });
    return all;
  }, [dataSources, expressionFields]);

  // Full cross-source field catalog, used to detect widget-scoped filters that no longer
  // resolve after the map adopts a source (finding 1.6) — mirrors the sibling setup panels.
  const fieldCatalog = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields),
    [dataSources, expressionFields],
  );

  // Finding 3 (architecture review): both `allStringFields`/`numericFields` previously spanned
  // EVERY visible source with no reachability filter at all — picking a field from a source with
  // no resolvable relationship to the widget's anchor commits fine but can never be enriched
  // onto the widget's rows (`useWidgetRows`' cross-source join needs a declared relationship —
  // see `StudioMapWidget.tsx`'s `valueFkField`/`buildManyToOneRelationshipIndex`), so every
  // region silently aggregates to nothing with no warning anywhere. Mirror
  // `ChartSetupPanel`/`GridSetupPanel`'s pattern: once the widget has an anchor source, disable
  // (not remove — the already-selected value must stay visible/selectable) options from a
  // source that isn't reachable via `getReachableSourceIds`. With no anchor yet, every source is
  // offered (the first pick establishes the anchor), matching the "country pickers show the full
  // universe" design intent documented on `allStringFields` above.
  const reachableSourceIds = React.useMemo(
    () => (widget?.sourceId ? getReachableSourceIds(widget.sourceId, relationships) : null),
    [widget?.sourceId, relationships],
  );
  // Disables a candidate OPTION in the dropdown — exempts the field currently stored for
  // THIS picker (by id AND sourceId, not id alone — finding 6's lesson applies here too) so
  // an already-selected (even if unreachable) value is never itself disabled/hidden.
  const makeGetOptionDisabled = React.useCallback(
    (currentFieldId: string | undefined, currentSourceId: string | undefined) =>
      (option: DataSourceFieldEntry) => {
        if (!reachableSourceIds) {
          return false;
        }
        if (option.id === currentFieldId && option.sourceId === currentSourceId) {
          return false;
        }
        return !reachableSourceIds.has(option.sourceId);
      },
    [reachableSourceIds],
  );
  // Is the CURRENTLY stored field itself unreachable? Drives the support-warning banner
  // below — independent of the option-disabling exemption above (which must always treat
  // the current value as "enabled" so it stays visible/selectable in the dropdown).
  const isCurrentSelectionUnreachable = (
    fieldId: string | undefined,
    sourceId: string | undefined,
  ) => !!fieldId && !!reachableSourceIds && !!sourceId && !reachableSourceIds.has(sourceId);
  const countryFieldUnreachable = isCurrentSelectionUnreachable(
    config.mapCountryField,
    config.mapCountrySourceId ?? widget?.sourceId,
  );
  const valueFieldUnreachable = isCurrentSelectionUnreachable(
    config.mapValueField,
    config.mapValueSourceId ?? widget?.sourceId,
  );

  function update(changes: Partial<typeof config>) {
    // Route config edits through `updateWidgetConfig` (T3.3): it shallow-merges only the changed
    // keys and runs the write-side `validateConfigKeysForKind` guard, instead of `updateWidget`
    // replacing the whole config object wholesale from a render-time `config` snapshot (which
    // bypasses the guard and can clobber a concurrent edit). The source-adoption branch below
    // legitimately stays on `updateWidget` — it folds a `sourceId` change alongside the config.
    controller.updateWidgetConfig(widgetId, changes);
  }

  /**
   * Handle country field selection.
   * - If the widget has no sourceId yet, adopt the selected field's source.
   * - If the selected field is from the widget's existing sourceId, store normally.
   * - If it's from a related source, store as cross-source (mapCountrySourceId).
   */
  function handleCountryFieldChange(fieldId: string, sourceId: string) {
    if (!fieldId) {
      update({ mapCountryField: undefined, mapCountrySourceId: undefined });
      return;
    }
    if (!widget?.sourceId) {
      // No primary source yet — adopt the country field's source as primary. Fold in the
      // removal of any widget-scoped filter that no longer resolves against the adopted
      // source (finding 1.6): a filter added to this source-less map keeps matching by
      // `widgetId`, and once its field is absent from the new source's rows the
      // `filterUtils.ts` branches exclude every row, silently blanking the map. Every other
      // source-adopting setup panel (Chart/KPI/Grid/Filter) folds this into the same commit.
      controller.updateWidget(
        widgetId,
        {
          sourceId,
          config: { ...config, mapCountryField: fieldId, mapCountrySourceId: undefined },
        },
        {
          removeFilterIds: collectStaleWidgetFilterIds(
            allFilters,
            widgetId,
            sourceId,
            fieldCatalog,
            relationships,
          ),
        },
      );
      return;
    }
    if (sourceId === widget.sourceId) {
      update({ mapCountryField: fieldId, mapCountrySourceId: undefined });
    } else {
      update({ mapCountryField: fieldId, mapCountrySourceId: sourceId });
    }
  }

  if (!widget) {
    return null;
  }

  const geoDef = allGeographies[mapGeography];
  const fieldLabel = geoDef?.fieldLabel ?? localeText.mapSetupRegionFieldLabel;
  const fieldHint = geoDef?.fieldHint ?? localeText.mapSetupRegionFieldHelperText;

  return (
    <Stack spacing={2} sx={{ p: 1.5 }}>
      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.mapSetupMapTypeLabel}</InputLabel>
        <Select
          label={localeText.mapSetupMapTypeLabel}
          value={mapGeography}
          onChange={(event) => update({ mapGeography: event.target.value as typeof mapGeography })}
        >
          {Object.entries(allGeographies).map(([key, def]) => (
            <MenuItem key={key} value={key}>
              {def.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <DataSourceFieldSelect
        label={fieldLabel}
        helperText={fieldHint}
        required
        value={config.mapCountryField ?? ''}
        valueSourceId={config.mapCountrySourceId ?? widget?.sourceId}
        fields={allStringFields}
        getOptionDisabled={makeGetOptionDisabled(
          config.mapCountryField,
          config.mapCountrySourceId ?? widget?.sourceId,
        )}
        onChange={handleCountryFieldChange}
      />
      {countryFieldUnreachable && (
        <Alert severity="warning">{localeText.mapSetupUnreachableFieldWarning}</Alert>
      )}

      <DataSourceFieldSelect
        label={localeText.mapSetupValueFieldLabel}
        helperText={localeText.mapSetupValueFieldHelperText}
        value={config.mapValueField ?? ''}
        valueSourceId={config.mapValueSourceId ?? widget?.sourceId}
        fields={numericFields}
        getOptionDisabled={makeGetOptionDisabled(
          config.mapValueField,
          config.mapValueSourceId ?? widget?.sourceId,
        )}
        onChange={(fieldId, sourceId) =>
          update(
            fieldId
              ? {
                  mapValueField: fieldId,
                  mapValueSourceId: sourceId !== widget?.sourceId ? sourceId : undefined,
                }
              : // Clearing the value field falls back to a synthetic per-row count. Reset the
                // aggregation to 'count' (mirroring KpiSetupPanel) so the renderer stops
                // applying a stale avg/min/max to per-row 1s — which showed a constant 1 for
                // every region while the panel's locked label claimed "Count" (finding 2.1).
                {
                  mapValueField: undefined,
                  mapValueSourceId: undefined,
                  mapAggregation: 'count',
                },
          )
        }
      />
      {valueFieldUnreachable && (
        <Alert severity="warning">{localeText.mapSetupUnreachableFieldWarning}</Alert>
      )}

      <FormControl size="small" fullWidth disabled={!config.mapValueField}>
        <InputLabel>{localeText.chartSetupAggregationLabel}</InputLabel>
        <Select
          label={localeText.chartSetupAggregationLabel}
          value={config.mapValueField ? aggFn : 'count'}
          onChange={(event) => update({ mapAggregation: event.target.value as typeof aggFn })}
        >
          <MenuItem value="sum">{localeText.aggFnSum}</MenuItem>
          <MenuItem value="count">{localeText.aggFnCount}</MenuItem>
          <MenuItem value="avg">{localeText.aggFnAverage}</MenuItem>
          <MenuItem value="min">{localeText.aggFnMin}</MenuItem>
          <MenuItem value="max">{localeText.aggFnMax}</MenuItem>
        </Select>
        {!config.mapValueField && (
          <FormHelperText>{localeText.aggregationLockedHelperText}</FormHelperText>
        )}
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.mapSetupColourSchemeLabel}</InputLabel>
        <Select
          label={localeText.mapSetupColourSchemeLabel}
          value={colorScheme}
          onChange={(event) => update({ mapColorScheme: event.target.value as typeof colorScheme })}
        >
          <MenuItem value="blues">{localeText.mapSetupColorBlues}</MenuItem>
          <MenuItem value="reds">{localeText.mapSetupColorReds}</MenuItem>
          <MenuItem value="greens">{localeText.mapSetupColorGreens}</MenuItem>
          <MenuItem value="oranges">{localeText.mapSetupColorOranges}</MenuItem>
          <MenuItem value="purples">{localeText.mapSetupColorPurples}</MenuItem>
        </Select>
      </FormControl>

      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={legendZeroMin}
            onChange={(event) => update({ mapLegendZeroMin: event.target.checked })}
          />
        }
        label={localeText.mapSetupScaleFromZeroLabel}
      />

      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={crossFilterEmit}
            onChange={(event) => update({ mapCrossFilterEmit: event.target.checked })}
          />
        }
        label={localeText.mapSetupClickableLabel}
      />

      <CrossFilterModeSection
        widgetId={widgetId}
        title={localeText.mapSetupInteractionsTitle}
        description={localeText.mapSetupInteractionsDescription}
        modes={['cross-highlight', 'cross-filter', 'none']}
        defaultMode="cross-highlight"
        // `crossFilterMode` is a cross-kind key, read via the flat cross-kind config type.
        value={(config as StudioWidgetConfig).crossFilterMode}
      />
    </Stack>
  );
}
