'use client';
import * as React from 'react';
import {
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioSelector, selectWidgets, selectDataSources, selectExpressionFields, useStudioLocaleText } from '../context';
import type { DataSourceFieldEntry } from './DataSourceFieldSelect';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';

interface PivotSetupPanelProps {
  widgetId: string;
}

export function PivotSetupPanel({ widgetId }: PivotSetupPanelProps) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const localeText = useStudioLocaleText();
  const widget = widgets[widgetId];
  const config = widget?.config ?? {};

  const aggFn = config.pivotAggregation ?? 'sum';
  const showTotals = config.pivotShowTotals ?? true;

  // When the widget has a sourceId: show same-source fields + related-source fields.
  // When there is no sourceId yet: show all fields from all sources so the user can
  // pick any field first — the sourceId is then inferred from that selection.
  const allFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!widget?.sourceId) {
      // No source yet — build a flat list of all non-hidden fields from every source
      const entries: DataSourceFieldEntry[] = [];
      Object.values(dataSources).forEach((ds) => {
        if (ds.hidden) {
          return;
        }
        ds.fields.forEach((f) => {
          if (f.hidden) {
            return;
          }
          entries.push({
            id: f.id,
            label: f.label,
            type: f.type,
            sourceId: ds.id,
            sourceLabel: ds.label,
          });
        });
        expressionFields.forEach((ef) => {
          if (ef.sourceId !== ds.id || ef.hidden) {
            return;
          }
          entries.push({
            id: ef.id,
            label: ef.label,
            type: ef.type as DataSourceFieldEntry['type'],
            sourceId: ds.id,
            sourceLabel: ds.label,
            generated: true,
          });
        });
      });
      return entries;
    }
    const source = dataSources[widget.sourceId];
    if (!source) {
      return [];
    }
    const entries: DataSourceFieldEntry[] = [];

    source.fields.forEach((f) => {
      if (f.hidden) {
        return;
      }
      entries.push({
        id: f.id,
        label: f.label,
        type: f.type,
        sourceId: source.id,
        sourceLabel: source.label,
      });
    });
    // Include same-source expression fields (e.g. joined lookup fields) so
    // the pivot can use them as row/col dimensions. Cross-source fields are
    // intentionally excluded: pivot has no per-field source metadata, so
    // mixing sources would cause silent data mismatches.
    expressionFields.forEach((ef) => {
      if (ef.sourceId !== widget.sourceId || ef.hidden) {
        return;
      }
      entries.push({
        id: ef.id,
        label: ef.label,
        type: ef.type as DataSourceFieldEntry['type'],
        sourceId: source.id,
        sourceLabel: source.label,
        generated: true,
      });
    });

    return entries;
  }, [widget?.sourceId, dataSources, expressionFields]);

  const categoryFields = React.useMemo(
    () => allFields.filter((f) => f.type === 'string' || f.type === 'boolean'),
    [allFields],
  );

  const numericFields = React.useMemo(
    () => allFields.filter((f) => f.type === 'number'),
    [allFields],
  );

  /** Adopt sourceId from the first field selected when no source is set yet. */
  function handleFieldChange(
    fieldKey: 'pivotRowField' | 'pivotColField' | 'pivotValueField',
    fieldId: string,
    sourceId: string,
  ) {
    if (!widget) {
      return;
    }
    if (!fieldId) {
      controller.updateWidgetConfig(widgetId, { [fieldKey]: undefined });
      return;
    }
    if (!widget.sourceId) {
      controller.updateWidget(widgetId, {
        sourceId,
        config: { ...config, [fieldKey]: fieldId },
      });
    } else {
      controller.updateWidgetConfig(widgetId, { [fieldKey]: fieldId });
    }
  }

  if (!widget) {
    return null;
  }

  return (
    <Stack spacing={2}>
      <Typography variant="caption" color="text.secondary">
        {localeText.pivotSetupDescription}
      </Typography>

      <DataSourceFieldSelect
        value={config.pivotRowField ?? ''}
        onChange={(fieldId, sourceId) => handleFieldChange('pivotRowField', fieldId, sourceId)}
        fields={categoryFields}
        label={localeText.pivotSetupRowFieldLabel}
        helperText={localeText.pivotSetupRowFieldHelper}
      />

      <DataSourceFieldSelect
        value={config.pivotColField ?? ''}
        onChange={(fieldId, sourceId) => handleFieldChange('pivotColField', fieldId, sourceId)}
        fields={categoryFields}
        label={localeText.pivotSetupColFieldLabel}
        helperText={localeText.pivotSetupColFieldHelper}
      />

      <Divider />

      <FormControl size="small" fullWidth>
        <InputLabel>Aggregation</InputLabel>
        <Select
          label="Aggregation"
          value={aggFn}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              pivotAggregation: evt.target.value as 'sum' | 'avg' | 'count' | 'min' | 'max',
            })
          }
        >
          <MenuItem value="sum">{localeText.aggFnSum}</MenuItem>
          <MenuItem value="avg">{localeText.aggFnAverage}</MenuItem>
          <MenuItem value="count">Count (rows)</MenuItem>
          <MenuItem value="min">{localeText.aggFnMin}</MenuItem>
          <MenuItem value="max">{localeText.aggFnMax}</MenuItem>
        </Select>
      </FormControl>

      {aggFn !== 'count' && (
        <DataSourceFieldSelect
          value={config.pivotValueField ?? ''}
          onChange={(fieldId, sourceId) => handleFieldChange('pivotValueField', fieldId, sourceId)}
          fields={numericFields}
          label={localeText.pivotSetupValueFieldLabel}
          helperText={localeText.pivotSetupValueFieldHelper}
        />
      )}

      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={showTotals}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, { pivotShowTotals: event.target.checked })
            }
          />
        }
        label={<Typography variant="caption">Show totals row and column</Typography>}
        sx={{ ml: 0 }}
      />
    </Stack>
  );
}
