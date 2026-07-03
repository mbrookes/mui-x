'use client';
import * as React from 'react';
import {
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioWidgetConfig } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';

export interface SankeyConfigSectionProps {
  widgetId: string;
  config: StudioWidgetConfig;
  categoryFields: DataSourceFieldEntry[];
  numericFields: DataSourceFieldEntry[];
  /** First configured Y-series field id, used as the fallback for the value-field picker. */
  firstYSeriesFieldId?: string;
}

/** Sankey chart setup: target node field, value measure, link colour, and show-values toggle. */
export function SankeyConfigSection({
  widgetId,
  config,
  categoryFields,
  numericFields,
  firstYSeriesFieldId,
}: SankeyConfigSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  return (
    <React.Fragment>
      <DataSourceFieldSelect
        value={config.sankeyTargetField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, {
            sankeyTargetField: fieldId || undefined,
          })
        }
        fields={categoryFields}
        label={localeText.chartSetupSankeyTargetLabel}
        helperText={localeText.chartSetupSankeyTargetHelperText}
      />
      <DataSourceFieldSelect
        value={config.yField ?? firstYSeriesFieldId ?? ''}
        onChange={(fieldId) => {
          controller.updateWidgetConfig(widgetId, {
            yField: fieldId,
            ySeries: [{ fieldId }],
          });
        }}
        fields={numericFields}
        label={localeText.chartSetupValueFieldLabel}
        helperText={localeText.chartSetupSankeyValueHelperText}
      />
      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.chartSetupSankeyLinkColorLabel}</InputLabel>
        <Select
          label={localeText.chartSetupSankeyLinkColorLabel}
          value={config.sankeyLinkColor ?? 'source'}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              sankeyLinkColor: evt.target.value as 'source' | 'target',
            })
          }
        >
          <MenuItem value="source">{localeText.chartSetupSankeyLinkColorSource}</MenuItem>
          <MenuItem value="target">{localeText.chartSetupSankeyLinkColorTarget}</MenuItem>
        </Select>
      </FormControl>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={config.sankeyShowValues ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                sankeyShowValues: event.target.checked,
              })
            }
          />
        }
        label={
          <Typography variant="caption">{localeText.chartSetupSankeyShowValuesLabel}</Typography>
        }
        sx={{ ml: 0 }}
      />
    </React.Fragment>
  );
}
