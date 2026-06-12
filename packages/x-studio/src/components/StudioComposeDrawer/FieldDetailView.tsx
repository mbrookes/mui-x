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

const NUMBER_FORMAT_OPTIONS: { value: StudioNumberFormat; label: string }[] = [
  { value: 'integer', label: 'Integer' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'percent', label: 'Percent' },
  { value: 'currency', label: 'Currency' },
];

export function FieldDetailView() {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const dataSources = useStudioSelector(selectDataSources);
  const selectedFieldId = shell.selectedFieldId;
  const dataTypeLabels = useDataTypeLabels();
  const source = shell.selectedSourceId ? dataSources[shell.selectedSourceId] : null;
  const field = source?.fields.find((f) => f.id === selectedFieldId) ?? null;

  if (!field || !source) {
    return null;
  }

  const rows: { label: string; value: string }[] = [
    { label: 'Source ID', value: `${source.id}.${field.id}` },
    { label: 'Name', value: field.label },
    { label: 'Description', value: field.description ?? field.label },
    {
      label: 'Data Type',
      value: dataTypeLabels[field.type] ?? field.type.charAt(0).toUpperCase() + field.type.slice(1),
    },
    { label: 'Calculation Type', value: 'No Calculation' },
    { label: 'Format', value: dataTypeLabels[field.type] ?? field.type },
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
              <InputLabel id="field-number-format-label">Number Format</InputLabel>
              <Select
                labelId="field-number-format-label"
                label="Number Format"
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
                  <em>Default</em>
                </MenuItem>
                {NUMBER_FORMAT_OPTIONS.map((opt) => (
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
