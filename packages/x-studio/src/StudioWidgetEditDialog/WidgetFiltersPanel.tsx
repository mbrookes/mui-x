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
import {
  selectDataSources,
  selectFilters,
  selectRelationships,
  selectWidgets,
  useStudioSelector,
} from '../context';

interface FieldOption {
  id: string;
  label: string;
  type: StudioDataField['type'];
  /** The source that owns this field. Undefined means the widget's own source. */
  sourceId?: string;
  sourceLabel?: string;
}

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
  field: FieldOption | undefined,
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
  fieldOptions: FieldOption[];
  onRemove: () => void;
  onUpdate: (patch: Partial<StudioFilterState>) => void;
}) {
  const { filter, fieldOptions, onRemove, onUpdate } = props;
  const fieldMeta = fieldOptions.find(
    (f) => f.id === filter.field && (f.sourceId ?? null) === (filter.filterSourceId ?? null),
  );
  const operators = operatorsForField(fieldMeta);
  const noValue = NO_VALUE_OPERATORS.has(filter.operator);

  // Encode field selection as "sourceId::fieldId" when cross-source to keep Select value unique
  const encodeValue = (f: FieldOption) => (f.sourceId ? `${f.sourceId}::${f.id}` : f.id);
  const currentValue = filter.filterSourceId
    ? `${filter.filterSourceId}::${filter.field}`
    : filter.field;

  // Group field options by source label
  const ownFields = fieldOptions.filter((f) => !f.sourceId);
  const relatedSources = Array.from(new Set(fieldOptions.filter((f) => f.sourceId).map((f) => f.sourceId)));

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      {/* Field selector */}
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select
          value={currentValue}
          onChange={(evt) => {
            const raw = evt.target.value as string;
            const sep = raw.indexOf('::');
            if (sep !== -1) {
              const srcId = raw.slice(0, sep);
              const fId = raw.slice(sep + 2);
              const meta = fieldOptions.find((f) => f.sourceId === srcId && f.id === fId);
              onUpdate({ field: fId, filterSourceId: srcId, fieldType: meta?.type });
            } else {
              const meta = fieldOptions.find((f) => !f.sourceId && f.id === raw);
              onUpdate({ field: raw, filterSourceId: undefined, fieldType: meta?.type });
            }
          }}
          displayEmpty
          renderValue={(v) => {
            const sep = (v as string).indexOf('::');
            const fId = sep !== -1 ? (v as string).slice(sep + 2) : (v as string);
            const srcId = sep !== -1 ? (v as string).slice(0, sep) : undefined;
            const opt = fieldOptions.find(
              (f) => f.id === fId && (f.sourceId ?? null) === (srcId ?? null),
            );
            if (!opt) {
              return fId;
            }
            return opt.sourceId ? `${opt.sourceLabel}: ${opt.label}` : opt.label;
          }}
        >
          {ownFields.map((f) => (
            <MenuItem key={f.id} value={encodeValue(f)}>
              {f.label}
            </MenuItem>
          ))}
          {relatedSources.map((srcId) => {
            const srcFields = fieldOptions.filter((f) => f.sourceId === srcId);
            const srcLabel = srcFields[0]?.sourceLabel ?? srcId;
            return [
              <MenuItem key={`__group-${srcId}`} disabled sx={{ fontStyle: 'italic', opacity: 0.6 }}>
                {srcLabel}
              </MenuItem>,
              ...srcFields.map((f) => (
                <MenuItem key={encodeValue(f)} value={encodeValue(f)} sx={{ pl: 3 }}>
                  {f.label}
                </MenuItem>
              )),
            ];
          })}
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
        });
      }
    }
    return options;
  }, [dataSources, ownFields, relationships, sourceId]);

  const widgetFilters = React.useMemo(
    () => allFilters.filter((f) => f.scope === 'widget' && f.widgetId === widgetId),
    [allFilters, widgetId],
  );

  const handleAdd = React.useCallback(() => {
    const firstField = ownFields[0];
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
  }, [controller, ownFields, widgetId]);

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
              fieldOptions={fieldOptions}
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
        disabled={ownFields.length === 0}
        sx={{ alignSelf: 'flex-start' }}
      >
        Add filter
      </Button>
    </Stack>
  );
}
