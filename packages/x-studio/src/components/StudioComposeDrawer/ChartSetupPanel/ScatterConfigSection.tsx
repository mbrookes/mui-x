'use client';
import * as React from 'react';
import { Stack, TextField } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioWidgetConfig } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';

export interface ScatterConfigSectionProps {
  widgetId: string;
  config: StudioWidgetConfig;
  numericFields: DataSourceFieldEntry[];
  categoryFields: DataSourceFieldEntry[];
  /** First configured Y-series field id, used as the fallback for the single Y-field picker. */
  firstYSeriesFieldId?: string;
}

/** Scatter chart setup: single Y field plus optional colour-by and size-by fields. */
export function ScatterConfigSection({
  widgetId,
  config,
  numericFields,
  categoryFields,
  firstYSeriesFieldId,
}: ScatterConfigSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  return (
    <React.Fragment>
      <DataSourceFieldSelect
        value={config.yField ?? firstYSeriesFieldId ?? ''}
        onChange={(fieldId) => {
          controller.updateWidgetConfig(widgetId, {
            yField: fieldId,
            ySeries: [{ fieldId }],
          });
        }}
        fields={numericFields}
        label={localeText.chartSetupYFieldLabel}
        helperText={localeText.chartSetupYFieldHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.scatterColorField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, {
            scatterColorField: fieldId || undefined,
          })
        }
        fields={categoryFields}
        label={localeText.chartSetupColorByLabel}
        helperText={localeText.chartSetupColorByHelperText}
      />
      <DataSourceFieldSelect
        value={config.scatterSizeField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, {
            scatterSizeField: fieldId || undefined,
          })
        }
        fields={numericFields}
        label={localeText.chartSetupSizeByLabel}
        helperText={localeText.chartSetupSizeByHelperText}
      />
      {config.scatterSizeField && (
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            label={localeText.chartSetupMinRadiusLabel}
            type="number"
            value={config.scatterMinRadius ?? 4}
            onChange={(evt) =>
              controller.updateWidgetConfig(widgetId, {
                scatterMinRadius: Number(evt.target.value) || 4,
              })
            }
            slotProps={{ htmlInput: { min: 1, max: 50 } }}
            sx={{ flex: 1, minWidth: 0 }}
          />
          <TextField
            size="small"
            label={localeText.chartSetupMaxRadiusLabel}
            type="number"
            value={config.scatterMaxRadius ?? 40}
            onChange={(evt) =>
              controller.updateWidgetConfig(widgetId, {
                scatterMaxRadius: Number(evt.target.value) || 40,
              })
            }
            slotProps={{ htmlInput: { min: 1, max: 100 } }}
            sx={{ flex: 1, minWidth: 0 }}
          />
        </Stack>
      )}
    </React.Fragment>
  );
}
