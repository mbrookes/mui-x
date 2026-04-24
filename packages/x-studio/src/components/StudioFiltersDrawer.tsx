import * as React from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioDataField, StudioDataSource, StudioFilterOperator, StudioFilterState } from '../models';

type FieldType = StudioDataField['type'];

const OPERATORS_BY_TYPE: Record<FieldType, { value: StudioFilterOperator; label: string }[]> = {
  string: [
    { value: 'equals', label: 'Equals' },
    { value: 'not_equals', label: 'Not equals' },
    { value: 'contains', label: 'Contains' },
  ],
  number: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'greater_than', label: '>' },
    { value: 'less_than', label: '<' },
    { value: 'greater_than_or_equal', label: '≥' },
    { value: 'less_than_or_equal', label: '≤' },
  ],
  date: [
    { value: 'equals', label: 'On' },
    { value: 'not_equals', label: 'Not on' },
    { value: 'between', label: 'Between' },
    { value: 'greater_than', label: 'After' },
    { value: 'less_than', label: 'Before' },
    { value: 'greater_than_or_equal', label: 'On or after' },
    { value: 'less_than_or_equal', label: 'On or before' },
  ],
  datetime: [
    { value: 'equals', label: 'At' },
    { value: 'not_equals', label: 'Not at' },
    { value: 'between', label: 'Between' },
    { value: 'greater_than', label: 'After' },
    { value: 'less_than', label: 'Before' },
    { value: 'greater_than_or_equal', label: 'At or after' },
    { value: 'less_than_or_equal', label: 'At or before' },
  ],
  boolean: [
    { value: 'equals', label: 'Is' },
    { value: 'not_equals', label: 'Is not' },
  ],
};

function getOperators(fieldType: FieldType | undefined) {
  return OPERATORS_BY_TYPE[fieldType ?? 'string'] ?? OPERATORS_BY_TYPE.string;
}

function generateId() {
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type FieldOption = {
  id: string;
  label: string;
  fieldType: FieldType;
  sourceId: string;
  sourceLabel: string;
};

/** Build a flat list of field options across all sources, annotated with source and type info. */
function buildFieldOptions(dataSources: Record<string, StudioDataSource>): FieldOption[] {
  return Object.values(dataSources as Record<string, StudioDataSource>).flatMap((ds) =>
    ds.fields
      .filter((f) => !f.hidden)
      .map((f) => ({ id: f.id, label: f.label, fieldType: f.type, sourceId: ds.id, sourceLabel: ds.label })),
  );
}

type DateRange = { from: string; to: string };

function toDateRange(value: unknown): DateRange {
  if (value && typeof value === 'object' && ('from' in value || 'to' in value)) {
    return { from: String((value as any).from ?? ''), to: String((value as any).to ?? '') };
  }
  return { from: '', to: '' };
}

/** Date range picker: two MUI date inputs (From → To). */
function DateRangeInput(props: {
  inputType: 'date' | 'datetime-local';
  value: unknown;
  onChange: (v: DateRange) => void;
}) {
  const { inputType, value, onChange } = props;
  const range = toDateRange(value);

  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexGrow: 1, minWidth: 0 }}>
      <TextField
        size="small"
        type={inputType}
        label="From"
        value={range.from}
        onChange={(e) => onChange({ ...range, from: e.target.value })}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ minWidth: 130, flexGrow: 1 }}
      />
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        —
      </Typography>
      <TextField
        size="small"
        type={inputType}
        label="To"
        value={range.to}
        onChange={(e) => onChange({ ...range, to: e.target.value })}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ minWidth: 130, flexGrow: 1 }}
      />
    </Box>
  );
}

/** The value input appropriate for a field type and operator. */
function FilterValueInput(props: {
  fieldType: FieldType | undefined;
  operator: StudioFilterOperator;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { fieldType, operator, value, onChange } = props;
  const strVal = String(value ?? '');

  if (operator === 'between' && (fieldType === 'date' || fieldType === 'datetime')) {
    return (
      <DateRangeInput
        inputType={fieldType === 'datetime' ? 'datetime-local' : 'date'}
        value={value}
        onChange={onChange}
      />
    );
  }

  if (fieldType === 'date') {
    return (
      <TextField
        size="small"
        type="date"
        label="Date"
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ minWidth: 130, flexGrow: 1 }}
      />
    );
  }

  if (fieldType === 'datetime') {
    return (
      <TextField
        size="small"
        type="datetime-local"
        label="Date & time"
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ minWidth: 160, flexGrow: 1 }}
      />
    );
  }

  if (fieldType === 'boolean') {
    return (
      <FormControl size="small" sx={{ minWidth: 90, flexGrow: 1 }}>
        <InputLabel>Value</InputLabel>
        <Select label="Value" value={strVal} onChange={(e) => onChange(e.target.value)}>
          <MenuItem value="true">True</MenuItem>
          <MenuItem value="false">False</MenuItem>
        </Select>
      </FormControl>
    );
  }

  return (
    <TextField
      size="small"
      label="Value"
      value={strVal}
      onChange={(e) => onChange(e.target.value)}
      sx={{ minWidth: 80, flexGrow: 1 }}
    />
  );
}

