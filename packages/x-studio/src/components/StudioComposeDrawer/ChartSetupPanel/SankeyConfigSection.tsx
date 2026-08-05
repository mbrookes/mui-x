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
import type { StudioChartConfig, StudioChartConfigOfType } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';
import { buildSingleMeasurePatch } from './commitMeasureSeries';

export interface SankeyConfigSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'sankey'>;
  categoryFields: DataSourceFieldEntry[];
  numericFields: DataSourceFieldEntry[];
  /** First configured Y-series field id, used as the fallback for the value-field picker. */
  firstYSeriesFieldId?: string;
  /** The widget's current source id — the `yField` mirror's own-source test. */
  widgetSourceId?: string;
  /**
   * The ONE write path for this section's field pickers, supplied by `ChartSetupPanel`.
   * It routes through `commitChartConfigWithSource`, so a target-node or value pick on a
   * source-less sankey adopts that field's source instead of leaving the widget blank.
   */
  commitFieldConfig: (
    configPatch: Partial<StudioChartConfig>,
    /** The picked field's source, or `undefined` when the gesture clears the field. */
    sourceId: string | undefined,
  ) => void;
}

/** Sankey chart setup: target node field, value measure, link colour, and show-values toggle. */
export function SankeyConfigSection({
  widgetId,
  config,
  categoryFields,
  numericFields,
  firstYSeriesFieldId,
  widgetSourceId,
  commitFieldConfig,
}: SankeyConfigSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  // See `ChartSetupPanel`'s own `React.useId` block: MUI's `Select` only exposes an
  // accessible name when it is handed a `labelId` pairing it with its `InputLabel`.
  const linkColorLabelId = React.useId();

  return (
    <React.Fragment>
      <DataSourceFieldSelect
        value={config.sankeyTargetField ?? ''}
        onChange={(fieldId, sourceId) =>
          commitFieldConfig(
            { sankeyTargetField: fieldId || undefined },
            fieldId ? sourceId : undefined,
          )
        }
        fields={categoryFields}
        label={localeText.chartSetupSankeyTargetLabel}
        helperText={localeText.chartSetupSankeyTargetHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.yField ?? firstYSeriesFieldId ?? ''}
        onChange={(fieldId, sourceId) => {
          // Single-measure picker over a multi-series config — see `buildSingleMeasurePatch`
          // for why the remaining series are preserved and why clearing writes `ySeries: []`
          // rather than a placeholder entry.
          commitFieldConfig(
            buildSingleMeasurePatch('sankey', config, fieldId, widgetSourceId),
            fieldId ? sourceId : undefined,
          );
        }}
        fields={numericFields}
        label={localeText.chartSetupValueFieldLabel}
        helperText={localeText.chartSetupSankeyValueHelperText}
        required
      />
      <FormControl size="small" fullWidth>
        <InputLabel id={linkColorLabelId}>{localeText.chartSetupSankeyLinkColorLabel}</InputLabel>
        <Select
          labelId={linkColorLabelId}
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
