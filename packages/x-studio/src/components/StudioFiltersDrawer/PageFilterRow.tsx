'use client';
import * as React from 'react';
import { Alert, Box, IconButton, Stack } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  selectDataSources,
  selectExpressionFields,
  selectFilters,
  selectPages,
  useStudioLocaleText,
} from '../../context';
import type { StudioFilterState } from '../../models';
import {
  hasConflictingRankFilter,
  type RankFilterWidgetPageIndex,
} from '../../internals/rankFilterScope';
import type { FieldOption, FilterMode, SimpleField } from './filterDrawerTypes';
import {
  getOperators,
  resolveFilterField,
  summarizeFilter,
  buildFieldRepointReset,
  buildModeReset,
  isFilterEffective,
  isFilterFresh,
  filterMutationRejectionMessage,
} from './filterDrawerUtils';
import { useFieldValues } from './useFieldValues';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterCard } from './FilterCard';
import { FilterBody } from './FilterBody';
import { UnresolvedFieldAlert } from './UnresolvedFieldAlert';
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
  /**
   * Widget→page lookup for the rank-conflict check below, built ONCE per drawer render from
   * the same `pages` snapshot this row reads. Optional: an absent index falls
   * back to `hasConflictingRankFilter`'s own layout walk, which answers identically.
   */
  rankFilterPageIndex?: RankFilterWidgetPageIndex;
}

