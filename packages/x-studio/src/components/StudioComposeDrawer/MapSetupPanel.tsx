'use client';
import * as React from 'react';
import {
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
  useStudioLocaleText,
} from '../../context';
import { useStudioGeographies } from '../../internals/StudioUIConfigContext';
import type { StudioWidgetConfig, StudioWidgetConfigForKind } from '../../models';
import type { DataSourceFieldEntry } from './DataSourceFieldSelect';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';
import { CrossFilterModeSection } from './CrossFilterModeSection';

interface MapSetupPanelProps {
  widgetId: string;
}

export function MapSetupPanel({ widgetId }: MapSetupPanelProps) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
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
  // in useWidgetRows handles the actual data binding for cross-source fields.
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
      if (ef.hidden) {
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

  function update(changes: Partial<typeof config>) {
    controller.updateWidget(widgetId, { config: { ...config, ...changes } });
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
      // No primary source yet — adopt the country field's source as primary
      controller.updateWidget(widgetId, {
        sourceId,
        config: { ...config, mapCountryField: fieldId, mapCountrySourceId: undefined },
      });
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
        onChange={handleCountryFieldChange}
      />

      <DataSourceFieldSelect
        label={localeText.mapSetupValueFieldLabel}
        helperText={localeText.mapSetupValueFieldHelperText}
        value={config.mapValueField ?? ''}
        valueSourceId={config.mapValueSourceId}
        fields={numericFields}
        onChange={(fieldId, sourceId) =>
          update({
            mapValueField: fieldId || undefined,
            mapValueSourceId: fieldId && sourceId !== widget?.sourceId ? sourceId : undefined,
          })
        }
      />

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
