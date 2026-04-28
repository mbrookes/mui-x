'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  Collapse,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useStudioController } from '../../context';
import type { StudioFilterState } from '../../models';
import type { FieldOption } from './filterDrawerTypes';
import { getOperators, summarizeFilter, defaultValueForMode } from './filterDrawerUtils';
import { useFieldValues } from './useFieldValues';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterBody } from './FilterBody';

import type { AvailableSeries } from './RankFilterInput';

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
  const [expanded, setExpanded] = React.useState(true);

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

  const handleChange = (changes: Partial<StudioFilterState>) => {
    const merged = { ...filter, ...changes };
    // Auto-wire field for chart rank filters so isFilterComplete passes
    if (merged.filterMode === 'rank' && chartXField && !merged.field) {
      merged.field = chartXField;
    }
    controller.removeFilter(filter.id);
    controller.addFilter(merged);
  };

  const currentMode = filter.filterMode ?? 'condition';

  const handleModeChangePhase1 = (newMode: typeof currentMode) => {
    handleChange({
      filterMode: newMode,
      value: defaultValueForMode(newMode),
      rankDirection: newMode === 'rank' ? 'top' : undefined,
      operator2: undefined,
      value2: undefined,
      conjunction: undefined,
    });
  };

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
        <FilterModeToggle mode={currentMode} onChange={handleModeChangePhase1} />
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

  // Phase 2: field selected (or chart rank auto-field) — collapsible filter card
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 0.5,
          py: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 'medium' }}>
            {isChartRank
              ? `Rank${chartYFieldLabel ? ` by ${chartYFieldLabel}` : ''}`
              : fieldLabel}
          </Typography>
          {!expanded && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {summarizeFilter(filter)}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(filter.id);
          }}
          aria-label="Remove filter"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <FilterBody
          filter={filter}
          fieldType={fieldType}
          operators={operators}
          activeOperator={activeOperator}
          activeOperator2={activeOperator2}
          fieldValues={fieldValues}
          availableSeries={availableSeries}
          onChange={handleChange}
        />
      </Collapse>
    </Box>
  );
}