export function PageFilterRow(props: PageFilterRowProps) {
  const { fields, fieldOptions, filter, onRemove, allPageFilters, rankFilterPageIndex } = props;
  const localeText = useStudioLocaleText();
  const controller = useStudioController();

  const hasField = !!filter.field;
  // Mirror `WidgetFilterRow`'s `filter.filterSourceId`-scoped lookup. `fields` (the
  // include-hidden field catalog, `SimpleField[]`) is deduped by id across every source — it
  // drops `sourceId` — so an unscoped `fields.find` picks whichever source's field happened to
  // be seen first when two sources share a field id with different types. `fieldOptions`
  // carries `sourceId`, so once a filter has a stamped `filterSourceId` (always true for
  // drawer-authored cross-source picks — see the field picker below), resolve against the
  // field on THAT source instead. Fall back to the unscoped `fields` catalog only when no
  // `filterSourceId` is stamped (e.g. legacy/pre-source-scoping filters), matching prior
  // behavior for the common single-source case.
  const currentField = filter.filterSourceId
    ? fieldOptions.find((o) => o.id === filter.field && o.sourceId === filter.filterSourceId)
    : fields.find((f) => f.id === filter.field);
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

  // A cross-source "Depends on" pick can never resolve — `applyParentFilters`
  // (useFieldValues.ts) narrows by naive `row[parent.field]` against the CHILD source's own
  // rows, so a parent field from a different source is always absent from those rows and the
  // narrowing predicate always fails, silently emptying the child's option list. Restrict the
  // offered dependencies to parents whose owning source matches this filter's own source, the
  // same source resolution `currentField` above uses (stamped `filterSourceId`, falling back
  // to a `fieldOptions` lookup by id for filters that predate source-scoping).
  const resolveFilterSourceId = React.useCallback(
    (f: StudioFilterState) =>
      f.filterSourceId ?? fieldOptions.find((o) => o.id === f.field)?.sourceId,
    [fieldOptions],
  );
  const childSourceId = resolveFilterSourceId(filter);
  const dependencyOptions = React.useMemo(
    () =>
      allPageFilters.flatMap((f) => {
        if (f.id === filter.id || !f.field) {
          return [];
        }
        if (resolveFilterSourceId(f) !== childSourceId) {
          return [];
        }
        return [{ id: f.id, label: fields.find((sf) => sf.id === f.field)?.label ?? f.field }];
      }),
    [allPageFilters, filter.id, fields, resolveFilterSourceId, childSourceId],
  );

  const fieldValues = useFieldValues(filter.field, filter.filterSourceId, parentFilters);
  const fieldLabel = currentField?.label ?? filter.field;
  // A page filter whose field vanished (source reloaded with the column renamed/dropped)
  // silently matches zero rows on every widget it reaches, with the card still looking
  // normal. Resolve against the raw catalogs, not `fieldOptions`/`fields`, which drop hidden
  // and expression fields that a filter may legitimately target.
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const isFieldUnresolved =
    resolveFilterField(filter, dataSources, expressionFields) === 'unresolved';
  const filters = useStudioSelector(selectFilters);
  const pages = useStudioSelector(selectPages);
  // Per-page rank-uniqueness: mirror EXACTLY what `StudioController.updateFilter` allows
  // (a rank filter on another page is permitted), instead of the old dashboard-wide scan
  // that disabled rank mode more aggressively than the controller actually rejects it.
  const disableRankMode =
    filter.filterMode !== 'rank' &&
    hasConflictingRankFilter(filter.id, filter, filters, pages, rankFilterPageIndex);

  // `updateFilter` returns a `StudioMutationResult`, so a refusal is no longer
  // indistinguishable from a save. The reachable refusal here is `rank-conflict`: switching
  // this filter to Top-N when the page already has one. `disableRankMode` above normally
  // pre-empts it, but a concurrent edit (the AI assistant, another view, an undo) landing
  // between render and commit still gets through — and without this the Top-N control just
  // snapped back with nothing on screen saying why.
  //
  // `ok` with `committed: false` is a value-equal no-op, i.e. success — never an error.
  const [changeError, setChangeError] = React.useState<string | null>(null);
  const handleFilterChange = (changes: Partial<StudioFilterState>) => {
    const result = controller.updateFilter(filter.id, changes);
    setChangeError(result.ok ? null : filterMutationRejectionMessage(result.reason, localeText));
  };

  // 2.12: `activeOperator` above is a DISPLAY-ONLY fallback — when the stored operator is
  // invalid for the current field type, the row renders `operators[0]` while the engine
  // keeps applying the stale stored operator. Repair the doc to match what the UI shows.
  // Non-undoable, matching `KpiSetupPanel`'s `kpiAggregation` self-repair:
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
        {changeError && (
          <Alert severity="error" data-testid="page-filter-change-error">
            {changeError}
          </Alert>
        )}
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
                  // `buildFieldRepointReset` clears all five condition keys together
                  // (operator/value/operator2/value2/conjunction) — a stale second condition
                  // authored against the previous field would otherwise keep evaluating
                  // against the new one with no UI on screen to see or remove it.
                  handleFilterChange({
                    field: opt.id,
                    fieldType: opt.fieldType,
                    filterSourceId: opt.sourceId,
                    ...buildFieldRepointReset(currentMode),
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
      title={
        isFieldUnresolved ? localeText.dataSourceFieldUnavailableOption(filter.field) : fieldLabel
      }
      summary={summarizeFilter(filter, localeText)}
      onRemove={() => onRemove(filter.id)}
      // An unresolved field is opened by default: the whole point of the banner is that it
      // must be seen without the user first suspecting the filter.
      //
      // `!isFilterEffective(filter)` is deliberately NOT how a disabled filter surfaces — it
      // would force every disabled card open. The card's own switch + dimming carries that
      // state, so exclude `disabled` here and keep the expansion rule about authoring state.
      initialExpanded={
        isFieldUnresolved ||
        isFilterFresh(filter) ||
        (!filter.disabled && !isFilterEffective(filter))
      }
      disabled={filter.disabled}
      onToggleDisabled={() => controller.toggleFilter(filter.id)}
    >
      {changeError && (
        <Box sx={{ px: 1.5, pt: 1.5 }}>
          <Alert severity="error" data-testid="page-filter-change-error">
            {changeError}
          </Alert>
        </Box>
      )}
      {isFieldUnresolved && (
        <Box sx={{ px: 1.5, pt: 1.5 }}>
          <UnresolvedFieldAlert
            fieldId={filter.field}
            onRepoint={() =>
              handleFilterChange({
                field: '',
                fieldType: undefined,
                filterSourceId: undefined,
                // Same five-key clear as the phase-1 picker — the dialog's own repoint has
                // done this all along, the drawer's had not.
                ...buildFieldRepointReset(filter.filterMode ?? 'condition'),
              })
            }
          />
        </Box>
      )}
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
