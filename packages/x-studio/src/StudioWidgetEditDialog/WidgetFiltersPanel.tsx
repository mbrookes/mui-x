'use client';
import * as React from 'react';
import {
  Box,
  Button,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import type { StudioDataField, StudioFilterOperator, StudioFilterState } from '../models';
import { useStudioController } from '../context/StudioContext';
import { selectDataSources, selectFilters, selectWidgets, useStudioSelector } from '../context';

// ── Operator metadata ─────────────────────────────────────────────────────────

const STRING_OPERATORS: { value: StudioFilterOperator; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'does_not_contain', label: "doesn't contain" },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const NUMBER_OPERATORS: { value: StudioFilterOperator; label: string }[] = [
  { value: 'equals', label: '=' },
  { value: 'not_equals', label: '≠' },
  { value: 'greater_than', label: '>' },
  { value: 'greater_than_or_equal', label: '≥' },
  { value: 'less_than', label: '<' },
  { value: 'less_than_or_equal', label: '≤' },
  { value: 'between', label: 'between' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const DATE_OPERATORS = NUMBER_OPERATORS;

const BOOLEAN_OPERATORS: { value: StudioFilterOperator; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
];

function operatorsForField(
  field: StudioDataField | undefined,
): { value: StudioFilterOperator; label: string }[] {
  if (!field) {
    return STRING_OPERATORS;
  }
  if (field.type === 'number') {
    return NUMBER_OPERATORS;
  }
  if (field.type === 'date' || field.type === 'datetime') {
    return DATE_OPERATORS;
  }
  if (field.type === 'boolean') {
    return BOOLEAN_OPERATORS;
  }
  return STRING_OPERATORS;
}

const NO_VALUE_OPERATORS = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

// ── Filter row ────────────────────────────────────────────────────────────────

function FilterRow(props: {
  filter: StudioFilterState;
  fields: StudioDataField[];
  onRemove: () => void;
  onUpdate: (patch: Partial<StudioFilterState>) => void;
}) {
  const { filter, fields, onRemove, onUpdate } = props;
  const fieldMeta = fields.find((f) => f.id === filter.field);
  const operators = operatorsForField(fieldMeta);
  const noValue = NO_VALUE_OPERATORS.has(filter.operator);

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      {/* Field selector */}
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select
          value={filter.field}
          onChange={(evt) => onUpdate({ field: evt.target.value as string })}
          displayEmpty
          renderValue={(v) => fields.find((f) => f.id === v)?.label ?? v}
        >
          {fields.map((f) => (
            <MenuItem key={f.id} value={f.id}>
              {f.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Operator selector */}
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select
          value={filter.operator}
          onChange={(evt) => onUpdate({ operator: evt.target.value as StudioFilterOperator })}
        >
          {operators.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {op.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Value input */}
      {!noValue && (
        <TextField
          size="small"
          placeholder="Value"
          value={filter.value === undefined || filter.value === null ? '' : String(filter.value)}
          onChange={(evt) => onUpdate({ value: evt.target.value })}
          sx={{ flex: 1, minWidth: 80 }}
        />
      )}
      {noValue && <Box sx={{ flex: 1 }} />}

      {/* Remove */}
      <Tooltip title="Remove filter">
        <IconButton size="small" onClick={onRemove} aria-label="Remove filter">
          <DeleteOutlineOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function WidgetFiltersPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const allFilters = useStudioSelector(selectFilters);
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);

  const widget = widgets[widgetId];
  const sourceId = widget?.sourceId;
  const fields: StudioDataField[] = React.useMemo(
    () => (sourceId ? (dataSources[sourceId]?.fields ?? []) : []),
    [dataSources, sourceId],
  );

  const widgetFilters = React.useMemo(
    () => allFilters.filter((f) => f.scope === 'widget' && f.widgetId === widgetId),
    [allFilters, widgetId],
  );

  const handleAdd = React.useCallback(() => {
    const firstField = fields[0];
    if (!firstField) {
      return;
    }
    controller.addFilter({
      id: `wf-${widgetId}-${Date.now()}`,
      scope: 'widget',
      widgetId,
      field: firstField.id,
      fieldType: firstField.type,
      operator: 'equals',
      value: '',
    });
  }, [controller, fields, widgetId]);

  const handleRemove = React.useCallback(
    (filterId: string) => {
      controller.removeFilter(filterId);
    },
    [controller],
  );

  const handleUpdate = React.useCallback(
    (filterId: string, patch: Partial<StudioFilterState>) => {
      const filter = allFilters.find((f) => f.id === filterId);
      if (!filter) {
        return;
      }
      // Remove old and re-add with merged patch
      controller.removeFilter(filterId);
      controller.addFilter({ ...filter, ...patch });
    },
    [controller, allFilters],
  );

  if (!widget || !sourceId) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        This widget has no data source.
      </Typography>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Always-on conditions applied to this widget&apos;s data before any interactive filters.
      </Typography>

      {widgetFilters.length > 0 ? (
        <Stack spacing={1.5}>
          {widgetFilters.map((filter) => (
            <FilterRow
              key={filter.id}
              filter={filter}
              fields={fields}
              onRemove={() => handleRemove(filter.id)}
              onUpdate={(patch) => handleUpdate(filter.id, patch)}
            />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ fontStyle: 'italic' }}>
          No filters, all data is shown.
        </Typography>
      )}

      <Button
        size="small"
        startIcon={<AddIcon />}
        onClick={handleAdd}
        disabled={fields.length === 0}
        sx={{ alignSelf: 'flex-start' }}
      >
        Add filter
      </Button>
    </Stack>
  );
}
