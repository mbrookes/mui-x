'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  FormControl,
  IconButton,
  InputLabel,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  TextField,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useStudioController } from '../../context';
import type { StudioFilterState } from '../../models';
import type { FieldOption, FilterMode, SimpleField } from './filterDrawerTypes';
import { getOperators, summarizeFilter, buildModeReset, defaultValueForMode } from './filterDrawerUtils';
import { useFieldValues } from './useFieldValues';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterCard } from './FilterCard';
import { FilterBody } from './FilterBody';
import { useStudioSelector } from '../../context';

export interface PageFilterRowProps {
  filter: StudioFilterState;
  fields: SimpleField[];
  fieldOptions: FieldOption[];
  onRemove: (id: string) => void;
}

export function PageFilterRow(props: PageFilterRowProps) {
  const { fields, fieldOptions, filter, onRemove } = props;
  const controller = useStudioController();

  const hasField = !!filter.field;
  const currentField = fields.find((f) => f.id === filter.field);
  const fieldType = filter.fieldType ?? currentField?.fieldType;
  const operators = getOperators(fieldType);
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;
  const activeOperator2 =
    filter.operator2 && operators.find((o) => o.value === filter.operator2)
      ? filter.operator2
      : operators[0].value;
  const fieldValues = useFieldValues(filter.field, fieldType);
  const fieldLabel = currentField?.label ?? filter.field;
  const hasAnotherRankFilter = useStudioSelector((state) =>
    state.filters.some(
      (candidate) =>
        candidate.id !== filter.id &&
        candidate.scope !== 'cross-filter' &&
        candidate.filterMode === 'rank',
    ),
  );
  const disableRankMode = hasAnotherRankFilter && filter.filterMode !== 'rank';

  const handleChange = (changes: Partial<StudioFilterState>) => {
    controller.updateFilter(filter.id, changes);
  };

  const handleModeChange = (newMode: FilterMode) => {
    if (newMode === 'rank' && disableRankMode) {
      return;
    }
    handleChange(buildModeReset(newMode));
  };

  // Phase 1: no field selected yet — show mode toggle + field picker
  if (!hasField) {
    const currentMode = filter.filterMode ?? 'condition';
    const pickableOptions =
      currentMode === 'rank' ? fieldOptions.filter((o) => o.fieldType === 'number') : fieldOptions;
    const groups = pickableOptions.reduce<Record<string, FieldOption[]>>((acc, opt) => {
      (acc[opt.sourceLabel] ??= []).push(opt);
      return acc;
    }, {});

    return (
      <Stack spacing={1}>
        <FilterModeToggle mode={currentMode} onChange={handleModeChange} disableRank={disableRankMode} />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <FormControl size="small" sx={{ flexGrow: 1 }}>
            <InputLabel>Select a field…</InputLabel>
            <Select
              label="Select a field…"
              value=""
              onChange={(event) => {
                const opt = pickableOptions.find(
                  (o) => `${o.sourceId}:${o.id}` === event.target.value,
                );
                if (opt) {
                  handleChange({
                    field: opt.id,
                    fieldType: opt.fieldType,
                    value: defaultValueForMode(currentMode),
                    operator: 'equals',
                  });
                }
              }}
            >
              {Object.entries(groups).map(([sourceLabel, opts]) => [
                <ListSubheader key={`hdr-${sourceLabel}`}>{sourceLabel}</ListSubheader>,
                ...opts.map((o) => (
                  <MenuItem key={`${o.sourceId}:${o.id}`} value={`${o.sourceId}:${o.id}`}>
                    {o.label}
                  </MenuItem>
                )),
              ])}
            </Select>
          </FormControl>
          <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Stack>
    );
  }

  // Phase 2: field selected — collapsible filter card with mode toggle in header
  return (
    <FilterCard
      title={fieldLabel}
      summary={summarizeFilter(filter)}
      onRemove={() => onRemove(filter.id)}
    >
      <FilterBody
        filter={filter}
        fieldType={fieldType}
        operators={operators}
        activeOperator={activeOperator}
        activeOperator2={activeOperator2}
        fieldValues={fieldValues}
        onModeChange={handleModeChange}
        onChange={handleChange}
        disableRankMode={disableRankMode}
      />
    </FilterCard>
  );
}

