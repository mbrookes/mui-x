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
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import SearchIcon from '@mui/icons-material/Search';
import {
  useStudioController,
  useStudioSelector,
  useStudioFeatures,
  selectShell,
  selectFilters,
  selectFilterPresets,
  selectDataSources,
  selectRelationships,
  selectWidgets,
  selectActivePageId,
} from '../context';
import { getReachableSourceIds } from '../internals/chartUtils';
import type { StudioDataSource, StudioFilterState } from '../models';
import type { SimpleField } from './filterDrawerTypes';
import { buildFieldOptions, generateId, summarizeFilter } from './filterDrawerUtils';
import {
  FilterSection,
  WidgetFilterSection,
  CrossFilterSection,
  InteractiveFilterSection,
} from './FilterSection';

export function StudioFiltersDrawer() {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const selectedWidgetId = shell.selectedWidgetId;
  const filters = useStudioSelector(selectFilters);
  const filterPresets = useStudioSelector(selectFilterPresets);
  const dataSources = useStudioSelector(selectDataSources);
  const widgets = useStudioSelector(selectWidgets);
  const relationships = useStudioSelector(selectRelationships);
  const activePageId = useStudioSelector(selectActivePageId);
  const features = useStudioFeatures();

  const [filterSearch, setFilterSearch] = React.useState('');


  const [savingPreset, setSavingPreset] = React.useState(false);
  const [presetName, setPresetName] = React.useState('');

  const allFields = React.useMemo(() => {
    const fieldMap = new Map<string, SimpleField>();
    for (const source of Object.values(dataSources) as StudioDataSource[]) {
      for (const field of source.fields) {
        if (!fieldMap.has(field.id)) {
          fieldMap.set(field.id, { id: field.id, label: field.label, fieldType: field.type });
        }
      }
    }
    return Array.from(fieldMap.values());
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

  // Chart rank filter context — xField dimension and yField measure label
  const chartXField =
    selectedWidget?.kind === 'chart' ? (selectedWidget.config.xField ?? undefined) : undefined;
  const chartYFieldId =
    selectedWidget?.kind === 'chart'
      ? (selectedWidget.config.ySeries?.[0]?.fieldId ?? selectedWidget.config.yField ?? undefined)
      : undefined;
  const chartYFieldLabel = React.useMemo(() => {
    if (!chartYFieldId || !selectedWidget?.sourceId) {
      return undefined;
    }
    const source = dataSources[selectedWidget.sourceId];
    return source?.fields.find((f) => f.id === chartYFieldId)?.label ?? chartYFieldId;
  }, [chartYFieldId, selectedWidget?.sourceId, dataSources]);

  // Derive available series for the rank-by selector (multi-series charts only)
  const chartAvailableSeries = React.useMemo(() => {
    if (selectedWidget?.kind !== 'chart' || !selectedWidget.sourceId) {
      return undefined;
    }
    const source = dataSources[selectedWidget.sourceId];
    if (!source) {
      return undefined;
    }
    const yFields =
      selectedWidget.config.ySeries && selectedWidget.config.ySeries.length > 1
        ? selectedWidget.config.ySeries
        : null;
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
      f.scope === 'page' && !f.isDashboardDateRange && (!f.pageId || f.pageId === activePageId),
  );
  const widgetFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'widget' && f.widgetId === selectedWidgetId,
  );
  const crossFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'cross-filter',
  );
  const interactiveFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'interactive',
  );

  // Build a map of field id → label for search matching
  const fieldLabelMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const f of allFields) {
      map.set(f.id, f.label);
    }
    return map;
  }, [allFields]);

  const searchLower = filterSearch.toLowerCase();

  function matchesSearch(filter: StudioFilterState): boolean {
    if (!searchLower) {
      return true;
    }
    const fieldLabel = fieldLabelMap.get(filter.field) ?? filter.field ?? '';
    const summary = summarizeFilter(filter);
    return (
      fieldLabel.toLowerCase().includes(searchLower) ||
      summary.toLowerCase().includes(searchLower)
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
      scope: 'page',
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
      scope: 'widget',
      widgetId: selectedWidgetId,
    });
  };

  return (
    <Stack spacing={2}>
      {allFields.length === 0 && (
        <Alert severity="info">Add a data source and widgets first.</Alert>
      )}

      {(pageFilters.length > 0 || widgetFilters.length > 0) && (
        <TextField
          size="small"
          placeholder="Search filters…"
          value={filterSearch}
          onChange={(e) => setFilterSearch(e.target.value)}
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
        title="Page filters"
        filters={visiblePageFilters}
        allFilters={pageFilters}
        fields={allFields}
        fieldOptions={fieldOptions}
        onAddFilter={handleAddPageFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
        emptyMessage={searchLower ? 'No matching filters.' : undefined}
      />

      {selectedWidgetId && selectedWidget?.kind !== 'filter' ? (
        <React.Fragment>
          <Divider />
          <WidgetFilterSection
            title={`Widget: ${selectedWidget?.title ?? selectedWidgetId}`}
            filters={visibleWidgetFilters}
            widgetSourceId={selectedWidget?.sourceId}
            fieldOptions={widgetFieldOptions}
            dataSources={dataSources}
            onAddFilter={handleAddWidgetFilter}
            onRemoveFilter={(id) => controller.removeFilter(id)}
            chartXField={chartXField}
            chartYFieldLabel={chartYFieldLabel}
            chartAvailableSeries={chartAvailableSeries}
            emptyMessage={searchLower ? 'No matching filters.' : undefined}
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
          <CrossFilterSection filters={crossFilters} />
        </React.Fragment>
      )}

      {/* Saved views */}
      {features.savedFilterViews && (
        <React.Fragment>
        <Divider />
        <div>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, fontWeight: 600 }}>
              Saved views
            </Typography>
            {!savingPreset && (
              <Tooltip title="Save current page filters as a named view">
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
                  Save
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
                placeholder="View name"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && presetName.trim()) {
                    controller.saveFilterPreset(presetName.trim());
                    setSavingPreset(false);
                  }
                  if (e.key === 'Escape') {
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
                          Save
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
              No saved views. Apply page filters and save them here.
            </Typography>
          )}

          <Stack spacing={0.5}>
            {filterPresets.map((preset) => (
              <Stack key={preset.id} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Chip
                  icon={<BookmarkIcon sx={{ fontSize: '14px !important' }} />}
                  label={preset.name}
                  size="small"
                  clickable
                  onClick={() => controller.applyFilterPreset(preset.id)}
                  sx={{ flexGrow: 1, justifyContent: 'flex-start' }}
                />
                <Tooltip title="Delete view">
                  <IconButton
                    size="small"
                    onClick={() => controller.deleteFilterPreset(preset.id)}
                    aria-label={`Delete view "${preset.name}"`}
                  >
                    <DeleteOutlineOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
        </div>
        </React.Fragment>
      )}
    </Stack>
  );
}