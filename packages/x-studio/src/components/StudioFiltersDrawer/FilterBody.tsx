'use client';
import * as React from 'react';
import {
  Autocomplete,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { FieldType, FilterMode } from '@mui/x-studio-core/engine';
import { needsOperatorValueReset } from '@mui/x-studio-core/engine';
import type { StudioFilterOperator, StudioFilterState } from '../../models';
import type { AvailableSeries } from './RankFilterInput';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterValueInput } from './FilterValueInput';
import { SelectionFilterInput } from './SelectionFilterInput';
import { RankFilterInput } from './RankFilterInput';
import { useStudioLocaleText } from '../../context';
import { SecondCondition } from './SecondCondition';

interface FilterBodyProps {
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
  const dependsOnLabelId = React.useId();
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
              onChange={(event) => {
                const nextOperator = event.target.value as StudioFilterOperator;
                // 1.6 / 1.14 / M8: `between` carries a `{ from, to }` object value; every other
                // operator carries a scalar. `needsOperatorValueReset` resets the value across
                // that boundary in BOTH directions (a stranded object makes `toComparable`
                // yield NaN and renders "[object Object]"; a stranded scalar renders two empty
                // bound inputs over a value the user never cleared) while preserving a
                // `RelativeDateValue`, which is a non-array object but a valid scalar.
                //
                // `activeOperator` — not `filter.operator` — is the "previous" operator, since
                // it is what the row actually rendered when a stored operator was invalid for
                // the field type.
                onChange(
                  needsOperatorValueReset(activeOperator, nextOperator, filter.value)
                    ? { operator: nextOperator, value: '' }
                    : { operator: nextOperator },
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
            operator={activeOperator}
            value={filter.value}
            onChange={(v) => onChange({ value: v })}
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
            // Selection mode is the only mode whose stored `operator` this editor can
            // meaningfully express, and `not_in` is reachable here (host `initialState`,
            // persisted docs, the wire `addFilter` mutation, `controller.addFilter`/
            // `updateFilter`, and `applyFilterPreset`, none of which validate operator against
            // mode). Writing it back explicitly also normalizes the `equals`-left-over case
            // that `buildModeReset` produces on a condition → selection switch, so the stored
            // operator finally agrees with what the card summarizes and the pipeline applies.
            exclude={filter.operator === 'not_in'}
            onExcludeChange={(next) => onChange({ operator: next ? 'not_in' : 'in' })}
          />
          {dependencyOptions && dependencyOptions.length > 0 && onDependencyChange && (
            <div>
              <Typography
                id={dependsOnLabelId}
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
                  // A `placeholder` is only a last-resort accessible-name source (and is
                  // dropped by several screen readers once a chip is selected). This
                  // Autocomplete has no `label` at all, so point the combobox at the caption
                  // above it — the same rule `StudioWidgetEditDialog/FilterRow` documents and
                  // `MultiSelectControl` already follows.
                  //
                  // `params.slotProps` must be spread back in, `htmlInput` included:
                  // Autocomplete delivers ALL of its wiring through it (the `combobox` role,
                  // `aria-expanded`/`aria-controls`/`aria-activedescendant`, the popup
                  // handlers, and the `input`/`inputLabel` slots). Replacing the object
                  // outright silently downgrades the combobox to a plain textbox.
                  <TextField
                    {...params}
                    placeholder={localeText.filterSelectParent}
                    slotProps={{
                      ...params.slotProps,
                      htmlInput: {
                        ...params.slotProps.htmlInput,
                        'aria-labelledby': dependsOnLabelId,
                      },
                    }}
                  />
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
