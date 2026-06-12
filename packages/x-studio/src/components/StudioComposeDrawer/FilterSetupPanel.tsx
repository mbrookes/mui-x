'use client';
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
  useStudioLocaleText,
} from '../../context';
import type { StudioFilterWidgetType } from '../../models';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';

export function FilterSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const localeText = useStudioLocaleText();

  const config = widget?.config ?? {};
  const filterWidgetTypes: { value: StudioFilterWidgetType; label: string; description: string }[] =
    [
      {
        value: 'multi-select',
        label: localeText.filterSetupMultiSelect,
        description: localeText.filterSetupMultiSelectDescription,
      },
      {
        value: 'toggle',
        label: localeText.filterSetupToggleChips,
        description: localeText.filterSetupToggleChipsDescription,
      },
      {
        value: 'date-range',
        label: localeText.filterSetupDateRange,
        description: localeText.filterSetupDateRangeDescription,
      },
      {
        value: 'slider',
        label: localeText.filterSetupSlider,
        description: localeText.filterSetupSliderDescription,
      },
    ];

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
        <InputLabel>{localeText.filterSetupControlTypeLabel}</InputLabel>
        <Select
          value={filterType}
          label={localeText.filterSetupControlTypeLabel}
          onChange={(evt) => handleTypeChange(evt.target.value as StudioFilterWidgetType)}
        >
          {filterWidgetTypes.map((opt) => (
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
        label={localeText.filterFieldLabel}
      />

      {/* Slider-specific: min / max / step */}
      {filterType === 'slider' && (
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            {localeText.filterSetupSliderRangeHelperText}
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label={localeText.filterSetupMinLabel}
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
              label={localeText.filterSetupMaxLabel}
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
              label={localeText.filterSetupStepLabel}
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

      {!fieldId && <Alert severity="info">{localeText.filterSetupSelectFieldAlert}</Alert>}
    </Stack>
  );
}