type SimpleField = { id: string; label: string; fieldType: FieldType };

interface FilterRowProps {
  filter: StudioFilterState;
  fields: SimpleField[];
  onRemove: (id: string) => void;
}

function FilterRow(props: FilterRowProps) {
  const { fields, filter, onRemove } = props;
  const controller = useStudioController();

  const currentField = fields.find((f) => f.id === filter.field);
  const fieldType = filter.fieldType ?? currentField?.fieldType;
  const operators = getOperators(fieldType);
  // Ensure operator is valid for this field type
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;

  const handleChange = (changes: Partial<StudioFilterState>) => {
    controller.removeFilter(filter.id);
    controller.addFilter({ ...filter, ...changes });
  };

  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <FormControl size="small" sx={{ minWidth: 100, flexGrow: 1 }}>
        <InputLabel>Field</InputLabel>
        <Select
          label="Field"
          value={filter.field}
          onChange={(e) => {
            const f = fields.find((fld) => fld.id === e.target.value);
            handleChange({ field: e.target.value, fieldType: f?.fieldType, value: '' });
          }}
        >
          {fields.map((f) => (
            <MenuItem key={f.id} value={f.id}>
              {f.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ minWidth: 100, flexGrow: 1 }}>
        <InputLabel>Op.</InputLabel>
        <Select
          label="Op."
          value={activeOperator}
          onChange={(e) => {
            const op = e.target.value as StudioFilterOperator;
            const wasBetween = activeOperator === 'between';
            const nowBetween = op === 'between';
            handleChange({
              operator: op,
              // Reset value when switching between range and non-range modes
              ...(wasBetween !== nowBetween ? { value: nowBetween ? { from: '', to: '' } : '' } : {}),
            });
          }}
        >
          {operators.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {op.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FilterValueInput
        fieldType={fieldType}
        operator={activeOperator}
        value={filter.value}
        onChange={(v) => handleChange({ value: v })}
      />

      <Tooltip title="Remove filter">
        <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

interface WidgetFilterRowProps {
  filter: StudioFilterState;
  widgetSourceId?: string;
  fieldOptions: FieldOption[];
  onRemove: (id: string) => void;
}

function WidgetFilterRow(props: WidgetFilterRowProps) {
  const { filter, widgetSourceId, fieldOptions, onRemove } = props;
  const controller = useStudioController();

  const effectiveSourceId = filter.filterSourceId ?? widgetSourceId ?? '';

  // The currently selected field option (matched by id + sourceId)
  const selectedOption =
    fieldOptions.find((o) => o.id === filter.field && o.sourceId === effectiveSourceId) ?? null;

  const handleChange = (changes: Partial<StudioFilterState>) => {
    controller.removeFilter(filter.id);
    controller.addFilter({ ...filter, ...changes });
  };

  const handleFieldChange = (_e: React.SyntheticEvent, option: FieldOption | null) => {
    if (!option) return;
    const newSourceId = option.sourceId;
    const isNowCrossSource = newSourceId !== widgetSourceId;

    handleChange({
      field: option.id,
      fieldType: option.fieldType,
      filterSourceId: isNowCrossSource ? newSourceId : undefined,
      value: '',
    });
  };

  const fieldType = filter.fieldType ?? selectedOption?.fieldType;
  const operators = getOperators(fieldType);
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Single grouped field picker (source + field) */}
        <Autocomplete
          size="small"
          sx={{ minWidth: 140, flexGrow: 2 }}
          options={fieldOptions}
          groupBy={(option) => option.sourceLabel}
          getOptionLabel={(option) => option.label}
          value={selectedOption}
          onChange={handleFieldChange}
          isOptionEqualToValue={(option, value) =>
            option.id === value.id && option.sourceId === value.sourceId
          }
          renderInput={(params) => <TextField {...params} label="Field" />}
        />

        <FormControl size="small" sx={{ minWidth: 100, flexGrow: 1 }}>
          <InputLabel>Op.</InputLabel>
          <Select
            label="Op."
            value={activeOperator}
            onChange={(e) => {
              const op = e.target.value as StudioFilterOperator;
              const wasBetween = activeOperator === 'between';
              const nowBetween = op === 'between';
              handleChange({
                operator: op,
                ...(wasBetween !== nowBetween ? { value: nowBetween ? { from: '', to: '' } : '' } : {}),
              });
            }}
          >
            {operators.map((op) => (
              <MenuItem key={op.value} value={op.value}>
                {op.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FilterValueInput
          fieldType={fieldType}
          operator={activeOperator}
          value={filter.value}
          onChange={(v) => handleChange({ value: v })}
        />

        <Tooltip title="Remove filter">
          <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

interface FilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  fields: SimpleField[];
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
}

function FilterSection(props: FilterSectionProps) {
  const { fields, filters, onAddFilter, onRemoveFilter, title } = props;

  return (
    <Box>
      <Stack direction="row" sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2">{title}</Typography>
      </Stack>

      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          No filters applied.
        </Typography>
      ) : (
        <Stack spacing={1.5} sx={{ mb: 1 }}>
          {filters.map((filter) => (
            <FilterRow key={filter.id} filter={filter} fields={fields} onRemove={onRemoveFilter} />
          ))}
        </Stack>
      )}

      <Button
        startIcon={<AddIcon />}
        size="small"
        onClick={onAddFilter}
        disabled={fields.length === 0}
      >
        Add filter
      </Button>
    </Box>
  );
}

interface WidgetFilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  widgetSourceId?: string;
  fieldOptions: FieldOption[];
  dataSources: Record<string, StudioDataSource>;
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
}

function WidgetFilterSection(props: WidgetFilterSectionProps) {
  const { filters, widgetSourceId, fieldOptions, dataSources, onAddFilter, onRemoveFilter, title } =
    props;
  const hasAnySources = Object.keys(dataSources).length > 0;

  return (
    <Box>
      <Stack direction="row" sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2">{title}</Typography>
      </Stack>

      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          No filters applied.
        </Typography>
      ) : (
        <Stack spacing={2} sx={{ mb: 1 }}>
          {filters.map((filter) => (
            <WidgetFilterRow
              key={filter.id}
              filter={filter}
              widgetSourceId={widgetSourceId}
              fieldOptions={fieldOptions}
              onRemove={onRemoveFilter}
            />
          ))}
        </Stack>
      )}

      <Button
        startIcon={<AddIcon />}
        size="small"
        onClick={onAddFilter}
        disabled={!hasAnySources}
      >
        Add filter
      </Button>
    </Box>
  );
}

export function StudioFiltersDrawer() {
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const widgets = useStudioSelector((state) => state.widgets);

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

  const fieldOptions = React.useMemo(
    () => buildFieldOptions(dataSources),
    [dataSources],
  );

  const selectedWidget = selectedWidgetId ? widgets[selectedWidgetId] : null;

  const pageFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'page',
  );
  const widgetFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'widget' && f.widgetId === selectedWidgetId,
  );
  const crossFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'cross-filter',
  );

  const handleAddPageFilter = () => {
    if (allFields.length === 0) return;
    const first = allFields[0];
    controller.addFilter({
      id: generateId(),
      field: first.id,
      fieldType: first.fieldType,
      operator: 'equals',
      value: '',
      scope: 'page',
    });
  };

  const handleAddWidgetFilter = () => {
    if (!selectedWidgetId || Object.keys(dataSources).length === 0) return;

    const widgetSource = selectedWidget?.sourceId
      ? (dataSources[selectedWidget.sourceId] as StudioDataSource | undefined)
      : undefined;
    const firstSourceField = widgetSource?.fields.find((f) => !f.hidden);
    const firstFieldId = firstSourceField?.id ?? allFields[0]?.id ?? '';
    const firstFieldType = firstSourceField?.type ?? allFields[0]?.fieldType;

    controller.addFilter({
      id: generateId(),
      field: firstFieldId,
      fieldType: firstFieldType,
      operator: 'equals',
      value: '',
      scope: 'widget',
      widgetId: selectedWidgetId,
      filterSourceId: selectedWidget?.sourceId,
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
        onAddFilter={handleAddPageFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
      />

      <Divider />

      <WidgetFilterSection
        title={selectedWidget ? `Widget: ${selectedWidget.title}` : 'Widget filters'}
        filters={widgetFilters}
        widgetSourceId={selectedWidget?.sourceId}
        fieldOptions={fieldOptions}
        dataSources={dataSources}
        onAddFilter={handleAddWidgetFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
      />

      {!selectedWidgetId && (
        <Typography variant="caption" color="text.secondary">
          Select a widget to add widget-level filters.
        </Typography>
      )}

      <Divider />

      <Box>
        <Stack
          direction="row"
          sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="subtitle2">Cross-filters</Typography>
        </Stack>

        {crossFilters.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No cross-filters active. Click on chart elements or select grid rows to create
            cross-filters.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {(crossFilters as StudioFilterState[]).map((filter: StudioFilterState) => (
              <Box
                key={filter.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  p: 1,
                  borderRadius: 1,
                  bgcolor: 'action.selected',
                  border: 1,
                  borderColor: 'primary.light',
                }}
              >
                <Box>
                  <Typography variant="body2">
                    {filter.field} = {String(filter.value)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    From widget: {filter.sourceWidgetId}
                  </Typography>
                </Box>
                <Tooltip title="Remove cross-filter">
                  <IconButton
                    size="small"
                    onClick={() => controller.removeFilter(filter.id)}
                    aria-label="Remove cross-filter"
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
            <Button
              size="small"
              color="error"
              onClick={() => controller.clearAllCrossFilters()}
              startIcon={<DeleteIcon />}
            >
              Clear all cross-filters
            </Button>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
