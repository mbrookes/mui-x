'use client';
import * as React from 'react';
import {
  Alert,
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import CheckIcon from '@mui/icons-material/Check';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import type { StudioGridSummaryAggregation } from '../models';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
} from '../context';
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

export function GridSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const allFields = (source?.fields ?? []).filter((f) => !f.hidden);
  const visibleColumns: string[] = (widget?.config?.columns ?? allFields.map((f) => f.id)).filter(
    (id) => allFields.some((f) => f.id === id),
  );
  const crossFilterField = widget?.config?.crossFilterField ?? '';
  const summaryFields: Record<string, StudioGridSummaryAggregation> =
    widget?.config?.gridSummaryFields ?? {};
  const groupByField = widget?.config?.gridGroupByField ?? '';
  const groupAggregations: Record<string, StudioGridSummaryAggregation> =
    widget?.config?.gridAggregations ?? {};
  const sortField = widget?.config?.gridSortField ?? '';
  const sortDirection = widget?.config?.gridSortDirection ?? 'asc';

  // Map allFields to DataSourceFieldEntry for DataSourceFieldSelect
  const crossFilterFieldEntries = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!source || !widget?.sourceId) {
      return [];
    }
    return allFields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      generated: f.generated,
      sourceId: widget.sourceId!,
      sourceLabel: source.label,
    }));
  }, [allFields, source, widget?.sourceId]);

  // Menu anchor state: fieldId → anchor element
  const [menuAnchor, setMenuAnchor] = React.useState<{ fieldId: string; el: HTMLElement } | null>(
    null,
  );

  const handleColumnToggle = (fieldId: string) => {
    const next = visibleColumns.includes(fieldId)
      ? visibleColumns.filter((c) => c !== fieldId)
      : [...visibleColumns, fieldId];
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

  if (!source) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data source bound to this widget.
      </Alert>
    );
  }

  const openFieldId = menuAnchor?.fieldId ?? null;

  return (
    <Stack spacing={2}>
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
        Visible columns ({visibleColumns.length}/{allFields.length})
        {groupByField ? ' — ⋮ sets group aggregation' : ' — ⋮ sets summary row'}
      </Typography>
      {allFields.map((field) => {
        const isNumeric = field.type === 'number';
        const availableAggs = isNumeric ? NUMERIC_AGGREGATIONS : STRING_AGGREGATIONS;
        // In group-by mode the ⋮ menu controls gridAggregations; otherwise gridSummaryFields
        const currentAgg = groupByField ? groupAggregations[field.id] : summaryFields[field.id];
        const isVisible = visibleColumns.includes(field.id);
        const isGroupByField = field.id === groupByField;

        return (
          <Box
            key={field.id}
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
              onClick={() => handleColumnToggle(field.id)}
              role="checkbox"
              aria-checked={isVisible}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  handleColumnToggle(field.id);
                }
              }}
            >
              <FieldTypeIcon type={field.type} generated={field.generated} size={14} />
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
                    aria-expanded={openFieldId === field.id}
                    onClick={(evt) => setMenuAnchor({ fieldId: field.id, el: evt.currentTarget })}
                    color={currentAgg ? 'primary' : 'default'}
                  >
                    <MoreVertIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Menu
                  open={openFieldId === field.id}
                  anchorEl={menuAnchor?.el}
                  onClose={() => setMenuAnchor(null)}
                  slotProps={{ list: { dense: true } }}
                >
                  <MenuItem
                    onClick={() =>
                      groupByField
                        ? handleGroupAggChange(field.id, '')
                        : handleSummaryChange(field.id, '')
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
                          ? handleGroupAggChange(field.id, agg)
                          : handleSummaryChange(field.id, agg)
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
    </Stack>
  );
}
