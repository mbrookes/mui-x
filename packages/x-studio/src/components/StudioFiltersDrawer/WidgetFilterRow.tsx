'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  IconButton,
  Stack,
  TextField,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useStudioController } from '../../context';
import type { StudioFilterState } from '../../models';
import type { FieldOption, FilterMode } from './filterDrawerTypes';
import { getOperators, summarizeFilter, buildModeReset, defaultValueForMode } from './filterDrawerUtils';
import { useFieldValues } from './useFieldValues';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterCard } from './FilterCard';
import { FilterBody } from './FilterBody';
import type { AvailableSeries } from './RankFilterInput';
import { useStudioSelector } from '../../context';

export interface WidgetFilterRowProps {
  filter: StudioFilterState;
  widgetSourceId?: string;
  fieldOptions: FieldOption[];
  onRemove: (id: string) => void;
  /** xField of the chart widget — when provided, rank filters auto-use this field and skip the picker */
  chartXField?: string;
  /** Label for the y-measure shown in the rank card header */
  chartYFieldLabel?: string;
  /** Available series for multi-series charts — enables "Rank by" selector in rank mode. */
  availableSeries?: AvailableSeries[];
}

export function WidgetFilterRow(props: WidgetFilterRowProps) {
  const {
    filter,
    widgetSourceId,
    fieldOptions,
    onRemove,
    chartXField,
    chartYFieldLabel,
    availableSeries,
  } = props;
  const controller = useStudioController();

  const isChartRank = filter.filterMode === 'rank' && !!chartXField;
  // For chart rank filters, the field is always the chart's xField — treat as always "has field"
  const hasField = !!filter.field || isChartRank;

  const effectiveSourceId = filter.filterSourceId ?? widgetSourceId ?? '';
  const selectedOption =
    fieldOptions.find((o) => o.id === filter.field && o.sourceId === effectiveSourceId) ?? null;
  const fieldType = filter.fieldType ?? selectedOption?.fieldType;
  const operators = getOperators(fieldType);
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;
  const activeOperator2 =
    filter.operator2 && operators.find((o) => o.value === filter.operator2)
      ? filter.operator2
      : operators[0].value;
  const fieldValues = useFieldValues(filter.field, fieldType);
  const fieldLabel = selectedOption?.label ?? filter.field;
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
    const merged = { ...filter, ...changes };
    // Auto-wire field for chart rank filters so isFilterComplete passes
    if (merged.filterMode === 'rank' && chartXField && !merged.field) {
      merged.field = chartXField;
    }
    controller.updateFilter(filter.id, merged);
  };

  const handleModeChange = (newMode: FilterMode) => {
    if (newMode === 'rank' && disableRankMode) {
      return;
    }
    handleChange(buildModeReset(newMode));
  };

  const currentMode = filter.filterMode ?? 'condition';

  // Phase 1: no field selected yet — show mode toggle then autocomplete picker
  if (!hasField) {
    const pickableOptions =
      currentMode === 'rank' ? fieldOptions.filter((o) => o.fieldType === 'number') : fieldOptions;

    const handleFieldSelectPhase1 = (_e: React.SyntheticEvent, option: FieldOption | null) => {
      if (!option) {
        return;
      }
      const isNowCrossSource = option.sourceId !== widgetSourceId;
      handleChange({
        field: option.id,
        fieldType: option.fieldType,
        filterSourceId: isNowCrossSource ? option.sourceId : undefined,
        value: defaultValueForMode(currentMode),
        operator: 'equals',
      });
    };

    return (
      <Stack spacing={1}>
        <FilterModeToggle mode={currentMode} onChange={handleModeChange} disableRank={disableRankMode} />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Autocomplete
            size="small"
            sx={{ flexGrow: 1 }}
            options={pickableOptions}
            groupBy={(option) => option.sourceLabel}
            getOptionLabel={(option) => option.label}
            value={null}
            onChange={handleFieldSelectPhase1}
            isOptionEqualToValue={(option, value) =>
              option.id === value.id && option.sourceId === value.sourceId
            }
            renderInput={(params) => <TextField {...params} label="Select a field…" />}
          />
          <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Stack>
    );
  }

  // Phase 2: field selected (or chart rank auto-field) — collapsible filter card with mode in header
  const cardTitle = isChartRank
    ? `Rank${chartYFieldLabel ? ` by ${chartYFieldLabel}` : ''}`
    : fieldLabel;

  return (
    <FilterCard
      title={cardTitle}
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
        availableSeries={availableSeries}
        onModeChange={handleModeChange}
        onChange={handleChange}
        disableRankMode={disableRankMode}
      />
    </FilterCard>
  );
}

