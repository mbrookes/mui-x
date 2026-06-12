'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { StudioFilterOperator, StudioFilterState } from '../../models';
import type { FieldType, FilterMode } from './filterDrawerTypes';
import type { AvailableSeries } from './RankFilterInput';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterValueInput } from './FilterValueInput';
import { SelectionFilterInput } from './SelectionFilterInput';
import { RankFilterInput } from './RankFilterInput';
import { useStudioLocaleText } from '../../context';
import { SecondCondition } from './SecondCondition';

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
  /**
   * Called when the user adds or removes a dependency.
   * @param {string[]} ids Filter value IDs to convert into a label string.
   */
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
  const localeText = useStudioLocaleText();
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
            <InputLabel>{localeText.filterOperatorLabel}</InputLabel>
            <Select
              label={localeText.filterOperatorLabel}
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
            <div>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mb: 0.5, display: 'block' }}
              >
                {localeText.filterBodyNarrowOptions}
              </Typography>
              <Autocomplete
                multiple
                size="small"
                options={dependencyOptions}
                getOptionLabel={(opt) => opt.label}
                value={selectedDependencies}
                onChange={(_, next) => onDependencyChange(next.map((opt) => opt.id))}
                renderInput={(params) => (
                  <TextField {...params} placeholder={localeText.filterSelectParent} />
                )}
                isOptionEqualToValue={(opt, val) => opt.id === val.id}
                disableCloseOnSelect
              />
            </div>
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
