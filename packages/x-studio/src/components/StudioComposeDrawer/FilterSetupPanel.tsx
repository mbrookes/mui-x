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
  useStudioLocaleText,
} from '../../context';
import type {
  StudioFilterWidgetType,
  StudioWidgetConfig,
  StudioWidgetConfigForKind,
} from '../../models';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';

/**
 * Slider min/max/step numeric input (architecture review finding 2.3): parsing and
 * committing `controller.updateWidgetConfig` on every keystroke made each digit an
 * undoable commit plus a mutation-log line plus a full pipeline recompute, and made
 * an in-progress value (e.g. a bare "-") impossible to type. Buffer the displayed
 * text locally and only parse/commit on blur/Enter, mirroring
 * `GaugeConfigSection.tsx`'s min/max inputs.
 */
function SliderBoundInput(props: {
  value: number | undefined;
  label: string;
  onCommit: (next: number | undefined) => void;
}) {
  const { value, label, onCommit } = props;
  const initialText = value !== undefined ? String(value) : '';
  const [text, setText] = React.useState(initialText);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed bound; resync on external change (field swap, undo/redo)
  React.useEffect(() => {
    setText(initialText);
    setDirty(false);
  }, [initialText]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    const next = raw === '' ? undefined : Number(raw);
    const resolved = next !== undefined && Number.isNaN(next) ? value : next;
    if (resolved !== value) {
      onCommit(resolved);
    }
    setText(resolved !== undefined ? String(resolved) : '');
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      fullWidth
      label={label}
      type="number"
      value={text}
      onChange={(evt) => {
        setText(evt.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter') {
          commit();
        }
      }}
    />
  );
}

export function FilterSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const localeText = useStudioLocaleText();

  const config = (widget?.config ?? {}) as StudioWidgetConfigForKind<'filter'>;
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
    const configUpdate: Partial<StudioWidgetConfig> = {
      filterWidgetField: newFieldId || undefined,
      filterWidgetSourceId: newSourceId !== widget.sourceId ? newSourceId : undefined,
    };
    // When the picked field belongs to a different source, adopt that source AND write
    // the field in ONE `updateWidget` commit so the cross-source field pick is a single
    // undo step (finding 2.2) — a lone Ctrl+Z otherwise lands on a torn state (new
    // sourceId, old field) the UI never produced. `clearInteractiveFilter` is a separate
    // non-undoable (session-scoped) commit and never adds an undo entry.
    if (newSourceId && newSourceId !== widget.sourceId) {
      controller.updateWidget(widgetId, {
        sourceId: newSourceId,
        config: { ...config, ...configUpdate },
      });
    } else {
      controller.updateWidgetConfig(widgetId, configUpdate);
    }
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
        required
      />

      {!fieldId && <Alert severity="info">{localeText.filterSetupSelectFieldAlert}</Alert>}

      {/* Slider-specific: min / max / step */}
      {filterType === 'slider' && (
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            {localeText.filterSetupSliderRangeHelperText}
          </Typography>
          <Stack spacing={1}>
            <SliderBoundInput
              value={config.filterWidgetMin}
              label={localeText.filterSetupMinLabel}
              onCommit={(next) =>
                controller.updateWidgetConfig(widgetId, { filterWidgetMin: next })
              }
            />
            <SliderBoundInput
              value={config.filterWidgetMax}
              label={localeText.filterSetupMaxLabel}
              onCommit={(next) =>
                controller.updateWidgetConfig(widgetId, { filterWidgetMax: next })
              }
            />
            <SliderBoundInput
              value={config.filterWidgetStep}
              label={localeText.filterSetupStepLabel}
              onCommit={(next) =>
                controller.updateWidgetConfig(widgetId, { filterWidgetStep: next })
              }
            />
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
