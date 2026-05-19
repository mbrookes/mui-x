'use client';
import * as React from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import CheckIcon from '@mui/icons-material/Check';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import type { StudioCrossFilterMode, StudioGridColumn, StudioGridSummaryAggregation } from '../models';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectRelationships,
} from '../context';
import { getReachableSourceIds } from '../internals/chartUtils';
import { FieldTypeIcon } from '../internals/FieldTypeIcon';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';

const NUMERIC_AGGREGATIONS: StudioGridSummaryAggregation[] = ['sum', 'avg', 'min', 'max', 'count'];
const STRING_AGGREGATIONS: StudioGridSummaryAggregation[] = ['count'];

const AGG_LABELS: Record<StudioGridSummaryAggregation, string> = {
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  min: 'Min',
  max: 'Max',
};

/** A selectable field entry with its source context */
interface SelectableField {
  fieldId: string;
  label: string;
  type: string;
  generated?: boolean;
  sourceId: string;
  sourceLabel: string;
  isPrimary: boolean;
}

export function GridSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;

  // configColumns: the current StudioGridColumn[] from widget config, or default all-primary-fields
  const primaryFields = React.useMemo(
    () => (source?.fields ?? []).filter((f) => !f.hidden),
    [source],
  );
  const configColumns: StudioGridColumn[] = React.useMemo(() => {
    if (widget?.config?.columns?.length) {
      return widget.config.columns;
    }
    return primaryFields.map((f) => ({ fieldId: f.id }));
  }, [widget?.config?.columns, primaryFields]);

  // All selectable fields: primary source + many-to-one reachable related sources
  const allSelectableFields = React.useMemo<SelectableField[]>(() => {
    if (!widget?.sourceId || !source) {
      return [];
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    const fields: SelectableField[] = [];

    // Primary source first
    for (const f of primaryFields) {
      fields.push({
        fieldId: f.id,
        label: f.label,
        type: f.type,
        generated: f.generated,
        sourceId: widget.sourceId,
        sourceLabel: source.label,
        isPrimary: true,
      });
    }

    // Many-to-one related sources only
    for (const rel of relationships) {
      if (rel.type !== 'many-to-one' || rel.sourceId !== widget.sourceId) {
        continue;
      }
      if (!reachableIds.has(rel.targetId)) {
        continue;
      }
      const relatedSource = dataSources[rel.targetId];
      if (!relatedSource || relatedSource.hidden) {
        continue;
      }
      for (const f of relatedSource.fields) {
        if (f.hidden) {
          continue;
        }
        fields.push({
          fieldId: f.id,
          label: f.label,
          type: f.type,
          generated: f.generated,
          sourceId: rel.targetId,
          sourceLabel: relatedSource.label,
          isPrimary: false,
        });
      }
    }
    return fields;
  }, [widget?.sourceId, source, primaryFields, relationships, dataSources]);

  // For cross-filter, group-by, and sort pickers: only primary source fields
  const crossFilterField = widget?.config?.crossFilterField ?? '';
  const summaryFields: Record<string, StudioGridSummaryAggregation> =
    widget?.config?.gridSummaryFields ?? {};
  const groupByField = widget?.config?.gridGroupByField ?? '';
  const groupAggregations: Record<string, StudioGridSummaryAggregation> =
    widget?.config?.gridAggregations ?? {};
  const sortField = widget?.config?.gridSortField ?? '';
  const sortDirection = widget?.config?.gridSortDirection ?? 'asc';

  const availableSources = React.useMemo(
    () => Object.values(dataSources).filter((s) => !s.hidden),
    [dataSources],
  );

  // Menu anchor state: fieldId → anchor element
  const [menuAnchor, setMenuAnchor] = React.useState<{ fieldId: string; el: HTMLElement } | null>(
    null,
  );

  const crossFilterFieldEntries = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!source || !widget?.sourceId) {
      return [];
    }
    return primaryFields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      generated: f.generated,
      sourceId: widget.sourceId!,
      sourceLabel: source.label,
    }));
  }, [primaryFields, source, widget?.sourceId]);

  const handleSourceChange = (_: React.SyntheticEvent, selected: { id: string } | null) => {
    controller.updateWidget(widgetId, { sourceId: selected?.id ?? undefined, config: { columns: [] } });
  };

  const handleColumnToggle = (fieldId: string, sourceId: string) => {
    const isPrimary = sourceId === widget?.sourceId;
    const colKey = isPrimary ? fieldId : `${sourceId}/${fieldId}`;
    const isCurrentlyVisible = configColumns.some(
      (c) => c.fieldId === fieldId && (isPrimary ? !c.sourceId || c.sourceId === sourceId : c.sourceId === sourceId),
    );

    let next: StudioGridColumn[];
    if (isCurrentlyVisible) {
      next = configColumns.filter(
        (c) => !(c.fieldId === fieldId && (isPrimary ? (!c.sourceId || c.sourceId === sourceId) : c.sourceId === sourceId)),
      );
    } else {
      next = [...configColumns, isPrimary ? { fieldId } : { fieldId, sourceId }];
    }
    // Suppress unused variable warning
    void colKey;
    controller.updateWidgetConfig(widgetId, { columns: next });
  };

  const handleSummaryChange = (fieldId: string, value: StudioGridSummaryAggregation | '') => {
    const next = { ...summaryFields };
    if (value === '') {
      delete next[fieldId];
    } else {
      next[fieldId] = value;
    }
    controller.updateWidgetConfig(widgetId, {
      gridSummaryFields: Object.keys(next).length > 0 ? next : undefined,
    });
    setMenuAnchor(null);
  };

  const handleGroupAggChange = (fieldId: string, value: StudioGridSummaryAggregation | '') => {
    const next = { ...groupAggregations };
    if (value === '') {
      delete next[fieldId];
    } else {
      next[fieldId] = value;
    }
    controller.updateWidgetConfig(widgetId, {
      gridAggregations: Object.keys(next).length > 0 ? next : undefined,
    });
    setMenuAnchor(null);
  };

  const openFieldId = menuAnchor?.fieldId ?? null;
  const sourcePickerValue = source ? { id: source.id, label: source.label } : null;

  // Group fields by source for section headers
  const fieldsBySource = React.useMemo(() => {
    const groups = new Map<string, { sourceLabel: string; isPrimary: boolean; fields: SelectableField[] }>();
    for (const f of allSelectableFields) {
      if (!groups.has(f.sourceId)) {
        groups.set(f.sourceId, { sourceLabel: f.sourceLabel, isPrimary: f.isPrimary, fields: [] });
      }
      groups.get(f.sourceId)!.fields.push(f);
    }
    return groups;
  }, [allSelectableFields]);

  const visibleCount = configColumns.length;
  const totalCount = allSelectableFields.length;

  return (
    <Stack spacing={2}>
      {/* Data source selector */}
      <Autocomplete
        size="small"
        options={availableSources.map((s) => ({ id: s.id, label: s.label }))}
        getOptionLabel={(opt) => opt.label}
        isOptionEqualToValue={(opt, val) => opt.id === val.id}
        value={sourcePickerValue}
        onChange={handleSourceChange}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Data source"
            placeholder="Select a data source…"
            helperText={!source ? 'Choose a data source to configure columns' : undefined}
          />
        )}
      />

      {!source && (
        <Alert severity="info">
          Select a data source above to configure this table&apos;s columns and settings.
        </Alert>
      )}

      {source && (
        <React.Fragment>
          {/* Cross-filter field */}
          <DataSourceFieldSelect
            value={crossFilterField}
            onChange={(fieldId) =>
              controller.updateWidgetConfig(widgetId, { crossFilterField: fieldId || undefined })
            }
            fields={crossFilterFieldEntries}
            label="Cross-filter field"
            helperText="Field applied to other widgets when a row is selected; defaults to the first visible column"
          />

          <Divider />

          {/* Group-by field */}
          <DataSourceFieldSelect
            value={groupByField}
            onChange={(fieldId) =>
              controller.updateWidgetConfig(widgetId, {
                gridGroupByField: fieldId || undefined,
                gridAggregations: fieldId ? groupAggregations : undefined,
              })
            }
            fields={crossFilterFieldEntries}
            label="Group by"
            helperText="Collapse rows into groups — set per-column aggregation below"
          />

          {/* Sort field + direction */}
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
            <Box sx={{ flex: 1 }}>
              <DataSourceFieldSelect
                value={sortField}
                onChange={(fieldId) =>
                  controller.updateWidgetConfig(widgetId, {
                    gridSortField: fieldId || undefined,
                    gridSortDirection: fieldId ? sortDirection : undefined,
                  })
                }
                fields={crossFilterFieldEntries}
                label="Default sort"
              />
            </Box>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={sortDirection}
              disabled={!sortField}
              onChange={(_, next) => {
                if (next) {
                  controller.updateWidgetConfig(widgetId, { gridSortDirection: next });
                }
              }}
              sx={{ height: 40, flexShrink: 0 }}
            >
              <ToggleButton value="asc" aria-label="Ascending">
                <Tooltip title="Ascending">
                  <ArrowUpwardIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="desc" aria-label="Descending">
                <Tooltip title="Descending">
                  <ArrowDownwardIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Divider />

          <Typography variant="caption" color="text.secondary">
            Visible columns ({visibleCount}/{totalCount})
            {groupByField ? ' — ⋮ sets group aggregation' : ' — ⋮ sets summary row'}
          </Typography>

          {/* Column list grouped by source */}
          {Array.from(fieldsBySource.entries()).map(([srcId, group]) => (
            <React.Fragment key={srcId}>
              {!group.isPrimary && (
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{ display: 'block', lineHeight: 1.5, mt: 0.5 }}
                >
                  {group.sourceLabel}
                </Typography>
              )}
              {group.fields.map((field) => {
                const isNumeric = field.type === 'number';
                const availableAggs = isNumeric ? NUMERIC_AGGREGATIONS : STRING_AGGREGATIONS;
                const currentAgg = groupByField ? groupAggregations[field.fieldId] : summaryFields[field.fieldId];
                const isVisible = configColumns.some(
                  (c) =>
                    c.fieldId === field.fieldId &&
                    (field.isPrimary ? (!c.sourceId || c.sourceId === field.sourceId) : c.sourceId === field.sourceId),
                );
                const isGroupByField = field.fieldId === groupByField;

                return (
                  <Box
                    key={`${field.sourceId}/${field.fieldId}`}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      p: 1,
                      borderRadius: 1,
                      bgcolor: isVisible ? 'action.selected' : 'transparent',
                      border: 1,
                      borderColor: 'divider',
                    }}
                  >
                    {/* Column visibility toggle */}
                    <Box
                      sx={{ display: 'flex', alignItems: 'center', flex: 1, gap: 0.5, cursor: 'pointer' }}
                      onClick={() => handleColumnToggle(field.fieldId, field.sourceId)}
                      role="checkbox"
                      aria-checked={isVisible}
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === ' ' || event.key === 'Enter') {
                          handleColumnToggle(field.fieldId, field.sourceId);
                        }
                      }}
                    >
                      <FieldTypeIcon type={field.type as any} generated={field.generated} size={14} />
                      <Typography variant="body2">{field.label}</Typography>
                      {isGroupByField && (
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                          (group)
                        </Typography>
                      )}
                    </Box>

                    {/* Summary / group aggregation — ⋮ icon button with dense checkmark menu */}
                    {isVisible && !isGroupByField && (
                      <React.Fragment>
                        <Tooltip title={currentAgg ? `${groupByField ? 'Aggregate' : 'Summary'}: ${AGG_LABELS[currentAgg]}` : groupByField ? 'Set aggregation' : 'Set summary'}>
                          <IconButton
                            size="small"
                            aria-label={`${groupByField ? 'Aggregation' : 'Summary'} for ${field.label}`}
                            aria-haspopup="true"
                            aria-expanded={openFieldId === field.fieldId}
                            onClick={(evt) => setMenuAnchor({ fieldId: field.fieldId, el: evt.currentTarget })}
                            color={currentAgg ? 'primary' : 'default'}
                          >
                            <MoreVertIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Menu
                          open={openFieldId === field.fieldId}
                          anchorEl={menuAnchor?.el}
                          onClose={() => setMenuAnchor(null)}
                          slotProps={{ list: { dense: true } }}
                        >
                          <MenuItem
                            onClick={() =>
                              groupByField
                                ? handleGroupAggChange(field.fieldId, '')
                                : handleSummaryChange(field.fieldId, '')
                            }
                            selected={currentAgg == null}
                          >
                            {currentAgg == null ? (
                              <ListItemIcon>
                                <CheckIcon fontSize="small" />
                              </ListItemIcon>
                            ) : (
                              <ListItemIcon />
                            )}
                            None
                          </MenuItem>
                          {availableAggs.map((agg) => (
                            <MenuItem
                              key={agg}
                              onClick={() =>
                                groupByField
                                  ? handleGroupAggChange(field.fieldId, agg)
                                  : handleSummaryChange(field.fieldId, agg)
                              }
                              selected={currentAgg === agg}
                            >
                              {currentAgg === agg ? (
                                <ListItemIcon>
                                  <CheckIcon fontSize="small" />
                                </ListItemIcon>
                              ) : (
                                <ListItemIcon />
                              )}
                              {AGG_LABELS[agg]}
                            </MenuItem>
                          ))}
                        </Menu>
                      </React.Fragment>
                    )}
                  </Box>
                );
              })}
            </React.Fragment>
          ))}
        </React.Fragment>
      )}

      {source && (
        <React.Fragment>
          {/* Interactions — cross-filter mode */}
          <Divider />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            Interactions
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            When other widgets are clicked, this table…
          </Typography>
          <ToggleButtonGroup
            value={(widget.config?.crossFilterMode ?? 'cross-highlight') as StudioCrossFilterMode}
            exclusive
            onChange={(_e, value: StudioCrossFilterMode | null) => {
              controller.updateWidgetConfig(widgetId, {
                crossFilterMode: value ?? 'cross-highlight',
              });
            }}
            size="small"
            fullWidth
          >
            <ToggleButton value="cross-highlight" sx={{ fontSize: 11, textTransform: 'none' }}>
              Highlight
            </ToggleButton>
            <ToggleButton value="cross-filter" sx={{ fontSize: 11, textTransform: 'none' }}>
              Filter
            </ToggleButton>
            <ToggleButton value="none" sx={{ fontSize: 11, textTransform: 'none' }}>
              None
            </ToggleButton>
          </ToggleButtonGroup>
        </React.Fragment>
      )}
    </Stack>
  );
}

