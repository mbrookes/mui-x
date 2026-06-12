'use client';
import {
  Box,
  Chip,
  FormControl,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { NumberField } from '../../internals/NumberField';
import type { StudioMetricRef } from '../../models';
import type { RelativeDateUnit, RelativeDateValue } from '../../internals/filterTypes';
import { useStudioLocaleText } from '../../context';
import { MetricPickerButton } from './MetricPickerButton';

function getRelativeUnits(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    { value: 'second', label: localeText.filterRelativeUnitSeconds },
    { value: 'minute', label: localeText.filterRelativeUnitMinutes },
    { value: 'hour', label: localeText.filterRelativeUnitHours },
    { value: 'day', label: localeText.filterRelativeUnitDays },
    { value: 'week', label: localeText.filterRelativeUnitWeeks },
    { value: 'month', label: localeText.filterRelativeUnitMonths },
    { value: 'year', label: localeText.filterRelativeUnitYears },
  ] satisfies { value: RelativeDateUnit; label: string }[];
}

function getDatePresets(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    {
      label: localeText.filterDatePreset7Days,
      value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset30Days,
      value: { relative: true, amount: 30, unit: 'day', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset3Months,
      value: { relative: true, amount: 3, unit: 'month', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset12Months,
      value: { relative: true, amount: 12, unit: 'month', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset1Year,
      value: { relative: true, amount: 1, unit: 'year', direction: 'past' },
    },
  ] satisfies { label: string; value: RelativeDateValue }[];
}

export function RelativeDateInput({
  value,
  onChange,
  valueRef,
  onValueRefChange,
  onMetricSelect,
  metricLabel,
}: {
  value: RelativeDateValue;
  onChange: (v: RelativeDateValue) => void;
  valueRef?: StudioMetricRef;
  onValueRefChange?: (ref: StudioMetricRef | undefined) => void;
  onMetricSelect?: (value: RelativeDateValue, ref: StudioMetricRef) => void;
  metricLabel?: string;
}) {
  const localeText = useStudioLocaleText();
  const isLinked = Boolean(valueRef);
  const relativeUnits = getRelativeUnits(localeText);
  const datePresets = getDatePresets(localeText);
  const amountField = (
    <NumberField
      size="small"
      label={localeText.filterValueAmountLabel}
      value={value.amount}
      disabled={isLinked}
      onValueChange={(v) => {
        onChange({ ...value, amount: Math.max(1, v ?? 1) });
        if (valueRef && onValueRefChange) {
          onValueRefChange(undefined);
        }
      }}
      min={1}
      fullWidth
    />
  );

  return (
    <Stack spacing={0.75} sx={{ flexGrow: 1, minWidth: 0 }}>
      {/* Quick preset chips */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {datePresets.map((preset) => {
          const isActive =
            value.amount === preset.value.amount &&
            value.unit === preset.value.unit &&
            value.direction === preset.value.direction;
          return (
            <Chip
              key={preset.label}
              label={preset.label}
              size="small"
              color={isActive ? 'primary' : 'default'}
              variant={isActive ? 'filled' : 'outlined'}
              onClick={() => {
                onChange(preset.value);
                if (valueRef && onValueRefChange) {
                  onValueRefChange(undefined);
                }
              }}
            />
          );
        })}
      </Box>
      {onValueRefChange ? (
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {amountField}
            <MetricPickerButton
              fieldType="number"
              isLinked={isLinked}
              onRemoveLink={() => onValueRefChange(undefined)}
              onSelect={(opt) => {
                const nextValue = {
                  ...value,
                  amount: Math.max(1, Math.trunc(opt.value as number) || 1),
                };
                const nextRef = { sourceId: opt.sourceId, rowId: opt.rowId, field: opt.field };
                if (onMetricSelect) {
                  onMetricSelect(nextValue, nextRef);
                  return;
                }
                onChange(nextValue);
                onValueRefChange(nextRef);
              }}
            />
          </Box>
          {metricLabel && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mt: 0.25, ml: 0.25 }}
            >
              {metricLabel}
            </Typography>
          )}
        </Box>
      ) : (
        amountField
      )}
      <FormControl size="small" fullWidth>
        <Select
          value={value.unit}
          onChange={(event) => onChange({ ...value, unit: event.target.value as RelativeDateUnit })}
        >
          {relativeUnits.map((u) => (
            <MenuItem key={u.value} value={u.value}>
              {u.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <Select
          value={value.direction}
          onChange={(event) =>
            onChange({ ...value, direction: event.target.value as 'past' | 'next' })
          }
        >
          <MenuItem value="past">{localeText.filterRelativeDateAgo}</MenuItem>
          <MenuItem value="next">{localeText.filterRelativeDateFromNow}</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}
