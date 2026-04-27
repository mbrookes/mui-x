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
  Stack,
  Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import type { StudioFilterOperator, StudioFilterState } from '../../models';
import type { FieldType, FilterMode } from './filterDrawerTypes';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterValueInput } from './FilterValueInput';
import { SelectionFilterInput } from './SelectionFilterInput';
import { RankFilterInput } from './RankFilterInput';

interface SecondConditionProps {
  filter: StudioFilterState;
  operators: { value: StudioFilterOperator; label: string }[];
  activeOperator2: StudioFilterOperator;
  fieldType: FieldType | undefined;
  fieldValues: string[];
  onChange: (changes: Partial<StudioFilterState>) => void;
}

function SecondCondition(props: SecondConditionProps) {
  const { filter, operators, activeOperator2, fieldType, fieldValues, onChange } = props;

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
        Add condition
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
              label="AND"
              sx={{ '& .MuiFormControlLabel-label': { fontSize: 12, fontWeight: 600 } }}
            />
            <FormControlLabel
              value="or"
              control={<Radio size="small" sx={{ p: 0.5 }} />}
              label="OR"
              sx={{ '& .MuiFormControlLabel-label': { fontSize: 12, fontWeight: 600 } }}
            />
          </RadioGroup>
        </Box>
        <Tooltip title="Remove second condition">
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
        <InputLabel>Operator</InputLabel>
        <Select
          label="Operator"
          value={activeOperator2}
          onChange={(event) => onChange({ operator2: event.target.value as StudioFilterOperator })}
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
        valueRef={filter.value2Ref}
        onValueRefChange={(ref) => onChange({ value2Ref: ref })}
        fieldValues={fieldValues}
      />
    </React.Fragment>
  );
}

export interface FilterBodyProps {
  filter: StudioFilterState;
  fieldType: FieldType | undefined;
  operators: { value: StudioFilterOperator; label: string }[];
  activeOperator: StudioFilterOperator;
  activeOperator2: StudioFilterOperator;
  fieldValues: string[];
  onChange: (changes: Partial<StudioFilterState>) => void;
}

export function FilterBody({
  filter,
  fieldType,
  operators,
  activeOperator,
  activeOperator2,
  fieldValues,
  onChange,
}: FilterBodyProps) {
  const mode: FilterMode = filter.filterMode ?? 'condition';

  const handleModeChange = (newMode: FilterMode) => {
    const reset: Partial<StudioFilterState> = {
      filterMode: newMode,
      operator2: undefined,
      value2: undefined,
      value2Ref: undefined,
      conjunction: undefined,
      rankByField: undefined,
      valueRef: undefined,
    };
    if (newMode === 'selection') {
      reset.value = [];
    } else if (newMode === 'rank') {
      reset.value = 10;
      reset.rankDirection = 'top';
    } else {
      reset.value = '';
    }
    onChange(reset);
  };

  return (
    <Stack spacing={1} sx={{ px: 1.5, pb: 1.5 }}>
      <FilterModeToggle mode={mode} onChange={handleModeChange} />

      {mode === 'condition' && (
        <React.Fragment>
          <FormControl size="small">
            <InputLabel>Operator</InputLabel>
            <Select
              label="Operator"
              value={activeOperator}
              onChange={(event) =>
                onChange({ operator: event.target.value as StudioFilterOperator })
              }
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
            operator={activeOperator}
            value={filter.value}
            onChange={(v) => onChange({ value: v })}
            valueRef={filter.valueRef}
            onValueRefChange={(ref) => onChange({ valueRef: ref })}
            fieldValues={fieldValues}
          />
          <SecondCondition
            filter={filter}
            operators={operators}
            activeOperator2={activeOperator2}
            fieldType={fieldType}
            fieldValues={fieldValues}
            onChange={onChange}
          />
        </React.Fragment>
      )}

      {mode === 'selection' && (
        <SelectionFilterInput
          values={fieldValues}
          selected={Array.isArray(filter.value) ? (filter.value as string[]) : []}
          onChange={(v) => onChange({ value: v })}
        />
      )}

      {mode === 'rank' && (
        <RankFilterInput
          direction={filter.rankDirection ?? 'top'}
          n={typeof filter.value === 'number' ? filter.value : undefined}
          onChange={onChange}
        />
      )}
    </Stack>
  );
}
