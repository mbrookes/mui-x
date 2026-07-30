'use client';
import * as React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ClearIcon from '@mui/icons-material/Clear';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import SearchIcon from '@mui/icons-material/Search';
import type { SxProps, Theme } from '@mui/material/styles';
import { createFilterId } from '@mui/x-studio-schema';
import {
  useStudioController,
  useStudioSelector,
  useStudioFeatures,
  useStudioLocaleText,
  selectShell,
  selectFilters,
  selectFilterPresets,
  selectDataSources,
  selectRelationships,
  selectWidgets,
  selectActivePageId,
  selectPages,
  selectCrossFilterAllPages,
} from '../../context';
import { useWidgetDefMap } from '../../internals/builtinWidgetDefs';
import { getReachableSourceIds } from '../../internals/dataSourceGraph';
import { buildFieldCatalog, buildFieldLabelMap } from '../../internals/fieldCatalog';
import { buildRankFilterWidgetPageIndex } from '../../internals/rankFilterScope';
import { StudioDrawerErrorBoundary } from '../../internals/StudioDrawerErrorBoundary';
import { isWidgetOfKind } from '../../models';
import type { StudioChartConfig, StudioFilterState } from '../../models';
import type { SimpleField } from './filterDrawerTypes';
import {
  buildFieldOptions,
  filterMutationRejectionMessage,
  summarizeFilter,
} from './filterDrawerUtils';
import { FilterSection, WidgetFilterSection } from './FilterSection';
import { InteractiveFilterSection } from './InteractiveFilterSection';
import { CrossFilterSection } from './CrossFilterSection';

/**
 * Content-comparison of a filter, ignoring the fields `applyFilterPreset` rewrites when it
 * materializes a preset: the re-minted `id` and the page-rescoped `scope`. Used to decide
 * whether the live page filters still equal a saved view (finding 3.10).
 *
 * `dependsOn` (cascade references to other filters' ids, finding 3.11) is remapped from raw
 * ids to the referenced filter's *position* within `indexById` — a map built once per compared
 * set (see `filtersEquivalent`). Live filter ids, `${presetId}-*` preset-baked ids, and the
 * fresh ids `applyFilterPreset` mints all live in different id-spaces, so a live filter and its
 * saved-preset counterpart never share a literal `dependsOn` id even when the cascade they
 * encode is identical — comparing positions within each own set is space-independent.
 */
function normalizeFilterForCompare(
  filter: StudioFilterState,
  indexById: Map<string, number>,
): string {
  const { id, scope, dependsOn, ...rest } = filter;
  const normalizedDependsOn = dependsOn
    ?.map((depId) => indexById.get(depId))
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
  return JSON.stringify({
    ...rest,
    dependsOn:
      normalizedDependsOn && normalizedDependsOn.length > 0 ? normalizedDependsOn : undefined,
  });
}

