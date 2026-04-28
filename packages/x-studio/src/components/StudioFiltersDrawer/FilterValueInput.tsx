'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  FormControl,
  IconButton,
  InputLabel,
  Menu,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
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
import { useStudioSelector } from '../../context';

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

interface MetricOption {
  label: string;
  sourceId: string;
  rowId: string;
  field: string;
  value: number;
}

/** Icon button that opens a dropdown of all numeric metrics from all data sources. */
function MetricPickerButton({ onSelect }: { onSelect: (opt: MetricOption) => void }) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const dataSources = useStudioSelector((state) => state.dataSources);

  const options = React.useMemo(() => {
    const result: MetricOption[] = [];
    for (const source of Object.values(dataSources)) {
      if (!source.rows) {
        continue;
      }
      for (const row of source.rows) {
        const nameVal = row.name ?? row.label ?? row.metric ?? row.title;
        if (!nameVal) {
          continue;
        }
        const numericFields = source.fields.filter((f) => f.type === 'number' && !f.hidden);
        if (numericFields.length === 0) {
          continue;
        }
        const primaryField = numericFields.find((f) => f.id === 'value') ?? numericFields[0];
        const val = row[primaryField.id];
        if (typeof val !== 'number') {
          continue;
        }
        result.push({
          label: String(nameVal),
          sourceId: source.id,
          rowId: String(row.id ?? ''),
          field: primaryField.id,
          value: val,
        });
      }
    }
    return result;
  }, [dataSources]);

  if (options.length === 0) {
    return null;
  }

  return (
    <React.Fragment>
      <Tooltip title="Set from metric">
        <IconButton size="small" onClick={(e) => setAnchorEl(e.currentTarget)}>
          <BoltIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        slotProps={{ paper: { sx: { maxHeight: 300 } } }}
      >
        {options.map((opt) => (
          <MenuItem
            key={`${opt.sourceId}-${opt.rowId}`}
            onClick={() => {
              onSelect(opt);
              setAnchorEl(null);
            }}
          >
            {opt.label}
          </MenuItem>
        ))}
      </Menu>
    </React.Fragment>
  );
}

/** Resolves the display name for a metric ref from the data sources. */
function useMetricLabel(ref: StudioMetricRef | undefined): string | undefined {
  const dataSources = useStudioSelector((state) => state.dataSources);
  return React.useMemo(() => {
    if (!ref?.sourceId || !ref.rowId) {
      return undefined;
    }
    const source = dataSources[ref.sourceId];
    const row = source?.rows?.find((r) => String(r.id ?? '') === ref.rowId);
    if (!row) {
      return undefined;
    }
    const name = row.name ?? row.label ?? row.metric ?? row.title;
    return name ? String(name) : undefined;
  }, [ref, dataSources]);
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
  const canUseMetric = onValueRefChange !== undefined;
  const metricLabel = useMetricLabel(canUseMetric ? valueRef : undefined);

  if (OPERATORS_NO_VALUE.has(operator)) {
    return null;
  }

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

  // Plain text/number field — show metric picker button when supported
  const textField = (
    <TextField
      size="small"
      label="Value"
      value={strVal}
      onChange={(event) => {
        onChange(event.target.value);
        if (valueRef && onValueRefChange) {
          onValueRefChange(undefined);
        }
      }}
      sx={{ minWidth: 80, flexGrow: 1 }}
    />
  );

  if (!canUseMetric) {
    return textField;
  }

  return (
    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {textField}
        <MetricPickerButton
          onSelect={(opt) => {
            onChange(opt.value);
            onValueRefChange({ sourceId: opt.sourceId, rowId: opt.rowId, field: opt.field });
          }}
        />
      </Box>
      {metricLabel && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, ml: 0.25 }}>
          {metricLabel}
        </Typography>
      )}
    </Box>
  );
}
