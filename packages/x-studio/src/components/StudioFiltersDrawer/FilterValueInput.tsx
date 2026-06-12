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
import type { StudioFilterOperator, StudioMetricRef } from '../../models';
import type { FieldType } from './filterDrawerTypes';
import { useStudioSelector, selectDataSources, useStudioLocaleText } from '../../context';
import { MetricPickerButton } from './MetricPickerButton';
import { DateValueInput } from './DateValueInput';

const OPERATORS_WITH_AUTOCOMPLETE = new Set<StudioFilterOperator>(['equals', 'not_equals']);
const OPERATORS_NO_VALUE = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

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
  const localeText = useStudioLocaleText();
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
        <InputLabel>{localeText.filterValueLabel}</InputLabel>
        <Select
          label={localeText.filterValueLabel}
          value={strVal}
          onChange={(event) => onChange(event.target.value)}
        >
          <MenuItem value="true">{localeText.filterBooleanTrue}</MenuItem>
          <MenuItem value="false">{localeText.filterBooleanFalse}</MenuItem>
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
          <TextField
            {...params}
            label={localeText.filterValueLabel}
            helperText={localeText.filterValueHelper}
          />
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
      label={localeText.filterValueLabel}
      helperText={localeText.filterValueHelper}
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
