'use client';
import * as React from 'react';
import { FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
} from '../context';
import { getReachableSourceIds } from '../internals/chartUtils';
import type { DataSourceFieldEntry } from './DataSourceFieldSelect';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';

interface MapSetupPanelProps {
  widgetId: string;
}

export function MapSetupPanel({ widgetId }: MapSetupPanelProps) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const widget = widgets[widgetId];
  const config = widget?.config ?? {};

  const aggFn = config.mapAggregation ?? 'sum';
  const colorScheme = config.mapColorScheme ?? 'blues';

  // All string fields from every visible source — country pickers show the full universe
  // so the widget can be configured even before a sourceId is established.
  const allStringFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    return Object.values(dataSources).flatMap((ds) => {
      if (ds.hidden) return [];
      return ds.fields.flatMap((f) => {
        if (f.hidden || f.type !== 'string') return [];
        return [{ id: f.id, label: f.label, type: f.type as DataSourceFieldEntry['type'], sourceId: ds.id, sourceLabel: ds.label }];
      });
    });
  }, [dataSources]);

  // Numeric fields: from the widget's primary source + reachable related sources + expression fields.
  // Falls back to ALL numeric fields when no sourceId is set.
  const numericFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    const all: DataSourceFieldEntry[] = [];
    const reachableIds = widget?.sourceId
      ? getReachableSourceIds(widget.sourceId, relationships)
      : null;

    Object.values(dataSources).forEach((ds) => {
      if (ds.hidden) return;
      if (reachableIds && !reachableIds.has(ds.id)) return;
      ds.fields.forEach((f) => {
        if (f.hidden || f.type !== 'number') return;
        all.push({ id: f.id, label: f.label, type: f.type, sourceId: ds.id, sourceLabel: ds.label });
      });
    });
    expressionFields.forEach((ef) => {
      if (ef.hidden) return;
      if (reachableIds && !reachableIds.has(ef.sourceId)) return;
      const ds = dataSources[ef.sourceId];
      if (ds?.hidden) return;
      all.push({ id: ef.id, label: ef.label, type: 'number', sourceId: ef.sourceId, sourceLabel: ds?.label ?? ef.sourceId, generated: true });
    });
    return all;
  }, [widget?.sourceId, dataSources, relationships, expressionFields]);

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

  if (!widget) return null;

  return (
    <Stack spacing={2} sx={{ p: 1.5 }}>
      <div>
        <Typography variant="subtitle2" gutterBottom>
          Country field
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          A field containing ISO alpha-2 codes, alpha-3 codes, or full country names.
        </Typography>
        <DataSourceFieldSelect
          label="Country field"
          value={config.mapCountryField ?? ''}
          valueSourceId={config.mapCountrySourceId ?? widget?.sourceId}
          fields={allStringFields}
          onChange={handleCountryFieldChange}
        />
      </div>

      <div>
        <Typography variant="subtitle2" gutterBottom>
          Value field
        </Typography>
        <DataSourceFieldSelect
          label="Value field (optional for count)"
          value={config.mapValueField ?? ''}
          valueSourceId={config.mapValueSourceId}
          fields={numericFields}
          onChange={(fieldId, sourceId) => update({
            mapValueField: fieldId || undefined,
            mapValueSourceId: fieldId && sourceId !== widget?.sourceId ? sourceId : undefined,
          })}
        />
      </div>

      <FormControl size="small" fullWidth>
        <InputLabel>Aggregation</InputLabel>
        <Select
          label="Aggregation"
          value={aggFn}
          onChange={(e) => update({ mapAggregation: e.target.value as typeof aggFn })}
        >
          <MenuItem value="sum">Sum</MenuItem>
          <MenuItem value="count">Count</MenuItem>
          <MenuItem value="avg">Average</MenuItem>
          <MenuItem value="min">Min</MenuItem>
          <MenuItem value="max">Max</MenuItem>
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>Colour scheme</InputLabel>
        <Select
          label="Colour scheme"
          value={colorScheme}
          onChange={(e) => update({ mapColorScheme: e.target.value as typeof colorScheme })}
        >
          <MenuItem value="blues">Blues</MenuItem>
          <MenuItem value="reds">Reds</MenuItem>
          <MenuItem value="greens">Greens</MenuItem>
          <MenuItem value="oranges">Oranges</MenuItem>
          <MenuItem value="purples">Purples</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}
