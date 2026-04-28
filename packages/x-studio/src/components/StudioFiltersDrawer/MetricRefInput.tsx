'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import type { StudioMetricRef } from '../../models';
import { useStudioSelector } from '../../context';

interface MetricRefInputProps {
  value: StudioMetricRef | undefined;
  onChange: (ref: StudioMetricRef | undefined) => void;
}

/**
 * Picker for a metric reference: data source → row → numeric field.
 * Shows a preview of the resolved live value beneath the pickers.
 */
export function MetricRefInput({ value, onChange }: MetricRefInputProps) {
  const dataSources = useStudioSelector((state) => state.dataSources);
  const sourceList = Object.values(dataSources);

  const selectedSource = value?.sourceId ? dataSources[value.sourceId] : undefined;

  // Build row options: id + a display label (name / id, whichever is available)
  const rowOptions = React.useMemo(() => {
    if (!selectedSource?.rows) {
      return [];
    }
    return selectedSource.rows.map((row) => ({
      id: String(row.id ?? ''),
      label: String(
        row.name ?? row.label ?? row.metric ?? row.title ?? row.id ?? '',
      ),
    }));
  }, [selectedSource]);

  // Numeric fields available on the selected source
  const numericFields = React.useMemo(
    () => selectedSource?.fields.filter((f) => f.type === 'number') ?? [],
    [selectedSource],
  );

  // Resolved live value preview
  const resolvedValue = React.useMemo(() => {
    if (!value || !selectedSource?.rows) {
      return undefined;
    }
    const row = selectedSource.rows.find((r) => String(r.id ?? '') === value.rowId);
    return row?.[value.field];
  }, [value, selectedSource]);

  const handleSourceChange = (sourceId: string) => {
    const src = dataSources[sourceId];
    const firstNumericField = src?.fields.find((f) => f.type === 'number')?.id ?? '';
    onChange({ sourceId, rowId: '', field: firstNumericField });
  };

  const handleRowChange = (_: unknown, option: { id: string; label: string } | null) => {
    if (!value) {
      return;
    }
    onChange({ ...value, rowId: option?.id ?? '' });
  };

  const handleFieldChange = (field: string) => {
    if (!value) {
      return;
    }
    onChange({ ...value, field });
  };

  const selectedRowOption =
    rowOptions.find((o) => o.id === value?.rowId) ?? null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <FormControl size="small" fullWidth>
        <InputLabel>Source</InputLabel>
        <Select
          label="Source"
          value={value?.sourceId ?? ''}
          onChange={(event) => handleSourceChange(event.target.value)}
        >
          {sourceList.map((src) => (
            <MenuItem key={src.id} value={src.id}>
              {src.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {selectedSource && (
        <Autocomplete
          size="small"
          options={rowOptions}
          value={selectedRowOption}
          onChange={handleRowChange}
          getOptionLabel={(opt) => (opt.label ? `${opt.id} · ${opt.label}` : opt.id)}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          renderInput={(params) => <TextField {...params} label="Metric row" />}
        />
      )}

      {selectedSource && numericFields.length > 0 && (
        <FormControl size="small" fullWidth>
          <InputLabel>Field</InputLabel>
          <Select
            label="Field"
            value={value?.field ?? ''}
            onChange={(event) => handleFieldChange(event.target.value)}
          >
            {numericFields.map((f) => (
              <MenuItem key={f.id} value={f.id}>
                {f.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {resolvedValue !== undefined && (
        <Typography variant="caption" color="text.secondary">
          Current value:{' '}
          <strong>
            {typeof resolvedValue === 'object'
              ? JSON.stringify(resolvedValue)
              : String(resolvedValue)}
          </strong>
        </Typography>
      )}
    </Box>
  );
}
