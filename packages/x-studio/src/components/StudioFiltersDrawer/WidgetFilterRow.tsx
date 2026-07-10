'use client';
import * as React from 'react';
import { Autocomplete, Box, IconButton, Stack, TextField } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  selectFilters,
  selectPages,
  useStudioLocaleText,
} from '../../context';
import type { StudioFilterState } from '../../models';
import { hasConflictingRankFilter } from '../../internals/rankFilterScope';
import type { FieldOption, FilterMode } from './filterDrawerTypes';
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
import type { AvailableSeries } from './RankFilterInput';

interface WidgetFilterRowProps {
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
  const localeText = useStudioLocaleText();

  const isChartRank = filter.filterMode === 'rank' && !!chartXField;
  // For chart rank filters, the field is always the chart's xField — treat as always "has field"
  const hasField = !!filter.field || isChartRank;

  const effectiveSourceId = filter.filterSourceId ?? widgetSourceId ?? '';
  const selectedOption =
    fieldOptions.find((o) => o.id === filter.field && o.sourceId === effectiveSourceId) ?? null;
  const fieldType = filter.fieldType ?? selectedOption?.fieldType;
  // Memoized: this feeds the operator-repair effect's dependency array below, and
  // `getOperators` returning a fresh array every render would make that effect refire
  // on every unrelated re-render (e.g. from this component's other store subscriptions),
  // not just when `fieldType`/`localeText` actually change.
  const operators = React.useMemo(
    () => getOperators(fieldType, localeText),
    [fieldType, localeText],
  );
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;
  const activeOperator2 =
    filter.operator2 && operators.find((o) => o.value === filter.operator2)
      ? filter.operator2
      : operators[0].value;
  const fieldValues = useFieldValues(
    filter.field,
    fieldType,
    filter.filterSourceId ?? widgetSourceId,
  );
  const fieldLabel = selectedOption?.label ?? filter.field;
  const filters = useStudioSelector(selectFilters);
  const pages = useStudioSelector(selectPages);
  // Per-page rank-uniqueness: mirror EXACTLY what `StudioController.updateFilter` allows
  // (a rank filter on another page is permitted), instead of the old dashboard-wide scan
  // that disabled rank mode more aggressively than the controller actually rejects it.
  const disableRankMode =
    filter.filterMode !== 'rank' && hasConflictingRankFilter(filter.id, filter, filters, pages);

  const handleFilterChange = (changes: Partial<StudioFilterState>) => {
    // 1.4: commit ONLY the delta. `controller.updateFilter` already merges the patch into
    // the CURRENT store filter, so passing the whole render-time `filter` snapshot let a
    // debounced value commit (FilterValueInput captures a stale `filter` closure) overwrite
    // a concurrent operator/conjunction edit that landed in between. `PageFilterRow` already
    // passes the delta; the only extra the widget row needs is the rank field auto-wire.
    const nextMode = changes.filterMode ?? filter.filterMode;
    const nextField = 'field' in changes ? changes.field : filter.field;
    const delta: Partial<StudioFilterState> =
      nextMode === 'rank' && chartXField && !nextField
        ? { ...changes, field: chartXField }
        : changes;
    controller.updateFilter(filter.id, delta);
  };

  // 2.12: `activeOperator` above is a DISPLAY-ONLY fallback — when the stored operator is
  // invalid for the current field type (e.g. a legacy/AI/host-authored filter, or a field
  // switched under it), the row renders `operators[0]` while the engine keeps applying the
  // stale stored operator. Repair the doc to match what the UI shows. Non-undoable, matching
  // `KpiSetupPanel`'s `kpiAggregation` self-repair (finding 2.4): the write fires from
  // rendering, not a user gesture, and self-terminates once the operator is valid.
  // 1.15: the SECOND condition's `operator2` (`activeOperator2` above) needs the same
  // display-fallback + self-repair as the primary `operator`, otherwise a stored invalid
  // `operator2` renders `operators[0]` while the engine keeps applying the stale one.
  const currentModeForRepair = filter.filterMode ?? 'condition';
  React.useEffect(() => {
    if (currentModeForRepair !== 'condition') {
      return;
    }
    // 2.17: only repair against a RESOLVED field type. During a data-loading race the source
    // may not be injected yet, so `fieldType` is `undefined`, `getOperators(undefined)` falls
    // back to STRING_OPERATORS, and a valid stored date/number operator (`between`/
    // `greater_than`) would look "invalid" and be permanently rewritten to `equals` — a
    // non-undoable doc change caused merely by rendering during the race. Skip until the type
    // actually resolves (either `filter.fieldType` present or the field-catalog lookup succeeded).
    if (fieldType === undefined) {
      return;
    }
    const repair: Partial<StudioFilterState> = {};
    if (filter.operator && !operators.some((o) => o.value === filter.operator)) {
      repair.operator = operators[0].value;
    }
    if (filter.operator2 && !operators.some((o) => o.value === filter.operator2)) {
      repair.operator2 = operators[0].value;
    }
    if (repair.operator !== undefined || repair.operator2 !== undefined) {
      controller.updateFilter(filter.id, repair, { undoable: false });
    }
  }, [
    currentModeForRepair,
    fieldType,
    filter.operator,
    filter.operator2,
    filter.id,
    operators,
    controller,
  ]);

  const handleModeChange = (newMode: FilterMode) => {
    if (newMode === 'rank' && disableRankMode) {
      return;
    }
    handleFilterChange(buildModeReset(newMode, fieldType));
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
      handleFilterChange({
        field: option.id,
        fieldType: option.fieldType,
        filterSourceId: isNowCrossSource ? option.sourceId : undefined,
        value: defaultValueForMode(currentMode),
        operator: 'equals',
      });
    };

    return (
      <Stack spacing={1}>
        <FilterModeToggle
          mode={currentMode}
          onChange={handleModeChange}
          disableRank={disableRankMode}
        />
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
            renderInput={(params) => (
              <TextField
                {...params}
                label={localeText.filterSelectField}
                helperText={localeText.widgetFilterFieldHelperText}
              />
            )}
          />
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

  // Phase 2: field selected (or chart rank auto-field) — collapsible filter card with mode in header
  const cardTitle = isChartRank
    ? `${localeText.filterModeRank}${chartYFieldLabel ? ` ${localeText.widgetAutoTitleBy} ${chartYFieldLabel}` : ''}`
    : fieldLabel;

  return (
    <FilterCard
      title={cardTitle}
      summary={summarizeFilter(filter, localeText)}
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
        availableSeries={availableSeries}
        onModeChange={handleModeChange}
        onChange={handleFilterChange}
        disableRankMode={disableRankMode}
      />
    </FilterCard>
  );
}
