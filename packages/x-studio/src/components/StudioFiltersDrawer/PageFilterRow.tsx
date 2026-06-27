'use client';
import * as React from 'react';
import { Box, IconButton, Stack } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  selectFilters,
  useStudioLocaleText,
} from '../../context';
import type { StudioFilterState } from '../../models';
import type { FieldOption, FilterMode, SimpleField } from './filterDrawerTypes';
import {
  getOperators,
  summarizeFilter,
  buildModeReset,
  defaultValueForMode,
  isFilterEffective,
  isFilterFresh,
} from './filterDrawerUtils';
import { useFieldValues } from './useFieldValues';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterCard } from './FilterCard';
import { FilterBody } from './FilterBody';
import {
  DataSourceFieldSelect,
  type DataSourceFieldEntry,
} from '../StudioComposeDrawer/DataSourceFieldSelect';

interface PageFilterRowProps {
  filter: StudioFilterState;
  fields: SimpleField[];
  fieldOptions: FieldOption[];
  onRemove: (id: string) => void;
  /** All page filters on the current page — used to compute cascading dependency options. */
  allPageFilters: StudioFilterState[];
}

export function PageFilterRow(props: PageFilterRowProps) {
  const { fields, fieldOptions, filter, onRemove, allPageFilters } = props;
  const localeText = useStudioLocaleText();
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

  // Dependency / cascading support for selection filters — must be computed before useFieldValues
  const parentFilters = React.useMemo(() => {
    if (!filter.dependsOn?.length) {
      return undefined;
    }
    return allPageFilters.filter(
      (f) => f.id !== filter.id && filter.dependsOn!.includes(f.id) && isFilterEffective(f),
    );
  }, [filter.dependsOn, filter.id, allPageFilters]);

  const dependencyOptions = React.useMemo(
    () =>
      allPageFilters.flatMap((f) =>
        f.id !== filter.id && !!f.field
          ? [{ id: f.id, label: fields.find((sf) => sf.id === f.field)?.label ?? f.field }]
          : [],
      ),
    [allPageFilters, filter.id, fields],
  );

  const fieldValues = useFieldValues(filter.field, fieldType, parentFilters);
  const fieldLabel = currentField?.label ?? filter.field;
  const filters = useStudioSelector(selectFilters);
  const hasAnotherRankFilter = filters.some(
    (candidate) =>
      candidate.id !== filter.id &&
      candidate.scope.kind !== 'cross-filter' &&
      candidate.filterMode === 'rank',
  );
  const disableRankMode = hasAnotherRankFilter && filter.filterMode !== 'rank';

  const handleFilterChange = (changes: Partial<StudioFilterState>) => {
    controller.updateFilter(filter.id, changes);
  };

  const handleModeChange = (newMode: FilterMode) => {
    if (newMode === 'rank' && disableRankMode) {
      return;
    }
    handleFilterChange(buildModeReset(newMode));
  };

  // Phase 1: no field selected yet — show mode toggle + field picker
  if (!hasField) {
    const currentMode = filter.filterMode ?? 'condition';
    const pickableOptions =
      currentMode === 'rank' ? fieldOptions.filter((o) => o.fieldType === 'number') : fieldOptions;

    const fieldEntries: DataSourceFieldEntry[] = pickableOptions.map((o) => ({
      id: o.id,
      label: o.label,
      type: o.fieldType,
      sourceId: o.sourceId,
      sourceLabel: o.sourceLabel,
    }));

    return (
      <Stack spacing={1}>
        <FilterModeToggle
          mode={currentMode}
          onChange={handleModeChange}
          disableRank={disableRankMode}
        />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <DataSourceFieldSelect
              value=""
              fields={fieldEntries}
              label={localeText.filterSelectField ?? 'Select a field…'}
              onChange={(fieldId, sourceId) => {
                const opt = pickableOptions.find(
                  (o) => o.id === fieldId && o.sourceId === sourceId,
                );
                if (opt) {
                  handleFilterChange({
                    field: opt.id,
                    fieldType: opt.fieldType,
                    filterSourceId: opt.sourceId,
                    value: defaultValueForMode(currentMode),
                    operator: 'equals',
                  });
                }
              }}
            />
          </Box>
          <IconButton
            size="small"
            onClick={() => onRemove(filter.id)}
            aria-label={localeText.filterRemoveAriaLabel}
          >
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
      initialExpanded={isFilterFresh(filter) || !isFilterEffective(filter)}
    >
      <FilterBody
        filter={filter}
        fieldType={fieldType}
        operators={operators}
        activeOperator={activeOperator}
        activeOperator2={activeOperator2}
        fieldValues={fieldValues}
        onModeChange={handleModeChange}
        onChange={handleFilterChange}
        disableRankMode={disableRankMode}
        dependencyOptions={dependencyOptions.length > 0 ? dependencyOptions : undefined}
        dependsOn={filter.dependsOn}
        onDependencyChange={(ids) =>
          handleFilterChange({ dependsOn: ids.length > 0 ? ids : undefined })
        }
      />
    </FilterCard>
  );
}
