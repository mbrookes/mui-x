'use client';
import * as React from 'react';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioWidgetConfig } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';

export interface FunnelConfigSectionProps {
  widgetId: string;
  config: StudioWidgetConfig;
  numericFields: DataSourceFieldEntry[];
  /** First configured Y-series field id, used as the fallback for the single value-field picker. */
  firstYSeriesFieldId?: string;
}

/** Funnel chart setup: value field plus label format/placement, shape, style, and gap. */
export function FunnelConfigSection({
  widgetId,
  config,
  numericFields,
  firstYSeriesFieldId,
}: FunnelConfigSectionProps) {
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
        label={localeText.chartSetupValueFieldLabel}
        helperText={localeText.chartSetupFunnelValueHelperText}
        required
      />
      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.chartSetupFunnelLabelFormatLabel}</InputLabel>
        <Select
          label={localeText.chartSetupFunnelLabelFormatLabel}
          value={config.funnelLabelFormat ?? 'value'}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              funnelLabelFormat: evt.target.value as 'value' | 'percent' | 'conversion',
              ...(evt.target.value === 'conversion' && !config.funnelLabelPlacement
                ? { funnelLabelPlacement: 'outside-end' as const }
                : {}),
            })
          }
        >
          <MenuItem value="value">{localeText.chartSetupFunnelLabelFormatValue}</MenuItem>
          <MenuItem value="percent">{localeText.chartSetupFunnelLabelFormatPercent}</MenuItem>
          <MenuItem value="conversion">{localeText.chartSetupFunnelLabelFormatConversion}</MenuItem>
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.chartSetupFunnelLabelPlacementLabel}</InputLabel>
        <Select
          label={localeText.chartSetupFunnelLabelPlacementLabel}
          value={
            config.funnelLabelPlacement ??
            (config.funnelLabelFormat === 'conversion' ? 'outside-end' : 'inside')
          }
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              funnelLabelPlacement: evt.target.value as 'inside' | 'outside-start' | 'outside-end',
            })
          }
        >
          <MenuItem value="inside">{localeText.chartSetupFunnelLabelPlacementInside}</MenuItem>
          <MenuItem value="outside-start">
            {localeText.chartSetupFunnelLabelPlacementOutsideStart}
          </MenuItem>
          <MenuItem value="outside-end">
            {localeText.chartSetupFunnelLabelPlacementOutsideEnd}
          </MenuItem>
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.chartSetupFunnelShapeLabel}</InputLabel>
        <Select
          label={localeText.chartSetupFunnelShapeLabel}
          value={config.funnelCurve ?? 'linear'}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              funnelCurve: evt.target.value as 'linear' | 'bump' | 'step' | 'pyramid',
            })
          }
        >
          <MenuItem value="linear">{localeText.chartSetupFunnelShapeLinear}</MenuItem>
          <MenuItem value="bump">{localeText.chartSetupFunnelShapeBump}</MenuItem>
          <MenuItem value="step">{localeText.chartSetupFunnelShapeStep}</MenuItem>
          <MenuItem value="pyramid">{localeText.chartSetupFunnelShapePyramid}</MenuItem>
        </Select>
      </FormControl>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" sx={{ flex: 1 }}>
          {localeText.chartSetupFunnelStyleLabel}
        </Typography>
        <ToggleButtonGroup
          value={config.funnelVariant ?? 'filled'}
          exclusive
          onChange={(_e, val) => {
            if (val) {
              controller.updateWidgetConfig(widgetId, {
                funnelVariant: val as 'filled' | 'outlined',
              });
            }
          }}
          size="small"
        >
          <ToggleButton value="filled" sx={{ textTransform: 'none' }}>
            {localeText.chartSetupFunnelStyleFilled}
          </ToggleButton>
          <ToggleButton value="outlined" sx={{ textTransform: 'none' }}>
            {localeText.chartSetupFunnelStyleOutlined}
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <TextField
        size="small"
        type="number"
        label={localeText.chartSetupFunnelGapLabel}
        value={config.funnelGap ?? 0}
        onChange={(evt) => {
          const v = Math.max(0, Math.min(32, Number(evt.target.value)));
          controller.updateWidgetConfig(widgetId, { funnelGap: v || undefined });
        }}
        slotProps={{ htmlInput: { min: 0, max: 32, step: 1 } }}
        fullWidth
      />
    </React.Fragment>
  );
}
