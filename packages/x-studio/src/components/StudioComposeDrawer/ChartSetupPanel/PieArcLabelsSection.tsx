'use client';
import * as React from 'react';
import {
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioWidgetConfig } from '../../../models';

export interface PieArcLabelsSectionProps {
  widgetId: string;
  config: StudioWidgetConfig;
}

/** Pie / donut chart setup: arc label content (none/value/percent) and minimum-angle threshold. */
export function PieArcLabelsSection({ widgetId, config }: PieArcLabelsSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  return (
    <React.Fragment>
      <Divider />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {localeText.chartSetupArcLabelsTitle}
      </Typography>
      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.chartSetupArcLabelLabel}</InputLabel>
        <Select
          label={localeText.chartSetupArcLabelLabel}
          value={config.pieArcLabel ?? 'none'}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              pieArcLabel: evt.target.value as 'value' | 'percent' | 'none',
            })
          }
        >
          <MenuItem value="none">{localeText.chartSetupSortNone}</MenuItem>
          <MenuItem value="value">{localeText.chartSetupSortValue}</MenuItem>
          <MenuItem value="percent">{localeText.chartSetupSortPercent}</MenuItem>
        </Select>
      </FormControl>
      {(config.pieArcLabel ?? 'none') !== 'none' && (
        <TextField
          size="small"
          label={localeText.chartSetupMinAngleLabel}
          type="number"
          value={config.pieArcLabelMinAngle ?? 20}
          helperText={localeText.chartSetupMinAngleHelperText}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              pieArcLabelMinAngle: Math.max(0, Number(evt.target.value)),
            })
          }
          slotProps={{ htmlInput: { min: 0, max: 180 } }}
        />
      )}
    </React.Fragment>
  );
}
