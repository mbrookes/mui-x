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
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import type {
  StudioDataField,
  StudioGridColumn,
  StudioGridSummaryAggregation,
  StudioWidgetConfig,
  StudioWidgetConfigForKind,
} from '../../models';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectRelationships,
  selectExpressionFields,
  selectFilters,
  useStudioLocaleText,
} from '../../context';
import { getReachableSourceIds } from '../../internals/dataSourceGraph';
import {
  buildFieldCatalog,
  buildSourceFieldEntries,
  type FieldCatalogEntry,
} from '../../internals/fieldCatalog';
import { StudioUIConfigContext, useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { FieldTypeIcon } from '../../internals/FieldTypeIcon';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';
import { CrossFilterModeSection } from './CrossFilterModeSection';
import { collectStaleWidgetFilterIds } from './collectStaleWidgetFilterIds';
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

/**
 * Grid config keys that reference specific field IDs from the widget's data
 * source. These are the only keys that should be cleared when the source
 * changes — the old field IDs no longer resolve against the new source, so
 * keeping them around would leave the widget referencing fields that don't
 * exist. Grid-level display settings that are independent of which fields are
 * selected (e.g. `gridSortDirection`, `gridHeight`) are NOT in this list and
 * must survive a source change (finding 3.6).
 */
const FIELD_BOUND_GRID_CONFIG_KEYS = [
  'columns',
  'gridGroupByField',
  'gridAggregations',
  'gridSortField',
  'crossFilterField',
  'gridSummaryFields',
  'gridPkField',
  'gridConditionalFormats',
] as const;

/**
 * Returns `config` with every field-bound grid key removed (`columns` reset
 * to `[]`) so it can safely be applied after the widget's data source changes,
 * while every other (non-field-bound) config key is preserved untouched.
 */
function clearFieldBoundGridConfig(
  config: StudioWidgetConfigForKind<'grid'> | undefined,
): StudioWidgetConfigForKind<'grid'> {
  const next: Record<string, unknown> = { ...config };
  for (const key of FIELD_BOUND_GRID_CONFIG_KEYS) {
    delete next[key];
  }
  next.columns = [];
  return next as StudioWidgetConfigForKind<'grid'>;
}

/**
 * Composite key identifying a configured column for its per-column aggregation
 * (summary/group) menu entry: bare `fieldId` for a primary-source column,
 * `sourceId/fieldId` for a cross-source one. Matches the exact same convention the
 * column list below already uses for React keys / menu-anchor identity (`colKey`).
 *
 * `gridSummaryFields`/`gridAggregations` used to be keyed by bare `fieldId` alone, so
 * a related-source column whose field id happens to match a primary column's (e.g.
 * both have an `id` or `name` field) shared the exact same map entry — configuring
 * one column's aggregation silently overwrote the other's (architecture review:
 * per-column aggregation collision).
 */
function columnAggKey(col: Pick<StudioGridColumn, 'fieldId' | 'sourceId'>): string {
  return col.sourceId ? `${col.sourceId}/${col.fieldId}` : col.fieldId;
}

/** A selectable field entry with its source context */
interface SelectableField {
  fieldId: string;
  label: string;
  type: StudioDataField['type'];
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
  const allFilters = useStudioSelector(selectFilters);
  const { tableSourceMode } = React.use(StudioUIConfigContext);
  const localeText = useStudioLocaleText();
  const aggLabels: Record<StudioGridSummaryAggregation, string> = {
    sum: localeText.aggFnSum,
    avg: localeText.aggFnAverage,
    count: localeText.aggFnCount,
    count_distinct: localeText.gridSetupColumnAggUnique,
    min: localeText.aggFnMin,
    max: localeText.aggFnMax,
  };
  // `widget.sourceId` is doc-authored: guard the record index against inherited prototype keys
  // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
  // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
  const source =
    widget?.sourceId && Object.hasOwn(dataSources, widget.sourceId)
      ? dataSources[widget.sourceId]
      : undefined;
  // `widget` comes from a broad selector, so its `config` is the cross-kind union.
  // Narrow to the grid config shape for reading grid-specific keys.
  const config = (widget?.config ?? {}) as StudioWidgetConfigForKind<'grid'>;

  // configColumns: the current StudioGridColumn[] from widget config, or default all-primary-fields
  const primaryFields = React.useMemo(
    () => (source?.fields ?? []).filter((f) => !f.hidden),
    [source],
  );
  const configColumns: StudioGridColumn[] = React.useMemo(() => {
    if (config.columns?.length) {
      return config.columns;
    }
    return primaryFields.map((f) => ({ fieldId: f.id }));
  }, [config.columns, primaryFields]);

  // All selectable fields: primary source + many-to-one reachable related sources +
  // calculated columns (non-measure expression fields).
  // In implicit mode with no source yet: all fields from all non-hidden sources.
  const allSelectableFields = React.useMemo<SelectableField[]>(() => {
    const toSelectable = (entry: FieldCatalogEntry, isPrimary: boolean): SelectableField => ({
      fieldId: entry.id,
      label: entry.label,
      type: entry.type,
      generated: entry.generated,
      sourceId: entry.sourceId,
      sourceLabel: entry.sourceLabel,
      isPrimary,
    });

    // Implicit mode, no source chosen yet — show every source's fields
    if (tableSourceMode === 'implicit' && !widget?.sourceId) {
      const fields: SelectableField[] = [];
      for (const ds of Object.values(dataSources)) {
        if (ds.hidden) {
          continue;
        }
        fields.push(
          ...buildSourceFieldEntries(ds, expressionFields, { expression: 'non-measure' }).map(
            (entry) => toSelectable(entry, true),
          ),
        );
      }
      return fields;
    }

    if (!widget?.sourceId || !source) {
      return [];
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    const fields: SelectableField[] = [];

    // Primary source first (physical fields + calculated columns)
    fields.push(
      ...buildSourceFieldEntries(source, expressionFields, { expression: 'non-measure' }).map(
        (entry) => toSelectable(entry, true),
      ),
    );

    // Many-to-one related sources only
    for (const rel of relationships) {
      if (rel.type !== 'many-to-one' || rel.sourceId !== widget.sourceId) {
        continue;
      }
      if (!reachableIds.has(rel.targetId)) {
        continue;
      }
      // `rel.targetId` is doc-authored: guard the record index against inherited prototype keys
      // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
      // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
      const relatedSource = Object.hasOwn(dataSources, rel.targetId)
        ? dataSources[rel.targetId]
        : undefined;
      if (!relatedSource || relatedSource.hidden) {
        continue;
      }
      fields.push(
        ...buildSourceFieldEntries(relatedSource, expressionFields, {
          expression: 'non-measure',
        }).map((entry) => toSelectable(entry, false)),
      );
    }
    return fields;
  }, [tableSourceMode, widget?.sourceId, source, relationships, dataSources, expressionFields]);

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
  const crossFilterField = config.crossFilterField ?? '';
  const summaryFields: Record<string, StudioGridSummaryAggregation> =
    config.gridSummaryFields ?? {};
  const groupByField = config.gridGroupByField ?? '';
  const groupAggregations: Record<string, StudioGridSummaryAggregation> =
    config.gridAggregations ?? {};
  const sortField = config.gridSortField ?? '';
  const sortDirection = config.gridSortDirection ?? 'asc';

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

  // Full cross-source field catalog, used to detect widget-scoped filters that no longer
  // resolve after a source switch (finding 1.5).
  const fieldCatalog = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields),
    [dataSources, expressionFields],
  );

  // Widget-scoped filters (created via `WidgetFiltersPanel`) reference their own field
  // ids, which no longer resolve once the grid points at a different source — a stale
  // filter would then silently exclude every row (finding 1.5), the same rationale
  // `clearFieldBoundGridConfig` applies to field-bound config keys. Fold the removal of
  // those filters into the SAME `updateWidget` commit as the source switch so the whole
  // change is a single undo step.
  const staleFilterIdsForSource = (newSourceId: string | undefined) =>
    collectStaleWidgetFilterIds(allFilters, widgetId, newSourceId, fieldCatalog, relationships);

  const handleSourceChange = (_: React.SyntheticEvent, selected: { id: string } | null) => {
    const nextSourceId = selected?.id ?? undefined;
    // Re-selecting the already-active source is a no-op gesture, not a real source
    // switch — MUI `useAutocomplete`'s single-select equality is reference equality,
    // and both the picker's value and its options are freshly-mapped objects every
    // render, so clicking the currently-selected option still fires `onChange` with a
    // different object reference. Without this guard that "no-op" click wiped every
    // field-bound column/sort/group-by/aggregation/conditional-format setting in one
    // undoable commit (finding 1.13) — mirrors the guard `KpiSetupPanel` already has.
    if (nextSourceId === widget?.sourceId) {
      return;
    }
    controller.updateWidget(
      widgetId,
      {
        sourceId: nextSourceId,
        config: clearFieldBoundGridConfig(config),
      },
      { removeFilterIds: staleFilterIdsForSource(nextSourceId) },
    );
  };

  const handleColumnRemove = (col: StudioGridColumn) => {
    const next = configColumns.filter(
      (c) => !(c.fieldId === col.fieldId && c.sourceId === col.sourceId),
    );
    if (tableSourceMode === 'implicit' && next.length === 0) {
      // Reset source when the last column is removed so the user can switch sources
      controller.updateWidget(
        widgetId,
        {
          sourceId: undefined,
          config: clearFieldBoundGridConfig(config),
        },
        { removeFilterIds: staleFilterIdsForSource(undefined) },
      );
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
      controller.updateWidget(
        widgetId,
        {
          sourceId: field.sourceId,
          config: { ...widget?.config, columns: [newCol] },
        },
        { removeFilterIds: staleFilterIdsForSource(field.sourceId) },
      );
    } else {
      controller.updateWidgetConfig(widgetId, { columns: [...configColumns, newCol] });
    }
    setAddMenuAnchor(null);
  };

  // Keyed by the SAME composite convention as `colKey` below (bare `fieldId` for a
  // primary-source column, `sourceId/fieldId` for a cross-source one) — NOT by bare
  // `fieldId` alone. A related-source column whose field id happens to match a
  // primary column's (e.g. both have an `id` field) used to share the exact same
  // `gridSummaryFields`/`gridAggregations` entry, so configuring one column's
  // per-column aggregation silently overwrote the other's (architecture review:
  // per-column aggregation collision).
  const handleSummaryChange = (col: StudioGridColumn, value: StudioGridSummaryAggregation | '') => {
    const key = columnAggKey(col);
    const next = { ...summaryFields };
    if (value === '') {
      delete next[key];
    } else {
      next[key] = value;
    }
    controller.updateWidgetConfig(widgetId, {
      gridSummaryFields: Object.keys(next).length > 0 ? next : undefined,
    });
    setMenuAnchor(null);
  };

  const handleGroupAggChange = (
    col: StudioGridColumn,
    value: StudioGridSummaryAggregation | '',
  ) => {
    const key = columnAggKey(col);
    const next = { ...groupAggregations };
    if (value === '') {
      delete next[key];
    } else {
      next[key] = value;
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

  // Keyboard-accessible alternative to drag reorder (drag-and-drop is mouse-only).
  const moveColumn = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= configColumns.length) {
      return;
    }
    const next = [...configColumns];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    controller.updateWidgetConfig(widgetId, { columns: next });
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
                slotProps={{
                  ...params.slotProps,
                  htmlInput: {
                    ...params.slotProps.htmlInput,
                    title: sourcePickerValue?.label,
                  },
                }}
              />
            )}
          />
          {!source && <Alert severity="info">{localeText.gridSetupNoSourceAlert}</Alert>}
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
            const colKey = columnAggKey(col);
            const fieldInfo = fieldLookup.get(colKey) ?? fieldLookup.get(col.fieldId);
            const isNumeric = fieldInfo?.type === 'number';
            const availableAggs = isNumeric ? NUMERIC_AGGREGATIONS : STRING_AGGREGATIONS;
            const currentAgg = groupByField ? groupAggregations[colKey] : summaryFields[colKey];
            const isGroupByField = col.fieldId === groupByField && !col.sourceId;
            const isDraggingOver = dragOverIndex === index && dragIndex !== index;
            let aggregationTooltipTitle = localeText.gridSetupColumnAggSummaryTooltip;
            if (currentAgg) {
              aggregationTooltipTitle = localeText.gridSetupColumnAggLabel(
                Boolean(groupByField),
                // `currentAgg` is doc-authored (`gridAggregations`/`gridSummaryFields`): guard
                // against inherited `Object.prototype` keys ("toString"/"constructor"/…) so a
                // bare bracket lookup can't resolve a function off the prototype chain instead
                // of falling through to the raw aggregation string.
                Object.hasOwn(aggLabels, currentAgg) ? aggLabels[currentAgg] : currentAgg,
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
                  type={fieldInfo?.type ?? 'string'}
                  generated={fieldInfo?.generated}
                  size={14}
                />
                <Typography
                  variant="body2"
                  sx={{ flex: 1, minWidth: 0 }}
                  noWrap
                  title={fieldInfo?.label ?? col.fieldId}
                >
                  {fieldInfo?.label ?? col.fieldId}
                </Typography>
                {col.sourceId && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    sx={{ minWidth: 0 }}
                    title={fieldInfo?.sourceLabel ?? ''}
                  >
                    {fieldInfo?.sourceLabel}
                  </Typography>
                )}
                {isGroupByField && (
                  <Typography variant="caption" color="text.secondary">
                    {localeText.gridSetupColumnGroupLabel}
                  </Typography>
                )}
                <IconButton
                  size="small"
                  aria-label={localeText.gridColumnMoveUpAriaLabel}
                  disabled={index === 0}
                  onClick={() => moveColumn(index, index - 1)}
                  sx={{ p: 0.25 }}
                >
                  <KeyboardArrowUpIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={localeText.gridColumnMoveDownAriaLabel}
                  disabled={index === configColumns.length - 1}
                  onClick={() => moveColumn(index, index + 1)}
                  sx={{ p: 0.25 }}
                >
                  <KeyboardArrowDownIcon fontSize="small" />
                </IconButton>
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
                        groupByField ? handleGroupAggChange(col, '') : handleSummaryChange(col, '')
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
                            ? handleGroupAggChange(col, agg)
                            : handleSummaryChange(col, agg)
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
                        {
                          // `agg` is drawn from the fixed `NUMERIC_AGGREGATIONS`/
                          // `STRING_AGGREGATIONS` arrays (always a valid `aggLabels` key), but
                          // guarded the same way as the doc-authored `currentAgg` lookup above
                          // for consistency and defense-in-depth against the same bug class.
                          Object.hasOwn(aggLabels, agg) ? aggLabels[agg] : agg
                        }
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
                      <FieldTypeIcon type={field.type} generated={field.generated} size={14} />
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

      {/* Conditional formatting now lives in the Format tab (see GridConditionalFormatSection). */}

      {source && (
        <React.Fragment>
          {/* Interactions — cross-filter mode */}
          <CrossFilterModeSection
            widgetId={widgetId}
            title={localeText.gridSetupInteractionsTitle}
            description={localeText.gridSetupInteractionsDescription}
            dividerMb={0}
            modes={['cross-highlight', 'cross-filter', 'none']}
            defaultMode="cross-highlight"
            // `crossFilterMode` is a cross-kind key, read via the flat cross-kind config type.
            value={(config as StudioWidgetConfig).crossFilterMode}
          />
        </React.Fragment>
      )}

      {/* Calculated column dialog */}
      {source && widget?.sourceId && (
        <StudioExpressionFieldDialog
          key={calcDialogOpen ? 'open' : 'closed'}
          open={calcDialogOpen}
          onClose={() => setCalcDialogOpen(false)}
          dataSource={source}
          expressionFields={expressionFields}
          // BL-180: scope operand fields to sources reachable from this grid's source.
          reachableSourceIds={getReachableSourceIds(widget.sourceId, relationships)}
        />
      )}
    </Stack>
  );
}
