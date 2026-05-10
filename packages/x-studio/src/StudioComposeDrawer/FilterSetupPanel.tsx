'use client';
import * as React from 'react';
import {
  Alert,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
} from '../context';
import type { StudioFilterWidgetType } from '../models';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';

const FILTER_WIDGET_TYPES: { value: StudioFilterWidgetType; label: string; description: string }[] =
  [
    {
      value: 'multi-select',
      label: 'Multi-select',
      description: 'Dropdown with checkboxes for categorical values',
    },
    {
      value: 'toggle',
      label: 'Toggle chips',
      description: 'Chip buttons for low-cardinality categories',
    },
    { value: 'date-range', label: 'Date range', description: 'From / to date pickers' },
    { value: 'slider', label: 'Slider', description: 'Range slider for numeric or date fields' },
  ];

export function FilterSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);

  const config = widget?.config ?? {};

  const filterType: StudioFilterWidgetType = config.filterWidgetType ?? 'multi-select';
  const fieldId = config.filterWidgetField ?? '';

  // Capability constraint for the field picker based on filter type
  // (slider supports both numeric and temporal — filtered via getOptionDisabled)
  const fieldCapability = filterType === 'date-range' ? 'temporal' : undefined;

  const sliderGetOptionDisabled =
    filterType === 'slider'
      ? (option: { type?: string }) =>
          option.type !== 'number' && option.type !== 'date' && option.type !== 'datetime'
      : undefined;

  if (!widget) {
    return null;
  }

  const handleTypeChange = (newType: StudioFilterWidgetType) => {
    // Determine if the currently selected field is compatible with the new type.
    // Only clear the field if it's known to be incompatible; otherwise preserve it.
    let clearField = false;
    if (fieldId) {
      const currentField = Object.values(dataSources)
        .flatMap((ds) => ds.fields)
        .find((f) => f.id === fieldId);
      if (currentField) {
        const fieldType = currentField.type;
        if (newType === 'date-range') {
          // date-range requires a temporal field
          clearField = fieldType !== 'date' && fieldType !== 'datetime';
        } else if (newType === 'slider') {
          // slider requires numeric or temporal
          clearField = fieldType !== 'number' && fieldType !== 'date' && fieldType !== 'datetime';
        }
        // multi-select and toggle accept any field type — never clear
      }
    }
    controller.updateWidgetConfig(widgetId, {
      filterWidgetType: newType,
      ...(clearField ? { filterWidgetField: undefined } : {}),
    });
    controller.clearInteractiveFilter(widgetId);
  };

  const handleFieldChange = (newFieldId: string, newSourceId: string) => {
    const prevSourceId = widget.sourceId;
    if (newSourceId && newSourceId !== prevSourceId) {
      controller.updateWidget(widgetId, { sourceId: newSourceId });
    }
    controller.updateWidgetConfig(widgetId, {
      filterWidgetField: newFieldId || undefined,
      filterWidgetSourceId: newSourceId !== widget.sourceId ? newSourceId : undefined,
    });
    controller.clearInteractiveFilter(widgetId);
  };

  return (
    <Stack spacing={2}>
      {/* Filter type */}
      <FormControl size="small" fullWidth>
        <InputLabel>Control type</InputLabel>
        <Select
          value={filterType}
          label="Control type"
          onChange={(evt) => handleTypeChange(evt.target.value as StudioFilterWidgetType)}
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

      {/* Combined data source + field picker */}
      <DataSourceFieldSelect
        value={fieldId}
        onChange={handleFieldChange}
        dataSources={dataSources}
        filterCapability={fieldCapability}
        getOptionDisabled={sliderGetOptionDisabled}
        label="Field"
      />

      {/* Optional label override */}
      <TextField
        size="small"
        fullWidth
        label="Label (optional)"
        placeholder="Auto-detected from field"
        value={config.filterWidgetLabel ?? ''}
        onChange={(evt) =>
          controller.updateWidgetConfig(widgetId, {
            filterWidgetLabel: evt.target.value || undefined,
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
              onChange={(evt) =>
                controller.updateWidgetConfig(widgetId, {
                  filterWidgetMin: evt.target.value !== '' ? Number(evt.target.value) : undefined,
                })
              }
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Max"
              type="number"
              value={config.filterWidgetMax ?? ''}
              onChange={(evt) =>
                controller.updateWidgetConfig(widgetId, {
                  filterWidgetMax: evt.target.value !== '' ? Number(evt.target.value) : undefined,
                })
              }
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Step"
              type="number"
              value={config.filterWidgetStep ?? ''}
              onChange={(evt) =>
                controller.updateWidgetConfig(widgetId, {
                  filterWidgetStep: evt.target.value !== '' ? Number(evt.target.value) : undefined,
                })
              }
              sx={{ flex: 1 }}
            />
          </Stack>
        </Stack>
      )}

      {!fieldId && <Alert severity="info">Select a field to configure the filter control.</Alert>}
    </Stack>
  );
}
