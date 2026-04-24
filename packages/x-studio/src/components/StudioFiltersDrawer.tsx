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
import type { StudioDataSource, StudioFilterOperator, StudioFilterState } from '../models';

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

interface WidgetFilterRowProps {
  filter: StudioFilterState;
  widgetSourceId?: string;
  dataSources: Record<string, StudioDataSource>;
  onRemove: (id: string) => void;
}

function WidgetFilterRow(props: WidgetFilterRowProps) {
  const { filter, widgetSourceId, dataSources, onRemove } = props;
  const controller = useStudioController();

  const effectiveSourceId = filter.filterSourceId ?? widgetSourceId ?? '';
  const isCrossSource = !!effectiveSourceId && effectiveSourceId !== widgetSourceId;

  const sourceList = Object.values(dataSources);
  const currentSource = dataSources[effectiveSourceId];
  const widgetSource = widgetSourceId ? dataSources[widgetSourceId] : undefined;
  const sourceFields = (currentSource?.fields ?? []).filter((f) => !f.hidden);

  const handleChange = (changes: Partial<StudioFilterState>) => {
    controller.removeFilter(filter.id);
    controller.addFilter({ ...filter, ...changes });
  };

  const handleSourceChange = (newSourceId: string) => {
    const newSource = dataSources[newSourceId];
    const firstField = newSource?.fields.find((f) => !f.hidden)?.id ?? '';
    // Auto-pick link field: first *Id field or last field; target: 'id' in widget source
    const linkField =
      newSource?.fields.find((f) => f.id.endsWith('Id') || f.id.endsWith('_id'))?.id ??
      newSource?.fields[0]?.id ??
      '';
    const targetField = widgetSource?.fields.find((f) => f.id === 'id')?.id ?? '';

    handleChange({
      filterSourceId: newSourceId === widgetSourceId ? undefined : newSourceId,
      field: firstField,
      value: '',
      linkField: newSourceId === widgetSourceId ? undefined : linkField,
      targetField: newSourceId === widgetSourceId ? undefined : targetField,
    });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Source picker */}
        <FormControl size="small" sx={{ minWidth: 100, flexGrow: 1 }}>
          <InputLabel>Source</InputLabel>
          <Select
            label="Source"
            value={effectiveSourceId}
            onChange={(e) => handleSourceChange(e.target.value)}
          >
            {sourceList.map((src) => (
              <MenuItem key={src.id} value={src.id}>
                {src.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Field picker */}
        <FormControl size="small" sx={{ minWidth: 100, flexGrow: 1 }}>
          <InputLabel>Field</InputLabel>
          <Select
            label="Field"
            value={filter.field}
            onChange={(e) => handleChange({ field: e.target.value, value: '' })}
          >
            {sourceFields.map((f) => (
              <MenuItem key={f.id} value={f.id}>
                {f.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Operator */}
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

      {/* Cross-source join config */}
      {isCrossSource && (
        <Box
          sx={{
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            pl: 1,
            borderLeft: 2,
            borderColor: 'primary.light',
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            via
          </Typography>
          <FormControl size="small" sx={{ minWidth: 90, flexGrow: 1 }}>
            <InputLabel>Link field</InputLabel>
            <Select
              label="Link field"
              value={filter.linkField ?? ''}
              onChange={(e) => handleChange({ linkField: e.target.value })}
            >
              {(currentSource?.fields ?? []).map((f) => (
                <MenuItem key={f.id} value={f.id}>
                  {f.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            =
          </Typography>
          <FormControl size="small" sx={{ minWidth: 90, flexGrow: 1 }}>
            <InputLabel>Target field</InputLabel>
            <Select
              label="Target field"
              value={filter.targetField ?? ''}
              onChange={(e) => handleChange({ targetField: e.target.value })}
            >
              {(widgetSource?.fields ?? []).map((f) => (
                <MenuItem key={f.id} value={f.id}>
                  {f.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      )}
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
  dataSources: Record<string, StudioDataSource>;
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
}

function WidgetFilterSection(props: WidgetFilterSectionProps) {
  const { filters, widgetSourceId, dataSources, onAddFilter, onRemoveFilter, title } = props;
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
              dataSources={dataSources}
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
    const fieldMap = new Map<string, string>();

    for (const source of Object.values(dataSources) as StudioDataSource[]) {
      for (const field of source.fields) {
        fieldMap.set(field.id, field.label);
      }
    }

    return Array.from(fieldMap.entries()).map(([id, label]) => ({ id, label }));
  }, [dataSources]);

  const selectedWidget = selectedWidgetId ? (widgets as Record<string, typeof widgets[string]>)[selectedWidgetId] : null;

  const pageFilters = (filters as StudioFilterState[]).filter((f: StudioFilterState) => f.scope === 'page');
  const widgetFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'widget' && f.widgetId === selectedWidgetId,
  );
  const crossFilters = (filters as StudioFilterState[]).filter((f: StudioFilterState) => f.scope === 'cross-filter');

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
    if (!selectedWidgetId || Object.keys(dataSources).length === 0) {
      return;
    }

    const widgetSource = selectedWidget?.sourceId
      ? dataSources[selectedWidget.sourceId]
      : undefined;
    const firstField =
      widgetSource?.fields.find((f) => !f.hidden)?.id ?? allFields[0]?.id ?? '';

    controller.addFilter({
      id: generateId(),
      field: firstField,
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

      {/* Cross-filters section */}
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