/** True when two filter lists are content-equivalent regardless of order/id/scope. */
function filtersEquivalent(a: StudioFilterState[], b: StudioFilterState[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const indexByIdA = new Map(a.map((f, index) => [f.id, index]));
  const indexByIdB = new Map(b.map((f, index) => [f.id, index]));
  const sortedA = a.map((f) => normalizeFilterForCompare(f, indexByIdA)).sort();
  const sortedB = b.map((f) => normalizeFilterForCompare(f, indexByIdB)).sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export interface StudioFiltersDrawerProps {
  /**
   * System prop that allows defining system overrides and additional CSS styles applied to the
   * root element. Accepts valid CSS properties and MUI system values.
   */
  sx?: SxProps<Theme>;
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- filter drawer orchestrates many filter types and cannot be easily split
// react-doctor-disable-next-line react-doctor/prefer-useReducer -- state slices are independent workflows (search, saving, renaming)
export function StudioFiltersDrawer({ sx }: StudioFiltersDrawerProps = {}) {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const selectedWidgetId = shell.selectedWidgetId;
  const filters = useStudioSelector(selectFilters);
  const filterPresets = useStudioSelector(selectFilterPresets);
  const dataSources = useStudioSelector(selectDataSources);
  const widgets = useStudioSelector(selectWidgets);
  const relationships = useStudioSelector(selectRelationships);
  const activePageId = useStudioSelector(selectActivePageId);
  const pages = useStudioSelector(selectPages);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();

  const [filterSearch, setFilterSearch] = React.useState('');

  const [savingPreset, setSavingPreset] = React.useState(false);
  const [presetName, setPresetName] = React.useState('');

  const [renamingPresetId, setRenamingPresetId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');

  const handleRenameStart = (presetId: string, currentName: string) => {
    setRenamingPresetId(presetId);
    setRenameValue(currentName);
  };

  const handleRenameConfirm = () => {
    if (renamingPresetId && renameValue.trim()) {
      controller.renameFilterPreset(renamingPresetId, renameValue.trim());
    }
    setRenamingPresetId(null);
    setRenameValue('');
  };

  const handleRenameCancel = () => {
    setRenamingPresetId(null);
    setRenameValue('');
  };

  // Unlike Chart/KPI's field catalogs, the filters drawer must list every field — including
  // hidden ones — so a filter already configured on a since-hidden field still resolves a
  // label/type here (see `internals/fieldCatalog.ts`'s `buildFieldCatalog` doc, finding 2.4).
  const allFields = React.useMemo<SimpleField[]>(() => {
    const seen = new Set<string>();
    const fields: SimpleField[] = [];
    for (const entry of buildFieldCatalog(dataSources, [], {
      expression: 'none',
      includeHidden: true,
      sort: false,
    })) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        fields.push({ id: entry.id, label: entry.label, fieldType: entry.type });
      }
    }
    return fields;
  }, [dataSources]);

  const fieldOptions = React.useMemo(() => buildFieldOptions(dataSources), [dataSources]);

  const selectedWidget = selectedWidgetId ? widgets[selectedWidgetId] : null;

  // H4: whether this widget kind can carry widget-scoped filters is the widget DEF's
  // `capabilities.widgetFilters`, not a hardcoded list of kind strings here. The drawer used
  // to exclude `'filter'` and `'text'` by name while `builtinWidgetDefs` declared `filter` as
  // `widgetFilters: true`, so the widget edit dialog offered a Filters tab for a filter widget
  // whose filters nothing evaluates — and which this section then hid, leaving them
  // unreachable. Reading the single capability keeps the two surfaces from disagreeing again,
  // and makes custom widgets that opt out behave consistently on both.
  const widgetDefMap = useWidgetDefMap();
  const selectedWidgetSupportsFilters =
    selectedWidget != null &&
    widgetDefMap.get(selectedWidget.kind)?.capabilities?.widgetFilters !== false;

  const widgetFieldOptions = React.useMemo(() => {
    if (!selectedWidget?.sourceId) {
      return fieldOptions;
    }
    const reachable = getReachableSourceIds(selectedWidget.sourceId, relationships);
    return fieldOptions.filter((o) => reachable.has(o.sourceId));
  }, [fieldOptions, selectedWidget?.sourceId, relationships]);

  // Chart rank filter context — xField dimension and yField measure label. Read
  // through the flat cross-family config type since these keys span chart families.
  const chartConfig =
    selectedWidget && isWidgetOfKind(selectedWidget, 'chart')
      ? (selectedWidget.config as StudioChartConfig)
      : undefined;
  const chartXField = chartConfig?.xField ?? undefined;
  const chartYFieldId = chartConfig?.ySeries?.[0]?.fieldId ?? chartConfig?.yField ?? undefined;
  const chartYFieldLabel = React.useMemo(() => {
    if (!chartYFieldId || !selectedWidget?.sourceId) {
      return undefined;
    }
    // `sourceId` is doc-authored: guard the record index against inherited prototype keys
    // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function instead
    // of "not found" and then throw on `source?.fields` (prototype-chain key lookup fix).
    const source = Object.hasOwn(dataSources, selectedWidget.sourceId)
      ? dataSources[selectedWidget.sourceId]
      : undefined;
    return source?.fields.find((f) => f.id === chartYFieldId)?.label ?? chartYFieldId;
  }, [chartYFieldId, selectedWidget?.sourceId, dataSources]);

  // Derive available series for the rank-by selector (multi-series charts only)
  const chartAvailableSeries = React.useMemo(() => {
    if (!selectedWidget || !isWidgetOfKind(selectedWidget, 'chart') || !selectedWidget.sourceId) {
      return undefined;
    }
    // `sourceId` is doc-authored: guard the record index against inherited prototype keys
    // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function instead
    // of "not found" and then throw on `source?.fields` (prototype-chain key lookup fix).
    const source = Object.hasOwn(dataSources, selectedWidget.sourceId)
      ? dataSources[selectedWidget.sourceId]
      : undefined;
    if (!source) {
      return undefined;
    }
    const seriesConfig = selectedWidget.config as StudioChartConfig;
    const yFields =
      seriesConfig.ySeries && seriesConfig.ySeries.length > 1 ? seriesConfig.ySeries : null;
    if (!yFields) {
      return undefined;
    }
    return yFields.flatMap((s) => {
      if (!s.fieldId) {
        return [];
      }
      return [
        {
          fieldId: s.fieldId as string,
          label: source.fields.find((f) => f.id === s.fieldId)?.label ?? s.fieldId,
        },
      ];
    });
  }, [selectedWidget, dataSources]);

  // R4 F8: `hasConflictingRankFilter` resolves a `widget`-scoped filter's page context by
  // walking every page's `widgetRows`, and BOTH row components call it once per rendered row
  // to decide whether their Rank toggle is disabled. `pages` is one immutable snapshot for the
  // whole render, so R rows were re-deriving the identical widget→page mapping R times — the
  // same O(R·W) sweep the schema package already collapsed inside `dedupeRankFilters`. Build
  // it ONCE here, where the drawer owns the page snapshot, and thread it into every row.
  const rankFilterPageIndex = React.useMemo(() => buildRankFilterWidgetPageIndex(pages), [pages]);

  // M11: memoized, not re-`.filter()`ed on every render. `pageFilters` in particular is handed
  // down as `allFilters` → `PageFilterRow`'s `allPageFilters`, where it keys the `parentFilters`
  // memo that feeds `useFieldValues`. A fresh array identity on every drawer render (e.g. one
  // per keystroke in the search box above) invalidated that memo and made every cascading
  // selection filter re-scan its entire data source — allocating a filtered row copy, a `Set`,
  // and a `sort` — synchronously during render.
  const pageFilters = React.useMemo(
    () =>
      (filters as StudioFilterState[]).filter(
        (f: StudioFilterState) =>
          f.scope.kind === 'page' && (!f.scope.pageId || f.scope.pageId === activePageId),
      ),
    [filters, activePageId],
  );
  const widgetFilters = React.useMemo(
    () =>
      (filters as StudioFilterState[]).filter(
        (f: StudioFilterState) =>
          f.scope.kind === 'widget' &&
          f.scope.widgetId === selectedWidgetId &&
          // 2.4: the `widget-date-range-*` filter is managed exclusively via the KPI setup panel
          // (see `StudioController.setWidgetDateRange`'s doc) — hide it here the same way
          // `WidgetFiltersPanel.tsx` does, so the drawer doesn't expose a phantom card whose
          // edits are silently discarded (its `value` is recomputed from `dateRangePreset` at
          // query time).
          f.dateRangePreset === undefined,
      ),
    [filters, selectedWidgetId],
  );
  const crossFilters = React.useMemo(
    () =>
      (filters as StudioFilterState[]).filter(
        (f: StudioFilterState) =>
          f.scope.kind === 'cross-filter' &&
          (crossFilterAllPages || f.scope.pageId === activePageId),
      ),
    [filters, crossFilterAllPages, activePageId],
  );
  const interactiveFilters = React.useMemo(
    () =>
      (filters as StudioFilterState[]).filter(
        // Scope to the active page, exactly as the filter engine does (`filterScoping.ts`'s
        // `interactive` case) — otherwise the drawer lists "active" interactive filters from
        // other pages that affect nothing on the current one (Tier 3 drawer/engine mismatch).
        (f: StudioFilterState) => f.scope.kind === 'interactive' && f.scope.pageId === activePageId,
      ),
    [filters, activePageId],
  );

  // 3.10: derive the active saved-view from the doc rather than tracking it as component
  // state. A separate local `activePresetId` desynced from the filters it described — Ctrl+Z
  // restored the filters but left the preset chip "active"/disabled, and drawer unmount/remount
  // forgot it while the filters remained. `isDefaultViewActive` is the cleared-filters view;
  // `activePresetId` is the preset whose snapshot matches the live page filters (if any).
  const isDefaultViewActive = pageFilters.length === 0;
  const activePresetId = React.useMemo(() => {
    if (pageFilters.length === 0) {
      return null;
    }
    const match = filterPresets.find(
      (preset) => preset.filters.length > 0 && filtersEquivalent(pageFilters, preset.filters),
    );
    return match ? match.id : null;
  }, [filterPresets, pageFilters]);

  // Build a map of field id → label for search matching
  const fieldLabelMap = React.useMemo(() => buildFieldLabelMap(dataSources), [dataSources]);

  const searchLower = filterSearch.toLowerCase();

  const matchesSearch = React.useCallback(
    (filter: StudioFilterState): boolean => {
      if (!searchLower) {
        return true;
      }
      const fieldLabel = fieldLabelMap.get(filter.field) ?? filter.field ?? '';
      const summary = summarizeFilter(filter, localeText);
      return (
        fieldLabel.toLowerCase().includes(searchLower) ||
        summary.toLowerCase().includes(searchLower)
      );
    },
    [searchLower, fieldLabelMap, localeText],
  );

  const visiblePageFilters = React.useMemo(
    () => pageFilters.filter(matchesSearch),
    [pageFilters, matchesSearch],
  );
  const visibleWidgetFilters = React.useMemo(
    () => widgetFilters.filter(matchesSearch),
    [widgetFilters, matchesSearch],
  );

  // A freshly added filter has no field yet, so `matchesSearch` rejects it: adding one while
  // the search box has text would create an invisible filter (and an undo entry) under an
  // empty-state message reading "No matching filters". Clearing the search keeps the invariant
  // that what the user just added is what the user sees.
  // `addFilter` returns a `StudioMutationResult`, so a refusal is no longer indistinguishable
  // from a save. Both handlers used to clear the search box BEFORE the add, so a rejected add
  // wiped the user's search for nothing and left no filter and no explanation. Commit first,
  // then clear the search only on success.
  const [addError, setAddError] = React.useState<string | null>(null);

  const handleAddPageFilter = () => {
    if (allFields.length === 0) {
      return;
    }
    const result = controller.addFilter({
      id: createFilterId(),
      field: '',
      operator: 'equals',
      value: '',
      scope: { kind: 'page' },
    });
    if (!result.ok) {
      setAddError(filterMutationRejectionMessage(result.reason, localeText));
      return;
    }
    setAddError(null);
    setFilterSearch('');
  };

  const handleAddWidgetFilter = () => {
    if (!selectedWidgetId || Object.keys(dataSources).length === 0) {
      return;
    }
    const result = controller.addFilter({
      id: createFilterId(),
      field: '',
      operator: 'equals',
      value: '',
      scope: { kind: 'widget', widgetId: selectedWidgetId },
    });
    if (!result.ok) {
      setAddError(filterMutationRejectionMessage(result.reason, localeText));
      return;
    }
    setAddError(null);
    setFilterSearch('');
  };

  // Defense-in-depth (this drawer had no error boundary at all): a render throw from any
  // section below (e.g. a filter row reading a hostile/malformed doc-authored field or
  // source id) previously had no boundary to stop at and unmounted the entire `<Studio>`
  // tree. `resetKey` tracks the selected widget, so switching selection after a transient
  // error clears the fallback instead of latching it.
  return (
    <StudioDrawerErrorBoundary resetKey={selectedWidgetId ?? 'none'}>
      <Stack spacing={2} sx={sx}>
        {allFields.length === 0 && (
          <Alert severity="info">{localeText.filtersAddDataSourceHint}</Alert>
        )}

        {(pageFilters.length > 0 || widgetFilters.length > 0) && (
          <TextField
            size="small"
            placeholder={localeText.filterSearchPlaceholder}
            value={filterSearch}
            onChange={(event) => setFilterSearch(event.target.value)}
            slotProps={{
              // M20: a placeholder is only a last-resort accessible-name source.
              htmlInput: { 'aria-label': localeText.filterSearchPlaceholder },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: filterSearch ? (
                  <InputAdornment position="end">
                    {/* Icon-only, and NOT wrapped in a `<Tooltip title={string}>` — which is
                        how the other 64 `IconButton`s in this package get their accessible
                        name — so it announced as a bare "button" (WCAG 4.1.2). */}
                    <IconButton
                      size="small"
                      onClick={() => setFilterSearch('')}
                      edge="end"
                      aria-label={localeText.filterSearchClearAriaLabel}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : null,
              },
            }}
          />
        )}

        {addError && (
          <Alert severity="error" data-testid="filters-drawer-add-error">
            {addError}
          </Alert>
        )}

        <FilterSection
          title={localeText.filtersSectionPageFiltersTitle}
          filters={visiblePageFilters}
          allFilters={pageFilters}
          fields={allFields}
          fieldOptions={fieldOptions}
          rankFilterPageIndex={rankFilterPageIndex}
          onAddFilter={handleAddPageFilter}
          onRemoveFilter={(id) => controller.removeFilter(id)}
          emptyMessage={searchLower ? localeText.filtersSectionNoMatchingFilters : undefined}
        />

        {selectedWidgetId && selectedWidgetSupportsFilters ? (
          <React.Fragment>
            <Divider />
            <WidgetFilterSection
              title={localeText.filtersSectionWidgetTitle(
                selectedWidget?.title ?? selectedWidgetId,
              )}
              filters={visibleWidgetFilters}
              widgetSourceId={selectedWidget?.sourceId}
              fieldOptions={widgetFieldOptions}
              rankFilterPageIndex={rankFilterPageIndex}
              dataSources={dataSources}
              onAddFilter={handleAddWidgetFilter}
              onRemoveFilter={(id) => controller.removeFilter(id)}
              chartXField={chartXField}
              chartYFieldLabel={chartYFieldLabel}
              chartAvailableSeries={chartAvailableSeries}
              emptyMessage={searchLower ? localeText.filtersSectionNoMatchingFilters : undefined}
            />
          </React.Fragment>
        ) : null}

        {interactiveFilters.length > 0 && (
          <React.Fragment>
            <Divider />
            <InteractiveFilterSection filters={interactiveFilters} />
          </React.Fragment>
        )}

        {crossFilters.length > 0 && (
          <React.Fragment>
            <Divider />
            <CrossFilterSection filters={crossFilters} pages={pages} activePageId={activePageId} />
          </React.Fragment>
        )}

        {/* Saved views */}
        {features.savedFilterViews && (
          <React.Fragment>
            <Divider />
            <div>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ flexGrow: 1, fontWeight: 600 }}
                >
                  {localeText.filtersSavedViewsTitle}
                </Typography>
                {!savingPreset && (
                  <Tooltip title={localeText.filtersSaveViewTooltip}>
                    <Button
                      size="small"
                      startIcon={<BookmarkBorderIcon fontSize="small" />}
                      onClick={() => {
                        setSavingPreset(true);
                        setPresetName('');
                      }}
                      disabled={pageFilters.length === 0}
                      sx={{ fontSize: 11 }}
                    >
                      {localeText.filtersSaveViewButton}
                    </Button>
                  </Tooltip>
                )}
              </Stack>

              {savingPreset && (
                <Box sx={{ mb: 1 }}>
                  <TextField
                    size="small"
                    fullWidth
                    autoFocus
                    placeholder={localeText.filtersSaveViewPlaceholder}
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && presetName.trim()) {
                        controller.saveFilterPreset(presetName.trim());
                        setSavingPreset(false);
                      }
                      if (event.key === 'Escape') {
                        setSavingPreset(false);
                      }
                    }}
                    slotProps={{
                      // M20: this field is AUTOFOCUSED, so its accessible name is the first
                      // thing announced when the save-view flow opens — a placeholder alone is
                      // the weakest possible source for it.
                      htmlInput: { 'aria-label': localeText.filtersSaveViewPlaceholder },
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">
                            <Button
                              size="small"
                              disabled={!presetName.trim()}
                              onClick={() => {
                                if (presetName.trim()) {
                                  controller.saveFilterPreset(presetName.trim());
                                  setSavingPreset(false);
                                }
                              }}
                            >
                              {localeText.filtersSaveViewButton}
                            </Button>
                          </InputAdornment>
                        ),
                      },
                    }}
                  />
                </Box>
              )}

              {filterPresets.length === 0 && !savingPreset && (
                <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
                  {localeText.filtersNoSavedViews}
                </Typography>
              )}

              <Stack spacing={0.5}>
                {filterPresets.length > 0 && (
                  // M20: `disabled` used to mean "this is the view you are on". That is what
                  // `aria-current` is for — `disabled` says "this control does not work",
                  // strips the chip from the tab order, and hides the very state it was meant
                  // to convey from anyone navigating by keyboard or screen reader. The chip
                  // stays focusable and the handler no-ops when it is already current.
                  <Chip
                    icon={<HomeOutlinedIcon sx={{ fontSize: '14px !important' }} />}
                    label={localeText.filtersDefaultViewLabel}
                    size="small"
                    color={isDefaultViewActive ? 'primary' : 'default'}
                    aria-current={isDefaultViewActive ? 'true' : undefined}
                    clickable
                    onClick={() => {
                      if (!isDefaultViewActive) {
                        controller.clearPageFilters();
                      }
                    }}
                    sx={{ justifyContent: 'flex-start' }}
                  />
                )}
                {filterPresets.map((preset) => {
                  const isActive = preset.id === activePresetId;
                  return (
                    <Stack
                      key={preset.id}
                      direction="row"
                      spacing={0.5}
                      sx={{ alignItems: 'center' }}
                    >
                      {renamingPresetId === preset.id ? (
                        <TextField
                          size="small"
                          value={renameValue}
                          autoFocus
                          sx={{ flexGrow: 1 }}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              handleRenameConfirm();
                            } else if (event.key === 'Escape') {
                              handleRenameCancel();
                            }
                          }}
                          onBlur={handleRenameConfirm}
                          slotProps={{
                            input: { 'aria-label': localeText.filtersRenameViewAriaLabel },
                          }}
                        />
                      ) : (
                        // M20: `aria-current`, not `disabled` — see the default-view chip above.
                        // Re-clicking the active preset is a no-op rather than a re-apply
                        // (`applyFilterPreset` re-mints filter ids, so it would push an undo
                        // entry for a change the user cannot see) — but that is now enforced by
                        // `docTransforms.applyFilterPreset`'s own identity bail, so the local
                        // `if (!isActive)` guard here is gone. `isActive` still drives the chip's
                        // `aria-current` and `color`, which is why `filtersEquivalent` /
                        // `normalizeFilterForCompare` remain.
                        <Chip
                          icon={<BookmarkIcon sx={{ fontSize: '14px !important' }} />}
                          label={preset.name}
                          size="small"
                          color={isActive ? 'primary' : 'default'}
                          aria-current={isActive ? 'true' : undefined}
                          clickable
                          onClick={() => controller.applyFilterPreset(preset.id)}
                          sx={{ flexGrow: 1, justifyContent: 'flex-start' }}
                        />
                      )}
                      <Tooltip title={localeText.filtersDrawerRenameViewTooltip}>
                        <IconButton
                          size="small"
                          onClick={() => handleRenameStart(preset.id, preset.name)}
                          aria-label={localeText.filtersRenameViewButtonAriaLabel(preset.name)}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={localeText.filtersDeleteViewTooltip}>
                        <IconButton
                          size="small"
                          onClick={() => controller.deleteFilterPreset(preset.id)}
                          aria-label={localeText.filtersDeleteViewAriaLabel(preset.name)}
                        >
                          <DeleteOutlineOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  );
                })}
              </Stack>
            </div>
          </React.Fragment>
        )}
      </Stack>
    </StudioDrawerErrorBoundary>
  );
}
