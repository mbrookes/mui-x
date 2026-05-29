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

  const { stringFields, numericFields } = React.useMemo<{
    stringFields: DataSourceFieldEntry[];
    numericFields: DataSourceFieldEntry[];
  }>(() => {
    if (!widget?.sourceId) return { stringFields: [], numericFields: [] };
    const source = dataSources[widget.sourceId];
    if (!source) return { stringFields: [], numericFields: [] };

    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    const strings: DataSourceFieldEntry[] = [];
    const numbers: DataSourceFieldEntry[] = [];

    source.fields.forEach((f) => {
      if (f.hidden) return;
      const entry: DataSourceFieldEntry = { id: f.id, label: f.label, type: f.type, sourceId: source.id, sourceLabel: source.label };
      if (f.type === 'string') strings.push(entry);
      if (f.type === 'number') numbers.push(entry);
    });
    expressionFields
      .forEach((ef) => {
        if (ef.sourceId !== widget.sourceId || ef.hidden) return;
        const entry: DataSourceFieldEntry = { id: ef.id, label: ef.label, type: 'number', sourceId: source.id, sourceLabel: source.label, generated: true };
        numbers.push(entry);
      });

    relationships.forEach((rel) => {
      if (rel.type !== 'many-to-one' || rel.sourceId !== widget.sourceId) return;
      if (!reachableIds.has(rel.targetId)) return;
      const relSource = dataSources[rel.targetId];
      if (!relSource) return;
      relSource.fields.forEach((f) => {
        if (f.hidden) return;
        if (f.type === 'string') strings.push({ id: f.id, label: f.label, type: f.type, sourceId: relSource.id, sourceLabel: relSource.label });
        if (f.type === 'number') numbers.push({ id: f.id, label: f.label, type: f.type, sourceId: relSource.id, sourceLabel: relSource.label });
      });
    });

    return { stringFields: strings, numericFields: numbers };
  }, [widget?.sourceId, dataSources, relationships, expressionFields]);

  function update(changes: Partial<typeof config>) {
    controller.updateWidget(widgetId, { config: { ...config, ...changes } });
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
          fields={stringFields}
          onChange={(fieldId) => update({ mapCountryField: fieldId || undefined })}
        />
      </div>

      <div>
        <Typography variant="subtitle2" gutterBottom>
          Value field
        </Typography>
        <DataSourceFieldSelect
          label="Value field (optional for count)"
          value={config.mapValueField ?? ''}
          fields={numericFields}
          onChange={(fieldId) => update({ mapValueField: fieldId || undefined })}
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
