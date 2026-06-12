'use client';
import * as React from 'react';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

export interface FieldOption {
  id: string;
  label: string;
}

export type OperandType = 'field' | 'const';

export interface OperandState {
  type: OperandType;
  fieldId: string;
  constant: string;
}

export function defaultOperand(fallbackFieldId?: string): OperandState {
  return { type: 'field', fieldId: fallbackFieldId ?? '', constant: '' };
}

export function OperandEditor({
  label,
  value,
  onChange,
  fields,
}: {
  label: string;
  value: OperandState;
  onChange: (v: OperandState) => void;
  fields: FieldOption[];
}) {
  const localeText = useStudioLocaleText();
  return (
    <Stack spacing={0.5}>
      <ToggleButtonGroup
        value={value.type}
        exclusive
        onChange={(_, t: OperandType) => t && onChange({ ...value, type: t })}
        size="small"
        sx={{ alignSelf: 'flex-start' }}
        aria-label={localeText.inlineFormulaBarOperandTypeAriaLabel(label)}
      >
        <ToggleButton
          value="field"
          sx={{ px: 1, py: 0.25, fontSize: '0.7rem', textTransform: 'none' }}
        >
          {localeText.inlineFormulaBarFieldOperandLabel}
        </ToggleButton>
        <ToggleButton
          value="const"
          sx={{ px: 1, py: 0.25, fontSize: '0.7rem', textTransform: 'none' }}
        >
          {localeText.inlineFormulaBarNumberOperandLabel}
        </ToggleButton>
      </ToggleButtonGroup>

      {value.type === 'field' ? (
        <FormControl size="small" fullWidth>
          <InputLabel sx={{ fontSize: '0.8rem' }}>{label}</InputLabel>
          <Select
            label={label}
            value={value.fieldId}
            onChange={(event) => onChange({ ...value, fieldId: event.target.value })}
            sx={{ fontSize: '0.8rem' }}
          >
            {fields.map((f) => (
              <MenuItem key={f.id} value={f.id} sx={{ fontSize: '0.8rem' }}>
                {f.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : (
        <TextField
          size="small"
          label={label}
          type="number"
          value={value.constant}
          onChange={(event) => onChange({ ...value, constant: event.target.value })}
          slotProps={{ htmlInput: { style: { fontSize: '0.8rem' } } }}
          fullWidth
        />
      )}
    </Stack>
  );
}
