'use client';
import * as React from 'react';
import {
  Autocomplete,
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
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import type { StudioFilterOperator, StudioFilterState } from '../models';
import type { FieldType, FilterMode } from './filterDrawerTypes';
import type { AvailableSeries } from './RankFilterInput';
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
        onMetricSelect={(value, ref) => onChange({ value2: value, value2Ref: ref })}
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
  /** Available series for multi-series charts — enables the "Rank by" selector in rank mode. */
  availableSeries?: AvailableSeries[];
  /**
   * Other page filters that can be declared as parents for cascading.
   * When provided (page filters only), shows a "Depends on" picker in selection mode.
   */
  dependencyOptions?: { id: string; label: string }[];
  /** Current set of dependency filter IDs for this filter. */
  dependsOn?: string[];
  /** Called when the user adds or removes a dependency. */
  onDependencyChange?: (ids: string[]) => void;
  onModeChange: (mode: FilterMode) => void;
  onChange: (changes: Partial<StudioFilterState>) => void;
  disableRankMode?: boolean;
}

/**
 * The value-configuration body of a filter card.
 * Does not include the mode toggle — that lives in the card header (FilterCard).
 */
export function FilterBody({
  filter,
  fieldType,
  operators,
  activeOperator,
  activeOperator2,
  fieldValues,
  availableSeries,
  dependencyOptions,
  dependsOn,
  onDependencyChange,
  onModeChange,
  onChange,
  disableRankMode = false,
}: FilterBodyProps) {
  const mode: FilterMode = filter.filterMode ?? 'condition';
  // react-doctor-disable-next-line react-doctor/server-dedup-props -- value is a filtered subset of options; intentional Autocomplete controlled pattern
  const selectedDependencies = React.useMemo(
    () => (dependencyOptions ?? []).filter((opt) => (dependsOn ?? []).includes(opt.id)),
    [dependencyOptions, dependsOn],
  );

  return (
    <Stack spacing={1} sx={{ px: 1.5, pb: 1.5 }}>
      <FilterModeToggle mode={mode} onChange={onModeChange} compact disableRank={disableRankMode} />
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
            onMetricSelect={(value, ref) => onChange({ value, valueRef: ref })}
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
        <React.Fragment>
          <SelectionFilterInput
            values={fieldValues}
            selected={Array.isArray(filter.value) ? (filter.value as string[]) : []}
            onChange={(v) => onChange({ value: v })}
          />
          {dependencyOptions && dependencyOptions.length > 0 && onDependencyChange && (
            <Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mb: 0.5, display: 'block' }}
              >
                Narrow options based on:
              </Typography>
              <Autocomplete
                multiple
                size="small"
                options={dependencyOptions}
                getOptionLabel={(opt) => opt.label}
                value={selectedDependencies}
                onChange={(_, next) => onDependencyChange(next.map((opt) => opt.id))}
                renderInput={(params) => (
                  <TextField {...params} placeholder="Select parent filter…" />
                )}
                isOptionEqualToValue={(opt, val) => opt.id === val.id}
                disableCloseOnSelect
              />
            </Box>
          )}
        </React.Fragment>
      )}

      {mode === 'rank' && (
        <RankFilterInput
          direction={filter.rankDirection ?? 'top'}
          n={typeof filter.value === 'number' ? filter.value : undefined}
          rankMultiSeriesBy={filter.rankMultiSeriesBy}
          availableSeries={availableSeries}
          onChange={onChange}
        />
      )}
    </Stack>
  );
}
