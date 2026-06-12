'use client';
import * as React from 'react';
import {
  Box,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectShell,
  selectDataSources,
} from '../../context';
import type { StudioNumberFormat } from '../../models';
import { useDataTypeLabels } from './StudioComposeDrawerLabels';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

export function FieldDetailView() {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const dataSources = useStudioSelector(selectDataSources);
  const selectedFieldId = shell.selectedFieldId;
  const dataTypeLabels = useDataTypeLabels();
  const localeText = useStudioLocaleText();
  const source = shell.selectedSourceId ? dataSources[shell.selectedSourceId] : null;
  const field = source?.fields.find((f) => f.id === selectedFieldId) ?? null;

  if (!field || !source) {
    return null;
  }

  const numberFormatOptions: { value: StudioNumberFormat; label: string }[] = [
    { value: 'integer', label: localeText.fieldDetailFormatInteger },
    { value: 'decimal', label: localeText.fieldDetailFormatDecimal },
    { value: 'percent', label: localeText.fieldDetailFormatPercent },
    { value: 'currency', label: localeText.fieldDetailFormatCurrency },
  ];

  const rows: { label: string; value: string }[] = [
    { label: localeText.fieldDetailRowSourceId, value: `${source.id}.${field.id}` },
    { label: localeText.fieldDetailRowName, value: field.label },
    { label: localeText.fieldDetailRowDescription, value: field.description ?? field.label },
    {
      label: localeText.fieldDetailRowDataType,
      value: dataTypeLabels[field.type] ?? field.type.charAt(0).toUpperCase() + field.type.slice(1),
    },
    { label: localeText.fieldDetailRowCalculationType, value: localeText.fieldDetailRowNoCalculation },
    { label: localeText.fieldDetailRowFormat, value: dataTypeLabels[field.type] ?? field.type },
  ];

  return (
    <Stack spacing={0}>
      {rows.map((row, i) => (
        <React.Fragment key={row.label}>
          {i > 0 && <Divider />}
          <Box sx={{ py: 1.25 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {row.label}
            </Typography>
            <Typography variant="body2">{row.value}</Typography>
          </Box>
        </React.Fragment>
      ))}
      {field.type === 'number' && (
        <React.Fragment>
          <Divider />
          <Box sx={{ py: 1.25 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="field-number-format-label">{localeText.fieldDetailNumberFormatLabel}</InputLabel>
              <Select
                labelId="field-number-format-label"
                label={localeText.fieldDetailNumberFormatLabel}
                value={field.format ?? ''}
                onChange={(event) => {
                  const val = event.target.value as StudioNumberFormat | '';
                  controller.updateDataSourceField(source.id, field.id, {
                    format: val === '' ? undefined : val,
                  });
                }}
                displayEmpty
              >
                <MenuItem value="">
                  <em>{localeText.fieldDetailNumberFormatDefault}</em>
                </MenuItem>
                {numberFormatOptions.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </React.Fragment>
      )}
    </Stack>
  );
}
