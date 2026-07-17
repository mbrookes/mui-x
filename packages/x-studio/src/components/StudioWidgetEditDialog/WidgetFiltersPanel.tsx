'use client';
import * as React from 'react';
import { Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { createFilterId } from '@mui/x-studio-schema';
import type { StudioFilterState, StudioDataField } from '../../models';
import { useStudioController } from '../../context/StudioContext';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import {
  selectDataSources,
  selectFilters,
  selectRelationships,
  selectWidgets,
  useStudioSelector,
} from '../../context';
import { FilterRow, type FieldOption } from './FilterRow';

// ── Panel ─────────────────────────────────────────────────────────────────────

export function WidgetFiltersPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const allFilters = useStudioSelector(selectFilters);
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);

  const widget = widgets[widgetId];
  const sourceId = widget?.sourceId;

  // Own source fields
  const ownFields: StudioDataField[] = React.useMemo(
    () => (sourceId ? (dataSources[sourceId]?.fields ?? []) : []),
    [dataSources, sourceId],
  );

  // Build flattened FieldOption list: own fields first, then fields from related sources
  const fieldOptions: FieldOption[] = React.useMemo(() => {
    if (!sourceId) {
      return [];
    }
    const options: FieldOption[] = ownFields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      hidden: f.hidden,
    }));
    for (const rel of relationships ?? []) {
      let relatedSourceId: string | undefined;
      if (rel.sourceId === sourceId) {
        relatedSourceId = rel.targetId;
      } else if (rel.targetId === sourceId) {
        relatedSourceId = rel.sourceId;
      }
      if (!relatedSourceId || !dataSources[relatedSourceId]) {
        continue;
      }
      const relatedSource = dataSources[relatedSourceId];
      const alreadyAdded = options.some((o) => o.sourceId === relatedSourceId);
      if (alreadyAdded) {
        continue;
      }
      for (const f of relatedSource.fields ?? []) {
        options.push({
          id: f.id,
          label: f.label,
          type: f.type,
          sourceId: relatedSourceId,
          sourceLabel: relatedSource.label ?? relatedSourceId,
          hidden: f.hidden,
        });
      }
    }
    return options;
  }, [dataSources, ownFields, relationships, sourceId]);

  const widgetFilters = React.useMemo(
    () =>
      allFilters.filter(
        (f) =>
          f.scope.kind === 'widget' &&
          f.scope.widgetId === widgetId &&
          f.dateRangePreset === undefined &&
          // 2.18: this dialog's `FilterRow` is a condition-only editor. A selection-mode
          // filter's array value would render/commit as a joined string (a blur silently
          // deactivating it), and a rank-mode filter would get a meaningless operator select
          // that writes junk operator keys onto it. Surface only condition filters here, the
          // same way the drawer dispatches to mode-appropriate editors elsewhere.
          (f.filterMode === 'condition' || f.filterMode === undefined),
      ),
    [allFilters, widgetId],
  );

  // 3.15: seed a new filter from the first VISIBLE own field only — a hidden field is
  // excluded from the data drawer / widget config selects everywhere else (GridSetupPanel,
  // the filters drawer), so silently seeding a new widget filter on a hidden field here
  // would contradict every other authoring picker.
  const addableOwnFields = React.useMemo(() => ownFields.filter((f) => !f.hidden), [ownFields]);

  const handleAdd = React.useCallback(() => {
    const firstField = addableOwnFields[0];
    if (!firstField) {
      return;
    }
    controller.addFilter({
      // 3.11: `wf-${widgetId}-${Date.now()}` collides on a fast double-click (two adds in the
      // same millisecond), and `addFilter` is idempotent on `id`, so the reducer silently
      // drops the second filter as a re-delivery. Use the collision-resistant factory.
      id: createFilterId(),
      field: firstField.id,
      fieldType: firstField.type,
      operator: 'equals',
      value: '',
      scope: { kind: 'widget', widgetId },
    });
  }, [controller, addableOwnFields, widgetId]);

  const handleRemove = React.useCallback(
    (filterId: string) => {
      controller.removeFilter(filterId);
    },
    [controller],
  );

  const handleUpdate = React.useCallback(
    (filterId: string, patch: Partial<StudioFilterState>) => {
      controller.updateFilter(filterId, patch);
    },
    [controller],
  );

  if (!widget || !sourceId) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        {localeText.widgetFiltersPanelNoSource}
      </Typography>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {localeText.widgetFiltersPanelDescription}
      </Typography>

      {widgetFilters.length > 0 ? (
        <Stack spacing={1.5}>
          {widgetFilters.map((filter) => (
            <FilterRow
              key={filter.id}
              filter={filter}
              fieldOptions={fieldOptions}
              onRemove={() => handleRemove(filter.id)}
              onUpdate={(patch) => handleUpdate(filter.id, patch)}
            />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ fontStyle: 'italic' }}>
          {localeText.widgetFiltersPanelNoFilters}
        </Typography>
      )}

      <Button
        size="small"
        startIcon={<AddIcon />}
        onClick={handleAdd}
        disabled={addableOwnFields.length === 0}
        sx={{ alignSelf: 'flex-start' }}
      >
        {localeText.widgetFiltersPanelAddButton}
      </Button>
    </Stack>
  );
}
