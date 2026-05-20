'use client';
import * as React from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListSubheader,
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
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import FunctionsIcon from '@mui/icons-material/Functions';
import type { StudioCrossFilterMode, StudioGridColumn, StudioGridSummaryAggregation } from '../models';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
} from '../context';
import { getReachableSourceIds } from '../internals/chartUtils';
import { StudioUIConfigContext } from '../internals/StudioUIConfigContext';
import { FieldTypeIcon } from '../internals/FieldTypeIcon';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';

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
  const expressionFields = useStudioSelector(selectExpressionFields);
  const { tableSourceMode } = React.useContext(StudioUIConfigContext);

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

  // All selectable fields: primary source + many-to-one reachable related sources +
  // calculated columns (non-measure expression fields).
  // In implicit mode with no source yet: all fields from all non-hidden sources.
  const allSelectableFields = React.useMemo<SelectableField[]>(() => {
    // Implicit mode, no source chosen yet — show every source's fields
    if (tableSourceMode === 'implicit' && !widget?.sourceId) {
      const fields: SelectableField[] = [];
      for (const ds of Object.values(dataSources)) {
        if (ds.hidden) {
          continue;
        }
        for (const f of ds.fields) {
          if (f.hidden) {
            continue;
          }
          fields.push({
            fieldId: f.id,
            label: f.label,
            type: f.type,
            generated: f.generated,
            sourceId: ds.id,
            sourceLabel: ds.label,
            isPrimary: true,
          });
        }
        // Calculated columns for this source
        for (const ef of expressionFields) {
          if (ef.sourceId !== ds.id || ef.isMeasure || ef.hidden) {
            continue;
          }
          fields.push({
            fieldId: ef.id,
            label: ef.label,
            type: ef.type ?? 'number',
            generated: true,
            sourceId: ds.id,
            sourceLabel: ds.label,
            isPrimary: true,
          });
        }
      }
      return fields;
    }

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
    // Calculated columns for the primary source
    for (const ef of expressionFields) {
      if (ef.sourceId !== widget.sourceId || ef.isMeasure || ef.hidden) {
        continue;
      }
      fields.push({
        fieldId: ef.id,
        label: ef.label,
        type: ef.type ?? 'number',
        generated: true,
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
      // Calculated columns for related sources
      for (const ef of expressionFields) {
        if (ef.sourceId !== rel.targetId || ef.isMeasure || ef.hidden) {
          continue;
        }
        fields.push({
          fieldId: ef.id,
          label: ef.label,
          type: ef.type ?? 'number',
          generated: true,
          sourceId: rel.targetId,
          sourceLabel: relatedSource.label,
          isPrimary: false,
        });
      }
    }
    return fields;
  }, [
    tableSourceMode,
    widget?.sourceId,
    source,
    primaryFields,
    relationships,
    dataSources,
    expressionFields,
  ]);

  // Lookup map: composite key → SelectableField
  const fieldLookup = React.useMemo(() => {
    const map = new Map<string, SelectableField>();
    for (const f of allSelectableFields) {
      map.set(f.isPrimary ? f.fieldId : `${f.sourceId}/${f.fieldId}`, f);
    }
    return map;
  }, [allSelectableFields]);

  // Fields not yet added — for the "Add column" menu
  const addableFields = React.useMemo(
    () =>
      allSelectableFields.filter(
        (f) =>
          !configColumns.some(
            (c) =>
              c.fieldId === f.fieldId &&
              (f.isPrimary
                ? !c.sourceId || c.sourceId === f.sourceId
                : c.sourceId === f.sourceId),
          ),
      ),
    [allSelectableFields, configColumns],
  );

  const addableFieldsBySource = React.useMemo(() => {
    const groups = new Map<
      string,
      { sourceLabel: string; isPrimary: boolean; fields: SelectableField[] }
    >();
    for (const f of addableFields) {
      if (!groups.has(f.sourceId)) {
        groups.set(f.sourceId, { sourceLabel: f.sourceLabel, isPrimary: f.isPrimary, fields: [] });
      }
      groups.get(f.sourceId)!.fields.push(f);
    }
    return groups;
  }, [addableFields]);

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

  // ⋮ menu anchor for selected columns (keyed by composite column key)
  const [menuAnchor, setMenuAnchor] = React.useState<{ key: string; el: HTMLElement } | null>(
    null,
  );
  // "Add column" pill menu anchor
  const [addMenuAnchor, setAddMenuAnchor] = React.useState<HTMLElement | null>(null);
  // Calculated column dialog
  const [calcDialogOpen, setCalcDialogOpen] = React.useState(false);

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

  const handleColumnRemove = (col: StudioGridColumn) => {
    const next = configColumns.filter(
      (c) => !(c.fieldId === col.fieldId && c.sourceId === col.sourceId),
    );
    if (tableSourceMode === 'implicit' && next.length === 0) {
      // Reset source when the last column is removed so the user can switch sources
      controller.updateWidget(widgetId, { sourceId: undefined, config: { columns: [] } });
    } else {
      controller.updateWidgetConfig(widgetId, { columns: next });
    }
    setMenuAnchor(null);
  };

  const handleColumnAdd = (field: SelectableField) => {
    const newCol: StudioGridColumn = field.isPrimary
      ? { fieldId: field.fieldId }
      : { fieldId: field.fieldId, sourceId: field.sourceId };
    if (tableSourceMode === 'implicit' && !widget?.sourceId) {
      // Infer source from the first column added
      controller.updateWidget(widgetId, {
        sourceId: field.sourceId,
        config: { ...widget?.config, columns: [newCol] },
      });
    } else {
      controller.updateWidgetConfig(widgetId, { columns: [...configColumns, newCol] });
    }
    setAddMenuAnchor(null);
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

  const sourcePickerValue = source ? { id: source.id, label: source.label } : null;

  return (
    <Stack spacing={2}>
      {/* Data source selector — hidden in implicit mode (source is inferred from columns) */}
      {tableSourceMode === 'explicit' && (
        <React.Fragment>
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
        </React.Fragment>
      )}

      {/* Columns section — always shown in implicit mode, gated by source in explicit */}
      {(source || tableSourceMode === 'implicit') && (
        <React.Fragment>
          <Typography variant="caption" color="text.secondary">Columns</Typography>

          {/* Selected columns list */}
          {configColumns.map((col) => {
            const colKey = col.sourceId ? `${col.sourceId}/${col.fieldId}` : col.fieldId;
            const fieldInfo = fieldLookup.get(colKey) ?? fieldLookup.get(col.fieldId);
            const isNumeric = fieldInfo?.type === 'number';
            const availableAggs = isNumeric ? NUMERIC_AGGREGATIONS : STRING_AGGREGATIONS;
            const currentAgg = groupByField
              ? groupAggregations[col.fieldId]
              : summaryFields[col.fieldId];
            const isGroupByField = col.fieldId === groupByField && !col.sourceId;

            return (
              <Box
                key={colKey}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                }}
              >
                <FieldTypeIcon
                  type={(fieldInfo?.type ?? 'string') as any}
                  generated={fieldInfo?.generated}
                  size={14}
                />
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                  {fieldInfo?.label ?? col.fieldId}
                </Typography>
                {col.sourceId && (
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {fieldInfo?.sourceLabel}
                  </Typography>
                )}
                {isGroupByField && (
                  <Typography variant="caption" color="text.secondary">
                    (group)
                  </Typography>
                )}
                <Tooltip
                  title={
                    currentAgg
                      ? `${groupByField ? 'Aggregate' : 'Summary'}: ${AGG_LABELS[currentAgg]}`
                      : groupByField
                        ? 'Set aggregation'
                        : 'Set summary / remove'
                  }
                >
                  <IconButton
                    size="small"
                    aria-label={`Options for ${fieldInfo?.label ?? col.fieldId}`}
                    aria-haspopup="true"
                    aria-expanded={menuAnchor?.key === colKey}
                    onClick={(evt) => setMenuAnchor({ key: colKey, el: evt.currentTarget })}
                    color={currentAgg ? 'primary' : 'default'}
                  >
                    <MoreVertIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Menu
                  open={menuAnchor?.key === colKey}
                  anchorEl={menuAnchor?.el}
                  onClose={() => setMenuAnchor(null)}
                  slotProps={{ list: { dense: true } }}
                >
                  <MenuItem onClick={() => handleColumnRemove(col)}>
                    <ListItemIcon>
                      <DeleteIcon fontSize="small" />
                    </ListItemIcon>
                    Remove
                  </MenuItem>
                  {!isGroupByField && <Divider />}
                  {!isGroupByField && (
                    <MenuItem
                      onClick={() =>
                        groupByField
                          ? handleGroupAggChange(col.fieldId, '')
                          : handleSummaryChange(col.fieldId, '')
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
                  )}
                  {!isGroupByField &&
                    availableAggs.map((agg) => (
                      <MenuItem
                        key={agg}
                        onClick={() =>
                          groupByField
                            ? handleGroupAggChange(col.fieldId, agg)
                            : handleSummaryChange(col.fieldId, agg)
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
              </Box>
            );
          })}

          {/* Add column pill */}
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddIcon />}
            onClick={(evt) => setAddMenuAnchor(evt.currentTarget)}
            sx={{ alignSelf: 'flex-start' }}
          >
            Add column
          </Button>
          <Menu
            open={Boolean(addMenuAnchor)}
            anchorEl={addMenuAnchor}
            onClose={() => setAddMenuAnchor(null)}
            slotProps={{ list: { dense: true } }}
          >
            <MenuItem
              onClick={() => {
                setCalcDialogOpen(true);
                setAddMenuAnchor(null);
              }}
            >
              <ListItemIcon>
                <FunctionsIcon fontSize="small" />
              </ListItemIcon>
              Calculated column…
            </MenuItem>
            {addableFields.length > 0 && <Divider />}
            {Array.from(addableFieldsBySource.entries()).map(([srcId, group]) => (
              <React.Fragment key={srcId}>
                {addableFieldsBySource.size > 1 && (
                  <ListSubheader sx={{ lineHeight: '32px' }}>{group.sourceLabel}</ListSubheader>
                )}
                {group.fields.map((field) => (
                  <MenuItem
                    key={`${field.sourceId}/${field.fieldId}`}
                    onClick={() => handleColumnAdd(field)}
                  >
                    <ListItemIcon>
                      <FieldTypeIcon
                        type={field.type as any}
                        generated={field.generated}
                        size={14}
                      />
                    </ListItemIcon>
                    {field.label}
                  </MenuItem>
                ))}
              </React.Fragment>
            ))}
            {addableFields.length === 0 && (
              <MenuItem disabled>All available columns added</MenuItem>
            )}
          </Menu>

          {source && (
            <React.Fragment>
              <Divider />

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
            </React.Fragment>
          )}
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

      {/* Calculated column dialog */}
      {source && (
        <StudioExpressionFieldDialog
          key={calcDialogOpen ? 'open' : 'closed'}
          open={calcDialogOpen}
          onClose={() => setCalcDialogOpen(false)}
          dataSource={source}
          expressionFields={expressionFields}
        />
      )}
    </Stack>
  );
}
