import * as React from 'react';
import {
  Alert,
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
import type { StudioFilterOperator, StudioFilterState } from '../models';

const OPERATORS: { value: StudioFilterOperator; label: string }[] = [
  { value: 'equals', label: '= Equals' },
  { value: 'not_equals', label: '≠ Not equals' },
  { value: 'contains', label: '⊇ Contains' },
  { value: 'greater_than', label: '> Greater than' },
  { value: 'less_than', label: '< Less than' },
  { value: 'greater_than_or_equal', label: '≥ ≥' },
  { value: 'less_than_or_equal', label: '≤ ≤' },
];

function generateId() {
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface FilterRowProps {
  filter: StudioFilterState;
  fields: { id: string; label: string }[];
  onRemove: (id: string) => void;
}

function FilterRow(props: FilterRowProps) {
  const { fields, filter, onRemove } = props;
  const controller = useStudioController();

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
          onChange={(e) => handleChange({ field: e.target.value, value: '' })}
        >
          {fields.map((f) => (
            <MenuItem key={f.id} value={f.id}>
              {f.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ minWidth: 90, flexGrow: 1 }}>
        <InputLabel>Op.</InputLabel>
        <Select
          label="Op."
          value={filter.operator}
          onChange={(e) => handleChange({ operator: e.target.value as StudioFilterOperator })}
        >
          {OPERATORS.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {op.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <TextField
        size="small"
        label="Value"
        value={String(filter.value ?? '')}
        onChange={(e) => handleChange({ value: e.target.value })}
        sx={{ minWidth: 80, flexGrow: 1 }}
      />

      <Tooltip title="Remove filter">
        <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

interface FilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  fields: { id: string; label: string }[];
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
            <FilterRow
              key={filter.id}
              filter={filter}
              fields={fields}
              onRemove={onRemoveFilter}
            />
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

export function StudioFiltersDrawer() {
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const widgets = useStudioSelector((state) => state.widgets);

  const allFields = React.useMemo(() => {
    const fieldMap = new Map<string, string>();

    for (const source of Object.values(dataSources)) {
      for (const field of source.fields) {
        fieldMap.set(field.id, field.label);
      }
    }

    return Array.from(fieldMap.entries()).map(([id, label]) => ({ id, label }));
  }, [dataSources]);

  const selectedWidget = selectedWidgetId ? widgets[selectedWidgetId] : null;
  const widgetFields = React.useMemo(() => {
    if (!selectedWidget?.sourceId) {
      return allFields;
    }

    const source = dataSources[selectedWidget.sourceId];

    return source?.fields ?? allFields;
  }, [selectedWidget, dataSources, allFields]);

  const pageFilters = filters.filter((f) => f.scope === 'page');
  const widgetFilters = filters.filter((f) => f.scope === 'widget' && f.widgetId === selectedWidgetId);
  const crossFilters = filters.filter((f) => f.scope === 'cross-filter');

  const handleAddPageFilter = () => {
    if (allFields.length === 0) {
      return;
    }

    controller.addFilter({
      id: generateId(),
      field: allFields[0].id,
      operator: 'equals',
      value: '',
      scope: 'page',
    });
  };

  const handleAddWidgetFilter = () => {
    if (!selectedWidgetId || widgetFields.length === 0) {
      return;
    }

    controller.addFilter({
      id: generateId(),
      field: widgetFields[0].id,
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
        onAddFilter={handleAddPageFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
      />

      <Divider />

      <FilterSection
        title={selectedWidget ? `Widget: ${selectedWidget.title}` : 'Widget filters'}
        filters={widgetFilters}
        fields={widgetFields}
        onAddFilter={handleAddWidgetFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
      />

      {!selectedWidgetId && (
        <Typography variant="caption" color="text.secondary">
          Select a widget to add widget-level filters.
        </Typography>
      )}

      <Divider />

      {/* Cross-filters section */}
      <Box>
        <Stack direction="row" sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle2">Cross-filters</Typography>
          
        </Stack>

        {crossFilters.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No cross-filters active. Click on chart elements or select grid rows to create cross-filters.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {crossFilters.map((filter) => (
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
