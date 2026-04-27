'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import BoltIcon from '@mui/icons-material/Bolt';
import type { StudioFilterOperator, StudioMetricRef } from '../../models';
import type { RelativeDateUnit, RelativeDateValue } from '../filterTypes';
import type { FieldType } from './filterDrawerTypes';
import { isRelativeDateValue, absoluteToRelative, relativeToAbsolute } from './filterDrawerUtils';
import { MetricRefInput } from './MetricRefInput';

const RELATIVE_UNITS: { value: RelativeDateUnit; label: string }[] = [
  { value: 'second', label: 'seconds' },
  { value: 'minute', label: 'minutes' },
  { value: 'hour', label: 'hours' },
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
  { value: 'year', label: 'years' },
];

const OPERATORS_WITH_AUTOCOMPLETE = new Set<StudioFilterOperator>(['equals', 'not_equals']);
const OPERATORS_NO_VALUE = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

function RelativeDateInput({
  value,
  onChange,
}: {
  value: RelativeDateValue;
  onChange: (v: RelativeDateValue) => void;
}) {
  return (
    <Stack spacing={0.75} sx={{ flexGrow: 1, minWidth: 0 }}>
      <TextField
        size="small"
        type="number"
        label="Amount"
        value={value.amount}
        onChange={(event) =>
          onChange({ ...value, amount: Math.max(1, parseInt(event.target.value, 10) || 1) })
        }
        fullWidth
        slotProps={{ htmlInput: { min: 1 } }}
      />
      <FormControl size="small" fullWidth>
        <Select
          value={value.unit}
          onChange={(event) => onChange({ ...value, unit: event.target.value as RelativeDateUnit })}
        >
          {RELATIVE_UNITS.map((u) => (
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
          <MenuItem value="past">ago</MenuItem>
          <MenuItem value="next">from now</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}

/**
 * A single date value input that supports toggling between an absolute date picker
 * and a relative expression (e.g. "5 days ago").
 */
function DateValueInput({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
}) {
  const isRel = isRelativeDateValue(value);
  const mode = isRel ? 'relative' : 'absolute';

  const handleModeChange = (_: React.MouseEvent, newMode: 'absolute' | 'relative' | null) => {
    if (!newMode || newMode === mode) {
      return;
    }
    if (newMode === 'relative') {
      onChange(absoluteToRelative(String(value ?? '')));
    } else {
      onChange(relativeToAbsolute(value as RelativeDateValue));
    }
  };

  const dayjsVal: Dayjs | null =
    !isRel && value && typeof value === 'string' ? dayjs(value as string) : null;

  return (
    <Stack spacing={1} sx={{ flexGrow: 1, minWidth: 0 }}>
      <ToggleButtonGroup
        exclusive
        value={mode}
        onChange={handleModeChange}
        sx={{ alignSelf: 'center' }}
      >
        <Tooltip title="Absolute date">
          <ToggleButton value="absolute" sx={{ px: 1.5, py: 0.5 }}>
            <CalendarTodayIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
        <Tooltip title="Relative date">
          <ToggleButton value="relative" sx={{ px: 1.5, py: 0.5 }}>
            <AccessTimeIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
      </ToggleButtonGroup>

      {isRel ? (
        <RelativeDateInput value={value as RelativeDateValue} onChange={onChange} />
      ) : (
        <DatePicker
          label={label ?? 'Date'}
          value={dayjsVal?.isValid() ? dayjsVal : null}
          onChange={(d) => onChange(d?.isValid() ? d.format('YYYY-MM-DD') : '')}
          slotProps={{ textField: { size: 'small' } }}
          sx={{ flexGrow: 1, minWidth: 130 }}
        />
      )}
    </Stack>
  );
}

/** The value input appropriate for a field type and operator. Supports metric references. */
export function FilterValueInput(props: {
  fieldType: FieldType | undefined;
  operator: StudioFilterOperator;
  value: unknown;
  onChange: (v: unknown) => void;
  valueRef?: StudioMetricRef;
  onValueRefChange?: (ref: StudioMetricRef | undefined) => void;
  fieldValues?: string[];
}) {
  const { fieldType, operator, value, onChange, valueRef, onValueRefChange, fieldValues } = props;
  const strVal = String(value ?? '');
  const useMetric = Boolean(valueRef);

  if (OPERATORS_NO_VALUE.has(operator)) {
    return null;
  }

  const canUseMetric = onValueRefChange !== undefined;

  // Metric mode: show the metric picker instead of the normal value input
  if (useMetric && canUseMetric) {
    return (
      <Stack spacing={1} sx={{ flexGrow: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title="Switch to literal value">
            <ToggleButton
              value="metric"
              selected
              size="small"
              sx={{ px: 1, py: 0.25 }}
              onChange={() => {
                onValueRefChange(undefined);
              }}
            >
              <BoltIcon sx={{ fontSize: 14, mr: 0.5 }} />
              Metric
            </ToggleButton>
          </Tooltip>
        </Box>
        <MetricRefInput value={valueRef} onChange={onValueRefChange} />
      </Stack>
    );
  }

  // Literal mode: normal value input with optional ⚡ toggle button
  const literalInput = (() => {
    if (fieldType === 'date' || fieldType === 'datetime') {
      return <DateValueInput value={value} onChange={onChange} />;
    }

    if (fieldType === 'boolean') {
      return (
        <FormControl size="small" sx={{ minWidth: 90, flexGrow: 1 }}>
          <InputLabel>Value</InputLabel>
          <Select label="Value" value={strVal} onChange={(event) => onChange(event.target.value)}>
            <MenuItem value="true">True</MenuItem>
            <MenuItem value="false">False</MenuItem>
          </Select>
        </FormControl>
      );
    }

    if (
      (fieldType === 'string' || fieldType === undefined) &&
      OPERATORS_WITH_AUTOCOMPLETE.has(operator) &&
      fieldValues &&
      fieldValues.length > 0
    ) {
      return (
        <Autocomplete
          freeSolo
          size="small"
          options={fieldValues}
          value={strVal}
          onInputChange={(_, newVal) => onChange(newVal)}
          renderInput={(params) => <TextField {...params} label="Value" />}
          sx={{ minWidth: 80, flexGrow: 1 }}
        />
      );
    }

    return (
      <TextField
        size="small"
        label="Value"
        value={strVal}
        onChange={(event) => onChange(event.target.value)}
        sx={{ minWidth: 80, flexGrow: 1 }}
      />
    );
  })();

  if (!canUseMetric) {
    return literalInput;
  }

  return (
    <Stack spacing={0.5} sx={{ flexGrow: 1, minWidth: 0 }}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Tooltip title="Use a business metric as the value">
          <ToggleButton
            value="metric"
            selected={false}
            size="small"
            sx={{ px: 1, py: 0.25 }}
            onChange={() => {
              onValueRefChange({ sourceId: '', rowId: '', field: '' });
            }}
          >
            <BoltIcon sx={{ fontSize: 14, mr: 0.5 }} />
            Metric
          </ToggleButton>
        </Tooltip>
      </Box>
      {literalInput}
    </Stack>
  );
}
