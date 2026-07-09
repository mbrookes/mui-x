'use client';
import * as React from 'react';
import {
  Box,
  Button,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import type { StudioFilterOperator, StudioFilterState } from '../../models';
import type { FieldType } from './filterDrawerTypes';
import { FilterValueInput } from './FilterValueInput';
import { useStudioLocaleText } from '../../context';
import { isRelativeDateValue } from './filterDrawerUtils';

interface SecondConditionProps {
  filter: StudioFilterState;
  operators: { value: StudioFilterOperator; label: string }[];
  activeOperator2: StudioFilterOperator;
  fieldType: FieldType | undefined;
  fieldValues: string[];
  onChange: (changes: Partial<StudioFilterState>) => void;
}

export function SecondCondition(props: SecondConditionProps) {
  const { filter, operators, activeOperator2, fieldType, fieldValues, onChange } = props;
  const localeText = useStudioLocaleText();

  if (!filter.operator2) {
    return (
      <Button
        size="small"
        startIcon={<AddIcon sx={{ fontSize: 14 }} />}
        onClick={() => onChange({ operator2: operators[0].value, value2: '', conjunction: 'and' })}
        sx={{
          alignSelf: 'flex-start',
          textTransform: 'none',
          fontSize: 12,
          color: 'text.secondary',
          p: 0,
        }}
      >
        {localeText.filterBodyAddCondition}
      </Button>
    );
  }

  return (
    <React.Fragment>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{ flexGrow: 1, display: 'flex', justifyContent: 'center' }}>
          <RadioGroup
            row
            value={filter.conjunction ?? 'and'}
            onChange={(event) => onChange({ conjunction: event.target.value as 'and' | 'or' })}
            sx={{ gap: 0.5 }}
          >
            <FormControlLabel
              value="and"
              control={<Radio size="small" sx={{ p: 0.5 }} />}
              label={localeText.filterConditionAnd}
              sx={{ '& .MuiFormControlLabel-label': { fontSize: 12, fontWeight: 600 } }}
            />
            <FormControlLabel
              value="or"
              control={<Radio size="small" sx={{ p: 0.5 }} />}
              label={localeText.filterConditionOr}
              sx={{ '& .MuiFormControlLabel-label': { fontSize: 12, fontWeight: 600 } }}
            />
          </RadioGroup>
        </Box>
        <Tooltip title={localeText.filterRemoveSecondCondition}>
          <IconButton
            size="small"
            onClick={() =>
              onChange({ operator2: undefined, value2: undefined, conjunction: undefined })
            }
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <FormControl size="small">
        <InputLabel>{localeText.filterOperatorLabel}</InputLabel>
        <Select
          label={localeText.filterOperatorLabel}
          value={activeOperator2}
          onChange={(event) => {
            const nextOperator2 = event.target.value as StudioFilterOperator;
            // 1.15: mirror the primary condition's shape-reset for `value2`. Switching
            // `operator2` away from `between` while leaving the `{ from, to }` object in
            // `value2` makes `toComparable` yield NaN (silently matching nothing) and the
            // value input render "[object Object]". A `RelativeDateValue` is a non-array
            // object too but a valid scalar — exclude it, exactly like FilterBody's primary
            // operator handler.
            const value2IsBetweenShape =
              filter.value2 !== null &&
              filter.value2 !== undefined &&
              typeof filter.value2 === 'object' &&
              !Array.isArray(filter.value2) &&
              !isRelativeDateValue(filter.value2);
            onChange(
              nextOperator2 !== 'between' && value2IsBetweenShape
                ? { operator2: nextOperator2, value2: '' }
                : { operator2: nextOperator2 },
            );
          }}
        >
          {operators.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {op.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FilterValueInput
        fieldType={fieldType}
        operator={activeOperator2}
        value={filter.value2}
        onChange={(v) => onChange({ value2: v })}
        fieldValues={fieldValues}
      />
    </React.Fragment>
  );
}
