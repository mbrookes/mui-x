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
import { getReachableSourceIds } from '../../internals/dataSourceGraph';
import { buildFieldCatalog, buildFieldLabelMap } from '../../internals/fieldCatalog';
import { isWidgetOfKind } from '../../models';
import type { StudioChartConfig, StudioFilterState } from '../../models';
import type { SimpleField } from './filterDrawerTypes';
import { buildFieldOptions, generateId, summarizeFilter } from './filterDrawerUtils';
import { FilterSection, WidgetFilterSection } from './FilterSection';
import { InteractiveFilterSection } from './InteractiveFilterSection';
import { CrossFilterSection } from './CrossFilterSection';

/**
 * Content-comparison of a filter, ignoring the fields `applyFilterPreset` rewrites when it
 * materializes a preset: the re-minted `id` and the page-rescoped `scope`. Used to decide
 * whether the live page filters still equal a saved view (finding 3.10).
 */
function normalizeFilterForCompare(filter: StudioFilterState): string {
  const { id, scope, ...rest } = filter;
  return JSON.stringify(rest);
}

/** True when two filter lists are content-equivalent regardless of order/id/scope. */
function filtersEquivalent(a: StudioFilterState[], b: StudioFilterState[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = a.map(normalizeFilterForCompare).sort();
  const sortedB = b.map(normalizeFilterForCompare).sort();
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
    const source = dataSources[selectedWidget.sourceId];
    return source?.fields.find((f) => f.id === chartYFieldId)?.label ?? chartYFieldId;
  }, [chartYFieldId, selectedWidget?.sourceId, dataSources]);

  // Derive available series for the rank-by selector (multi-series charts only)
  const chartAvailableSeries = React.useMemo(() => {
    if (!selectedWidget || !isWidgetOfKind(selectedWidget, 'chart') || !selectedWidget.sourceId) {
      return undefined;
    }
    const source = dataSources[selectedWidget.sourceId];
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

  const pageFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) =>
      f.scope.kind === 'page' && (!f.scope.pageId || f.scope.pageId === activePageId),
  );
  const widgetFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope.kind === 'widget' && f.scope.widgetId === selectedWidgetId,
  );
  const crossFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) =>
      f.scope.kind === 'cross-filter' && (crossFilterAllPages || f.scope.pageId === activePageId),
  );
  const interactiveFilters = (filters as StudioFilterState[]).filter(
    // Scope to the active page, exactly as the filter engine does (`filterScoping.ts`'s
    // `interactive` case) — otherwise the drawer lists "active" interactive filters from other
    // pages that affect nothing on the current one (Tier 3 drawer/engine mismatch).
    (f: StudioFilterState) => f.scope.kind === 'interactive' && f.scope.pageId === activePageId,
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

  function matchesSearch(filter: StudioFilterState): boolean {
    if (!searchLower) {
      return true;
    }
    const fieldLabel = fieldLabelMap.get(filter.field) ?? filter.field ?? '';
    const summary = summarizeFilter(filter, localeText);
    return (
      fieldLabel.toLowerCase().includes(searchLower) || summary.toLowerCase().includes(searchLower)
    );
  }

  const visiblePageFilters = pageFilters.filter(matchesSearch);
  const visibleWidgetFilters = widgetFilters.filter(matchesSearch);

  const handleAddPageFilter = () => {
    if (allFields.length === 0) {
      return;
    }
    controller.addFilter({
      id: generateId(),
      field: '',
      operator: 'equals',
      value: '',
      scope: { kind: 'page' },
    });
  };

  const handleAddWidgetFilter = () => {
    if (!selectedWidgetId || Object.keys(dataSources).length === 0) {
      return;
    }
    controller.addFilter({
      id: generateId(),
      field: '',
      operator: 'equals',
      value: '',
      scope: { kind: 'widget', widgetId: selectedWidgetId },
    });
  };

  return (
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
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: filterSearch ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setFilterSearch('')} edge="end">
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : null,
            },
          }}
        />
      )}

      <FilterSection
        title={localeText.filtersSectionPageFiltersTitle}
        filters={visiblePageFilters}
        allFilters={pageFilters}
        fields={allFields}
        fieldOptions={fieldOptions}
        onAddFilter={handleAddPageFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
        emptyMessage={searchLower ? localeText.filtersSectionNoMatchingFilters : undefined}
      />

      {selectedWidgetId && selectedWidget?.kind !== 'filter' && selectedWidget?.kind !== 'text' ? (
        <React.Fragment>
          <Divider />
          <WidgetFilterSection
            title={localeText.filtersSectionWidgetTitle(selectedWidget?.title ?? selectedWidgetId)}
            filters={visibleWidgetFilters}
            widgetSourceId={selectedWidget?.sourceId}
            fieldOptions={widgetFieldOptions}
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
                <Chip
                  icon={<HomeOutlinedIcon sx={{ fontSize: '14px !important' }} />}
                  label={localeText.filtersDefaultViewLabel}
                  size="small"
                  color={isDefaultViewActive ? 'primary' : 'default'}
                  disabled={isDefaultViewActive}
                  clickable={!isDefaultViewActive}
                  onClick={!isDefaultViewActive ? () => controller.clearPageFilters() : undefined}
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
                      <Chip
                        icon={<BookmarkIcon sx={{ fontSize: '14px !important' }} />}
                        label={preset.name}
                        size="small"
                        color={isActive ? 'primary' : 'default'}
                        disabled={isActive}
                        clickable={!isActive}
                        onClick={
                          isActive ? undefined : () => controller.applyFilterPreset(preset.id)
                        }
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
  );
}
