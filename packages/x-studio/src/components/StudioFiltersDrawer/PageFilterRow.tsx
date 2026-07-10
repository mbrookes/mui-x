'use client';
import * as React from 'react';
import { Box, IconButton, Stack } from '@mui/material';
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

  const fieldValues = useFieldValues(filter.field, fieldType, filter.filterSourceId, parentFilters);
  const fieldLabel = currentField?.label ?? filter.field;
  const filters = useStudioSelector(selectFilters);
  const pages = useStudioSelector(selectPages);
  // Per-page rank-uniqueness: mirror EXACTLY what `StudioController.updateFilter` allows
  // (a rank filter on another page is permitted), instead of the old dashboard-wide scan
  // that disabled rank mode more aggressively than the controller actually rejects it.
  const disableRankMode =
    filter.filterMode !== 'rank' && hasConflictingRankFilter(filter.id, filter, filters, pages);

  const handleFilterChange = (changes: Partial<StudioFilterState>) => {
    controller.updateFilter(filter.id, changes);
  };

  // 2.12: `activeOperator` above is a DISPLAY-ONLY fallback — when the stored operator is
  // invalid for the current field type, the row renders `operators[0]` while the engine
  // keeps applying the stale stored operator. Repair the doc to match what the UI shows.
  // Non-undoable, matching `KpiSetupPanel`'s `kpiAggregation` self-repair (finding 2.4):
  // the write fires from rendering, not a user gesture, and self-terminates once valid.
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
