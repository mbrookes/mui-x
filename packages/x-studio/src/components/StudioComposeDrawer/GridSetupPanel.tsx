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
  Select,
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
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import type {
  StudioConditionalFormat,
  StudioCrossFilterMode,
  StudioGridColumn,
  StudioGridSummaryAggregation,
} from '../../models';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
  useStudioLocaleText,
} from '../../context';
import { getReachableSourceIds } from '../../internals/chartUtils';
import { StudioUIConfigContext, useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { FieldTypeIcon } from '../../internals/FieldTypeIcon';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';
import { SetupSection } from './SetupSection';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';

const NUMERIC_AGGREGATIONS: StudioGridSummaryAggregation[] = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_distinct',
];
const STRING_AGGREGATIONS: StudioGridSummaryAggregation[] = ['count', 'count_distinct'];

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

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- setup panel with many fields is inherently complex and cannot be easily split
export function GridSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const features = useStudioFeatures();
  const allWidgets = useStudioSelector(selectWidgets);
  const widget = allWidgets[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const { tableSourceMode } = React.useContext(StudioUIConfigContext);
  const localeText = useStudioLocaleText();
  const aggLabels: Record<StudioGridSummaryAggregation, string> = {
    sum: localeText.aggFnSum,
    avg: localeText.aggFnAverage,
    count: localeText.aggFnCount,
    count_distinct: localeText.gridSetupColumnAggUnique,
    min: localeText.aggFnMin,
    max: localeText.aggFnMax,
  };
  const cfOperators: { value: StudioConditionalFormat['operator']; label: string }[] = [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'greater_than', label: '>' },
    { value: 'greater_than_or_equal', label: '≥' },
    { value: 'less_than', label: '<' },
    { value: 'less_than_or_equal', label: '≤' },
    { value: 'contains', label: localeText.gridSetupCFContains },
    { value: 'is_empty', label: localeText.gridSetupCFIsEmpty },
    { value: 'is_not_empty', label: localeText.gridSetupCFNotEmpty },
  ];
  const cfStylePresets: { label: string; style: StudioConditionalFormat['style'] }[] = [
    { label: localeText.gridSetupCFStyleRed, style: { backgroundColor: '#ffcdd2', color: '#b71c1c' } },
    { label: localeText.gridSetupCFStyleGreen, style: { backgroundColor: '#c8e6c9', color: '#1b5e20' } },
    { label: localeText.gridSetupCFStyleYellow, style: { backgroundColor: '#fff9c4', color: '#f57f17' } },
    { label: localeText.gridSetupCFStyleBlue, style: { backgroundColor: '#bbdefb', color: '#0d47a1' } },
    { label: localeText.gridSetupCFStyleBold, style: { fontWeight: 'bold' } },
  ];

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
              (f.isPrimary ? !c.sourceId || c.sourceId === f.sourceId : c.sourceId === f.sourceId),
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
  const conditionalFormats: StudioConditionalFormat[] =
    widget?.config?.gridConditionalFormats ?? [];

  const availableSources = React.useMemo(
    () => Object.values(dataSources).filter((s) => !s.hidden),
    [dataSources],
  );

  // ⋮ menu anchor for selected columns (keyed by composite column key)
  const [menuAnchor, setMenuAnchor] = React.useState<{ key: string; el: HTMLElement } | null>(null);
  // "Add column" pill menu anchor
  const [addMenuAnchor, setAddMenuAnchor] = React.useState<HTMLElement | null>(null);
  // Calculated column dialog
  const [calcDialogOpen, setCalcDialogOpen] = React.useState(false);
  // Drag-and-drop column reorder state
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = React.useState<number | null>(null);

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
    controller.updateWidget(widgetId, {
      sourceId: selected?.id ?? undefined,
      config: { columns: [] },
    });
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

  const handleColumnDrop = (dropIndex: number) => {
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const next = [...configColumns];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(dropIndex, 0, moved);
    controller.updateWidgetConfig(widgetId, { columns: next });
    setDragIndex(null);
    setDragOverIndex(null);
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
                label={localeText.gridSetupDataSourceLabel}
                placeholder={localeText.gridSetupDataSourcePlaceholder}
                helperText={!source ? localeText.gridSetupChooseSourceHelper : undefined}
              />
            )}
          />
          {!source && (
          <Alert severity="info">{localeText.gridSetupNoSourceAlert}</Alert>
          )}
        </React.Fragment>
      )}

      {/* Columns section — always shown in implicit mode, gated by source in explicit */}
      {(source || tableSourceMode === 'implicit') && (
        <React.Fragment>
          <Typography variant="caption" color="text.secondary">
            {localeText.gridSetupColumnsTitle}
          </Typography>

          {/* Selected columns list */}
          {configColumns.map((col, index) => {
            const colKey = col.sourceId ? `${col.sourceId}/${col.fieldId}` : col.fieldId;
            const fieldInfo = fieldLookup.get(colKey) ?? fieldLookup.get(col.fieldId);
            const isNumeric = fieldInfo?.type === 'number';
            const availableAggs = isNumeric ? NUMERIC_AGGREGATIONS : STRING_AGGREGATIONS;
            const currentAgg = groupByField
              ? groupAggregations[col.fieldId]
              : summaryFields[col.fieldId];
            const isGroupByField = col.fieldId === groupByField && !col.sourceId;
            const isDraggingOver = dragOverIndex === index && dragIndex !== index;
            let aggregationTooltipTitle = localeText.gridSetupColumnAggSummaryTooltip;
            if (currentAgg) {
              aggregationTooltipTitle = localeText.gridSetupColumnAggLabel(
                Boolean(groupByField),
                aggLabels[currentAgg],
              );
            } else if (groupByField) {
              aggregationTooltipTitle = localeText.gridSetupColumnSetAggTooltip;
            }

            return (
              <Box
                key={colKey}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOverIndex(index);
                }}
                onDrop={() => handleColumnDrop(index)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: isDraggingOver ? 'primary.main' : 'divider',
                  opacity: dragIndex === index ? 0.4 : 1,
                  cursor: 'grab',
                }}
              >
                <DragIndicatorIcon
                  fontSize="small"
                  sx={{ color: 'text.disabled', flexShrink: 0, cursor: 'grab' }}
                />
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
                    {localeText.gridSetupColumnGroupLabel}
                  </Typography>
                )}
                <Tooltip title={aggregationTooltipTitle}>
                  <IconButton
                    size="small"
                    aria-label={localeText.gridSetupColumnOptionsAriaLabel(
                      fieldInfo?.label ?? col.fieldId,
                    )}
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
                    {localeText.gridSetupColumnRemove}
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
                      {localeText.gridSetupColumnAggNone}
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
                        {aggLabels[agg]}
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
            fullWidth
          >
            {localeText.gridSetupAddColumn}
          </Button>
          <Menu
            open={Boolean(addMenuAnchor)}
            anchorEl={addMenuAnchor}
            onClose={() => setAddMenuAnchor(null)}
            slotProps={{ list: { dense: true } }}
          >
            {features.calculatedFields !== false && features.gridCalculatedFields !== false && (
              <MenuItem
                onClick={() => {
                  setCalcDialogOpen(true);
                  setAddMenuAnchor(null);
                }}
              >
                <ListItemIcon>
                  <FunctionsIcon fontSize="small" />
                </ListItemIcon>
                {localeText.gridSetupCalculatedColumn}
              </MenuItem>
            )}
            {features.calculatedFields !== false &&
              features.gridCalculatedFields !== false &&
              addableFields.length > 0 && <Divider />}
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
              <MenuItem disabled>{localeText.gridSetupAllColumnsAdded}</MenuItem>
            )}
          </Menu>

          {source && (
            <React.Fragment>
              <Divider />

              {/* Cross-filter field */}
              <DataSourceFieldSelect
                value={crossFilterField}
                onChange={(fieldId) =>
                  controller.updateWidgetConfig(widgetId, {
                    crossFilterField: fieldId || undefined,
                  })
                }
                fields={crossFilterFieldEntries}
                label={localeText.gridSetupCrossFilterFieldLabel}
                helperText={localeText.gridSetupCrossFilterFieldHelper}
              />

              {/* Group-by field */}
              {features.gridGroupBy !== false && (
                <DataSourceFieldSelect
                  value={groupByField}
                  onChange={(fieldId) =>
                    controller.updateWidgetConfig(widgetId, {
                      gridGroupByField: fieldId || undefined,
                      gridAggregations: fieldId ? groupAggregations : undefined,
                    })
                  }
                  fields={crossFilterFieldEntries}
                  label={localeText.gridSetupGroupByLabel}
                  helperText={localeText.gridSetupGroupByHelper}
                />
              )}

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
                    label={localeText.gridSetupDefaultSortLabel}
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
                  <ToggleButton value="asc" aria-label={localeText.sortAscendingAriaLabel}>
                    <Tooltip title={localeText.sortAscendingAriaLabel}>
                      <ArrowUpwardIcon fontSize="small" />
                    </Tooltip>
                  </ToggleButton>
                  <ToggleButton value="desc" aria-label={localeText.sortDescendingAriaLabel}>
                    <Tooltip title={localeText.sortDescendingAriaLabel}>
                      <ArrowDownwardIcon fontSize="small" />
                    </Tooltip>
                  </ToggleButton>
                </ToggleButtonGroup>
              </Box>
            </React.Fragment>
          )}
        </React.Fragment>
      )}

      {source && features.gridConditionalFormats !== false && (
        <React.Fragment>
          {/* Conditional formatting rules */}
          <SetupSection title={localeText.gridSetupConditionalFormattingTitle}>
            <Stack spacing={1}>
              {conditionalFormats.map((rule, i) => {
                const noValueOp = rule.operator === 'is_empty' || rule.operator === 'is_not_empty';
                const fieldEntry = source.fields.find((f) => f.id === rule.fieldId);
                const preset = cfStylePresets.find(
                  (p) =>
                    p.style.backgroundColor === rule.style.backgroundColor &&
                    p.style.color === rule.style.color &&
                    p.style.fontWeight === rule.style.fontWeight,
                );
                return (
                  // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- conditional format rules have no stable ID
                  <Box
                    key={i}
                    sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <Select
                      size="small"
                      value={rule.fieldId}
                      onChange={(event) => {
                        const next = [...conditionalFormats];
                        next[i] = { ...rule, fieldId: event.target.value };
                        controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                      }}
                      sx={{ fontSize: 12, flex: '1 1 80px', minWidth: 60 }}
                    >
                      {source.fields.map((f) => (
                        <MenuItem key={f.id} value={f.id} dense sx={{ fontSize: 12 }}>
                          {f.label}
                        </MenuItem>
                      ))}
                    </Select>
                    <Select
                      size="small"
                      value={rule.operator}
                      onChange={(event) => {
                        const next = [...conditionalFormats];
                        next[i] = {
                          ...rule,
                          operator: event.target.value as StudioConditionalFormat['operator'],
                        };
                        controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                      }}
                      sx={{ fontSize: 12, flex: '0 0 auto', minWidth: 60 }}
                    >
                      {cfOperators.map((op) => (
                        <MenuItem key={op.value} value={op.value} dense sx={{ fontSize: 12 }}>
                          {op.label}
                        </MenuItem>
                      ))}
                    </Select>
                    {!noValueOp && (
                      <TextField
                        size="small"
                        value={
                          rule.value !== undefined && rule.value !== null ? String(rule.value) : ''
                        }
                        placeholder={fieldEntry?.type === 'number' ? '0' : 'value'}
                        onChange={(event) => {
                          const next = [...conditionalFormats];
                          const v =
                            fieldEntry?.type === 'number'
                              ? Number(event.target.value)
                              : event.target.value;
                          next[i] = { ...rule, value: v };
                          controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                        }}
                        sx={{ flex: '1 1 60px', minWidth: 48, '& input': { fontSize: 12 } }}
                      />
                    )}
                    <Select
                      size="small"
                      value={preset?.label ?? '__custom__'}
                      onChange={(event) => {
                        const selected = cfStylePresets.find(
                          (p) => p.label === event.target.value,
                        );
                        if (selected) {
                          const next = [...conditionalFormats];
                          next[i] = { ...rule, style: selected.style };
                          controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                        }
                      }}
                      sx={{ fontSize: 12, flex: '0 0 auto', minWidth: 64 }}
                    >
                      {cfStylePresets.map((p) => (
                        <MenuItem key={p.label} value={p.label} dense sx={{ fontSize: 12 }}>
                          {p.label}
                        </MenuItem>
                      ))}
                      {!preset && (
                        <MenuItem value="__custom__" dense sx={{ fontSize: 12 }}>
                          {localeText.gridSetupConditionalCustom}
                        </MenuItem>
                      )}
                    </Select>
                    <IconButton
                      size="small"
                      aria-label={localeText.gridSetupRemoveRuleAriaLabel}
                      onClick={() => {
                        const next = conditionalFormats.filter((_, j) => j !== i);
                        controller.updateWidgetConfig(widgetId, {
                          gridConditionalFormats: next.length > 0 ? next : undefined,
                        });
                      }}
                    >
                      <DeleteIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Box>
                );
              })}
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => {
                  const firstField = source.fields[0];
                  if (!firstField) {
                    return;
                  }
                  const next: StudioConditionalFormat[] = [
                    ...conditionalFormats,
                    {
                      fieldId: firstField.id,
                      operator: 'greater_than',
                      value: 0,
                      style: cfStylePresets[0].style,
                    },
                  ];
                  controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                }}
                sx={{ alignSelf: 'flex-start', fontSize: 12 }}
              >
                {localeText.gridSetupAddRule}
              </Button>
            </Stack>
          </SetupSection>
        </React.Fragment>
      )}

      {source && (
        <React.Fragment>
          {/* Interactions — cross-filter mode */}
          <SetupSection
            title={localeText.gridSetupInteractionsTitle}
            description={localeText.gridSetupInteractionsDescription}
            dividerMb={0}
          >
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
                {localeText.crossFilterModeHighlight}
              </ToggleButton>
              <ToggleButton value="cross-filter" sx={{ fontSize: 11, textTransform: 'none' }}>
                {localeText.crossFilterModeFilter}
              </ToggleButton>
              <ToggleButton value="none" sx={{ fontSize: 11, textTransform: 'none' }}>
                {localeText.crossFilterModeNone}
              </ToggleButton>
            </ToggleButtonGroup>
          </SetupSection>
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
