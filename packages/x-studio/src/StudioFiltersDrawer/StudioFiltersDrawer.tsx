'use client';
import * as React from 'react';
import { Alert, Divider, Stack } from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectShell,
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectWidgets,
} from '../context';
import { getReachableSourceIds } from '../internals/chartUtils';
import type { StudioDataSource, StudioFilterState } from '../models';
import type { SimpleField } from './filterDrawerTypes';
import { buildFieldOptions, generateId } from './filterDrawerUtils';
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
  const dataSources = useStudioSelector(selectDataSources);
  const widgets = useStudioSelector(selectWidgets);
  const relationships = useStudioSelector(selectRelationships);

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
      if (!s.fieldId) return [];
      return [
        {
          fieldId: s.fieldId as string,
          label: source.fields.find((f) => f.id === s.fieldId)?.label ?? s.fieldId,
        },
      ];
    });
  }, [selectedWidget, dataSources]);

  const pageFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'page',
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

      <FilterSection
        title="Page filters"
        filters={pageFilters}
        fields={allFields}
        fieldOptions={fieldOptions}
        onAddFilter={handleAddPageFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
      />

      <Divider />

      {selectedWidgetId && selectedWidget?.kind !== 'filter' ? (
        <React.Fragment>
          <WidgetFilterSection
            title={`Widget: ${selectedWidget?.title ?? selectedWidgetId}`}
            filters={widgetFilters}
            widgetSourceId={selectedWidget?.sourceId}
            fieldOptions={widgetFieldOptions}
            dataSources={dataSources}
            onAddFilter={handleAddWidgetFilter}
            onRemoveFilter={(id) => controller.removeFilter(id)}
            chartXField={chartXField}
            chartYFieldLabel={chartYFieldLabel}
            chartAvailableSeries={chartAvailableSeries}
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
    </Stack>
  );
}
