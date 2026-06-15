'use client';
import * as React from 'react';
import { Autocomplete, FormControl, InputLabel, MenuItem, Select, TextField } from '@mui/material';
import type { StudioFilterOperator } from '../../models';
import type { FieldType } from './filterDrawerTypes';
import { useStudioLocaleText } from '../../context';
import { DateValueInput } from './DateValueInput';

const OPERATORS_WITH_AUTOCOMPLETE = new Set<StudioFilterOperator>(['equals', 'not_equals']);
const OPERATORS_NO_VALUE = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

/** The value input appropriate for a field type and operator. */
export function FilterValueInput(props: {
  fieldType: FieldType | undefined;
  operator: StudioFilterOperator;
  value: unknown;
  onChange: (v: unknown) => void;
  fieldValues?: string[];
}) {
  const { fieldType, operator, value, onChange, fieldValues } = props;
  const localeText = useStudioLocaleText();
  const strVal = String(value ?? '');

  // Local text state for the plain TextField and Autocomplete inputs.
  // The local state updates immediately (fast UI feedback); the store dispatch
  // (onChange prop) is debounced by 150ms so rapid keystrokes don't trigger
  // full pipeline recalculations on every character.
  const [localText, setLocalText] = React.useState(strVal);
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync local text when external value changes programmatically (e.g., filter cleared).
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
    return <DateValueInput value={value} onChange={onChange} />;
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

  return (
    <TextField
      size="small"
      label={localeText.filterValueLabel}
      helperText={localeText.filterValueHelper}
      value={localText}
      onChange={(event) => handleTextChange(event.target.value)}
      sx={{ minWidth: 80, flexGrow: 1 }}
    />
  );
}
