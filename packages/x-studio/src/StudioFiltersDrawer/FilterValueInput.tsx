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
import { NumberField } from '../internals/NumberField';
import dayjs from 'dayjs';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import AddLinkIcon from '@mui/icons-material/AddLink';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import type { StudioFilterOperator, StudioMetricRef } from '../models';
import type { RelativeDateUnit, RelativeDateValue } from '../internals/filterTypes';
import type { FieldType } from './filterDrawerTypes';
import { isRelativeDateValue, absoluteToRelative, relativeToAbsolute } from './filterDrawerUtils';
import { useStudioSelector, selectDataSources } from '../context';
import { fieldHasCapability } from '../utils/fieldCapabilities';

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

interface MetricOption {
  label: string;
  sourceId: string;
  rowId: string;
  field: string;
  value: number | string;
}

/** Icon button that links the input to a field from any data source, or removes an existing link. */
function MetricPickerButton({
  onSelect,
  onRemoveLink,
  isLinked,
  fieldType,
}: {
  onSelect: (opt: MetricOption) => void;
  onRemoveLink?: () => void;
  isLinked?: boolean;
  fieldType: 'number' | 'date' | 'datetime';
}) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const dataSources = useStudioSelector(selectDataSources);

  const options = React.useMemo(() => {
    const result: MetricOption[] = [];
    const cap = fieldType === 'date' || fieldType === 'datetime' ? 'temporal' : 'numeric';
    for (const source of Object.values(dataSources)) {
      if (!source.rows) {
        continue;
      }
      const suitableFields = source.fields.filter((f) => !f.hidden && fieldHasCapability(f, cap));
      if (suitableFields.length === 0) {
        continue;
      }
      const suitableFieldMap = new Map(suitableFields.map((f) => [f.id, f]));
      const primaryField =
        (cap === 'numeric' ? suitableFieldMap.get('value') : undefined) ?? suitableFields[0];
      for (const row of source.rows) {
        const nameVal = row.name ?? row.label ?? row.metric ?? row.title;
        if (!nameVal) {
          continue;
        }
        const val = row[primaryField.id];
        if (cap === 'temporal' ? typeof val !== 'string' : typeof val !== 'number') {
          continue;
        }
        const rowId = row.id != null ? String(row.id) : undefined;
        if (!rowId) {
          continue;
        }
        result.push({
          label: String(nameVal),
          sourceId: source.id,
          rowId,
          field: primaryField.id,
          value: val as number | string,
        });
      }
    }
    return result;
  }, [dataSources, fieldType]);

  if (isLinked) {
    return (
      <Tooltip title="Remove field link">
        <IconButton
          size="small"
          aria-label="Remove field link"
          onClick={() => onRemoveLink?.()}
          color="primary"
        >
          <LinkOffIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    );
  }

  if (options.length === 0) {
    return null;
  }

  return (
    <React.Fragment>
      <Tooltip title="Link to field">
        <IconButton
          size="small"
          aria-label="Link to field"
          onClick={(e) => setAnchorEl(e.currentTarget)}
        >
          <AddLinkIcon sx={{ fontSize: 14 }} />
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

function RelativeDateInput({
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
  const isLinked = Boolean(valueRef);
  const amountField = (
    <NumberField
      size="small"
      label="Amount"
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
  fieldType,
  valueRef,
  onValueRefChange,
  onMetricSelect,
  metricLabel,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
  fieldType?: 'date' | 'datetime';
  valueRef?: StudioMetricRef;
  onValueRefChange?: (ref: StudioMetricRef | undefined) => void;
  onMetricSelect?: (value: unknown, ref: StudioMetricRef) => void;
  metricLabel?: string;
}) {
  const isRel = isRelativeDateValue(value);
  const mode = isRel ? 'relative' : 'absolute';

  const handleModeChange = (_: React.MouseEvent, newMode: 'absolute' | 'relative' | null) => {
    if (!newMode || newMode === mode) {
      return;
    }
    if (valueRef && onValueRefChange) {
      onValueRefChange(undefined);
    }
    if (newMode === 'relative') {
      onChange(absoluteToRelative(String(value ?? '')));
    } else {
      onChange(relativeToAbsolute(value as RelativeDateValue));
    }
  };

  const dayjsVal: Dayjs | null = !isRel && value && typeof value === 'string' ? dayjs(value) : null;

  const isLinked = Boolean(valueRef);

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
        <RelativeDateInput
          value={value as RelativeDateValue}
          onChange={onChange}
          valueRef={valueRef}
          onValueRefChange={onValueRefChange}
          onMetricSelect={
            onMetricSelect as ((value: RelativeDateValue, ref: StudioMetricRef) => void) | undefined
          }
          metricLabel={metricLabel}
        />
      ) : onValueRefChange ? (
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <DatePicker
              label={label ?? 'Date'}
              value={dayjsVal?.isValid() ? dayjsVal : null}
              disabled={isLinked}
              onChange={(d) => {
                onChange(d?.isValid() ? d.format('YYYY-MM-DD') : '');
                if (valueRef) {
                  onValueRefChange(undefined);
                }
              }}
              slotProps={{ textField: { size: 'small' } }}
              sx={{ flexGrow: 1, minWidth: 130 }}
            />
            <MetricPickerButton
              fieldType={fieldType ?? 'date'}
              isLinked={isLinked}
              onRemoveLink={() => onValueRefChange(undefined)}
              onSelect={(opt) => {
                const nextValue = String(opt.value);
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
        <DatePicker
          label={label ?? 'Date'}
          value={dayjsVal?.isValid() ? dayjsVal : null}
          onChange={(d) => {
            onChange(d?.isValid() ? d.format('YYYY-MM-DD') : '');
          }}
          slotProps={{ textField: { size: 'small' } }}
          sx={{ flexGrow: 1, minWidth: 130 }}
        />
      )}
    </Stack>
  );
}

/** Resolves the display name for a metric ref from the data sources. */
function useMetricLabel(ref: StudioMetricRef | undefined): string | undefined {
  const dataSources = useStudioSelector(selectDataSources);
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
  onMetricSelect?: (value: unknown, ref: StudioMetricRef) => void;
  fieldValues?: string[];
}) {
  const {
    fieldType,
    operator,
    value,
    onChange,
    valueRef,
    onValueRefChange,
    onMetricSelect,
    fieldValues,
  } = props;
  const strVal = String(value ?? '');
  const canUseMetric = onValueRefChange !== undefined;
  const metricLabel = useMetricLabel(canUseMetric ? valueRef : undefined);

  // Local text state for the plain TextField and Autocomplete inputs.
  // The local state updates immediately (fast UI feedback); the store dispatch
  // (onChange prop) is debounced by 150ms so rapid keystrokes don't trigger
  // full pipeline recalculations on every character.
  const [localText, setLocalText] = React.useState(strVal);
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync local text when external value changes programmatically (e.g., filter cleared).
  // useRef tracks the previous value without triggering extra re-renders; the setLocalText
  // call below causes React to restart the render with the synced value.
  const prevValueRef = React.useRef(value);
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setLocalText(String(value ?? ''));
    clearTimeout(debounceTimer.current);
  }

  const handleTextChange = React.useCallback(
    (newVal: string) => {
      setLocalText(newVal);
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        onChange(newVal);
      }, 150);
    },
    [onChange],
  );

  if (OPERATORS_NO_VALUE.has(operator)) {
    return null;
  }

  if (fieldType === 'date' || fieldType === 'datetime') {
    return (
      <DateValueInput
        value={value}
        onChange={onChange}
        fieldType={fieldType}
        valueRef={valueRef}
        onValueRefChange={onValueRefChange}
        onMetricSelect={onMetricSelect}
        metricLabel={metricLabel}
      />
    );
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
        value={localText}
        onInputChange={(_, newVal) => handleTextChange(newVal)}
        renderInput={(params) => (
          <TextField {...params} label="Value" helperText="Value to compare against" />
        )}
        sx={{ minWidth: 80, flexGrow: 1 }}
      />
    );
  }

  // Plain text/number field — show metric picker button when supported
  const isLinked = Boolean(valueRef);
  const textField = (
    <TextField
      size="small"
      label="Value"
      helperText="Value to compare against"
      value={localText}
      disabled={isLinked}
      onChange={(event) => {
        handleTextChange(event.target.value);
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
          fieldType="number"
          isLinked={isLinked}
          onRemoveLink={() => onValueRefChange(undefined)}
          onSelect={(opt) => {
            const nextRef = { sourceId: opt.sourceId, rowId: opt.rowId, field: opt.field };
            if (onMetricSelect) {
              onMetricSelect(opt.value, nextRef);
              return;
            }
            onChange(opt.value);
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
  );
}
