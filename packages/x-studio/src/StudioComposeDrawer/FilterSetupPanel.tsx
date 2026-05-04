'use client';
import * as React from 'react';
import {
  Alert,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioSelector } from '../context';
import { fieldHasCapability } from '../utils/fieldCapabilities';
import type { StudioFilterWidgetType } from '../models';

const FILTER_WIDGET_TYPES: { value: StudioFilterWidgetType; label: string; description: string }[] = [
  { value: 'multi-select', label: 'Multi-select', description: 'Checkbox list of categorical values' },
  { value: 'toggle', label: 'Toggle chips', description: 'Chip buttons for low-cardinality categories' },
  { value: 'date-range', label: 'Date range', description: 'From / to date pickers' },
  { value: 'slider', label: 'Numeric slider', description: 'Range slider for numeric values' },
  { value: 'search', label: 'Text search', description: 'Keyword search on a text field' },
];

export function FilterSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const config = widget?.config ?? {};

  const filterType: StudioFilterWidgetType = config.filterWidgetType ?? 'multi-select';
  const fieldId = config.filterWidgetField ?? '';

  // Build field options filtered by what's appropriate for the selected filter type
  const allSources = Object.values(dataSources).filter((s) => !s.hidden);

  const fieldOptions = React.useMemo(() => {
    return allSources.flatMap((src) =>
      src.fields
        .filter((f) => !f.hidden)
        .filter((f) => {
          if (filterType === 'date-range') return fieldHasCapability(f, 'temporal');
          if (filterType === 'slider') return fieldHasCapability(f, 'numeric');
          return true;
        })
        .map((f) => ({ value: f.id, label: f.label, sourceId: src.id, sourceLabel: src.label, type: f.type })),
    );
  }, [allSources, filterType]);

  const sourceOptions = Object.values(dataSources).filter((s) => !s.hidden);

  if (!widget) {
    return null;
  }

  const handleTypeChange = (newType: StudioFilterWidgetType) => {
    controller.updateWidgetConfig(widgetId, {
      filterWidgetType: newType,
      // Clear field when type changes to avoid mismatches
      filterWidgetField: undefined,
    });
    // Clear any existing interactive filter when type changes
    controller.clearInteractiveFilter(widgetId);
  };

  const handleSourceChange = (newSourceId: string) => {
    controller.updateWidget(widgetId, { sourceId: newSourceId });
    controller.updateWidgetConfig(widgetId, { filterWidgetField: undefined });
  };

  const handleFieldChange = (newFieldId: string) => {
    const chosenField = fieldOptions.find((f) => f.value === newFieldId);
    controller.updateWidgetConfig(widgetId, {
      filterWidgetField: newFieldId,
      filterWidgetSourceId: chosenField?.sourceId !== widget.sourceId ? chosenField?.sourceId : undefined,
    });
    // Clear the active filter when the field changes
    controller.clearInteractiveFilter(widgetId);
  };

  return (
    <Stack spacing={2}>
      {/* Data source */}
      {sourceOptions.length > 1 && (
        <FormControl size="small" fullWidth>
          <InputLabel>Data source</InputLabel>
          <Select
            value={widget.sourceId ?? ''}
            label="Data source"
            onChange={(e) => handleSourceChange(e.target.value)}
          >
            {sourceOptions.map((src) => (
              <MenuItem key={src.id} value={src.id}>
                {src.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {/* Filter type */}
      <FormControl size="small" fullWidth>
        <InputLabel>Control type</InputLabel>
        <Select
          value={filterType}
          label="Control type"
          onChange={(e) => handleTypeChange(e.target.value as StudioFilterWidgetType)}
        >
          {FILTER_WIDGET_TYPES.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              <div>
                <Typography variant="body2">{opt.label}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {opt.description}
                </Typography>
              </div>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Field */}
      <FormControl size="small" fullWidth>
        <InputLabel>Field</InputLabel>
        <Select
          value={fieldId}
          label="Field"
          onChange={(e) => handleFieldChange(e.target.value)}
        >
          {fieldOptions.map((opt) => (
            <MenuItem key={`${opt.sourceId}-${opt.value}`} value={opt.value}>
              {opt.label}
              {opt.sourceId !== widget.sourceId && (
                <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  ({opt.sourceLabel})
                </Typography>
              )}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Optional label override */}
      <TextField
        size="small"
        fullWidth
        label="Label (optional)"
        placeholder="Auto-detected from field"
        value={config.filterWidgetLabel ?? ''}
        onChange={(e) =>
          controller.updateWidgetConfig(widgetId, {
            filterWidgetLabel: e.target.value || undefined,
          })
        }
      />

      {/* Slider-specific: min / max / step */}
      {filterType === 'slider' && (
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            Slider range (leave blank to auto-detect from data)
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="Min"
              type="number"
              value={config.filterWidgetMin ?? ''}
              onChange={(e) =>
                controller.updateWidgetConfig(widgetId, {
                  filterWidgetMin: e.target.value !== '' ? Number(e.target.value) : undefined,
                })
              }
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Max"
              type="number"
              value={config.filterWidgetMax ?? ''}
              onChange={(e) =>
                controller.updateWidgetConfig(widgetId, {
                  filterWidgetMax: e.target.value !== '' ? Number(e.target.value) : undefined,
                })
              }
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Step"
              type="number"
              value={config.filterWidgetStep ?? ''}
              onChange={(e) =>
                controller.updateWidgetConfig(widgetId, {
                  filterWidgetStep: e.target.value !== '' ? Number(e.target.value) : undefined,
                })
              }
              sx={{ flex: 1 }}
            />
          </Stack>
        </Stack>
      )}

      {!fieldId && source && (
        <Alert severity="info">Select a field to configure the filter control.</Alert>
      )}
      {!source && (
        <Alert severity="warning">No data source bound. Select a source above.</Alert>
      )}
    </Stack>
  );
}
