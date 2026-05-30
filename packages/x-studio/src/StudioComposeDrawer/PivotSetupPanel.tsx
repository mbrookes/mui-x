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

interface PivotSetupPanelProps {
  widgetId: string;
}

export function PivotSetupPanel({ widgetId }: PivotSetupPanelProps) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const widget = widgets[widgetId];
  const config = widget?.config ?? {};

  const aggFn = config.pivotAggregation ?? 'sum';
  const showTotals = config.pivotShowTotals ?? true;

  const allFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!widget?.sourceId) {
      return [];
    }
    const source = dataSources[widget.sourceId];
    if (!source) {
      return [];
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    const entries: DataSourceFieldEntry[] = [];

    source.fields.forEach((f) => {
      if (f.hidden) return;
      entries.push({
        id: f.id,
        label: f.label,
        type: f.type,
        sourceId: source.id,
        sourceLabel: source.label,
      });
    });
    expressionFields.forEach((ef) => {
      if (ef.sourceId !== widget.sourceId || ef.hidden) return;
      entries.push({
        id: ef.id,
        label: ef.label,
        type: ef.type as DataSourceFieldEntry['type'],
        sourceId: source.id,
        sourceLabel: source.label,
        generated: true,
      });
    });

    relationships.forEach((rel) => {
      if (rel.type !== 'many-to-one' || rel.sourceId !== widget.sourceId) {
        return;
      }
      if (!reachableIds.has(rel.targetId)) {
        return;
      }
      const relSource = dataSources[rel.targetId];
      if (!relSource) {
        return;
      }
      relSource.fields.forEach((f) => {
        if (f.hidden) return;
        entries.push({
          id: f.id,
          label: f.label,
          type: f.type,
          sourceId: rel.targetId,
          sourceLabel: relSource.label,
        });
      });
    });

    return entries;
  }, [widget?.sourceId, dataSources, relationships, expressionFields]);

  const categoryFields = React.useMemo(
    () => allFields.filter((f) => f.type === 'string' || f.type === 'boolean'),
    [allFields],
  );

  const numericFields = React.useMemo(
    () => allFields.filter((f) => f.type === 'number'),
    [allFields],
  );

  if (!widget) {
    return null;
  }

  return (
    <Stack spacing={2}>
      <Typography variant="caption" color="text.secondary">
        Build a cross-tabulation by choosing a row field, column field, and value measure.
      </Typography>

      <DataSourceFieldSelect
        value={config.pivotRowField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, { pivotRowField: fieldId || undefined })
        }
        fields={categoryFields}
        label="Row field"
        helperText="Categorical field shown as row groups on the left"
      />

      <DataSourceFieldSelect
        value={config.pivotColField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, { pivotColField: fieldId || undefined })
        }
        fields={categoryFields}
        label="Column field"
        helperText="Categorical field spread across column headers"
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
          <MenuItem value="sum">Sum</MenuItem>
          <MenuItem value="avg">Average</MenuItem>
          <MenuItem value="count">Count (rows)</MenuItem>
          <MenuItem value="min">Min</MenuItem>
          <MenuItem value="max">Max</MenuItem>
        </Select>
      </FormControl>

      {aggFn !== 'count' && (
        <DataSourceFieldSelect
          value={config.pivotValueField ?? ''}
          onChange={(fieldId) =>
            controller.updateWidgetConfig(widgetId, { pivotValueField: fieldId || undefined })
          }
          fields={numericFields}
          label="Value field"
          helperText="Numeric field aggregated into each cell"
        />
      )}

      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={showTotals}
            onChange={(e) =>
              controller.updateWidgetConfig(widgetId, { pivotShowTotals: e.target.checked })
            }
          />
        }
        label={<Typography variant="caption">Show totals row and column</Typography>}
        sx={{ ml: 0 }}
      />
    </Stack>
  );
}
