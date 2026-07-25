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
  selectFilters,
  selectRelationships,
  selectExpressionFields,
  useStudioLocaleText,
} from '../../context';
import type {
  StudioFilterWidgetType,
  StudioWidgetConfig,
  StudioWidgetConfigForKind,
} from '../../models';
import { buildFieldCatalog } from '../../internals/fieldCatalog';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';
import { collectStaleWidgetFilterIds } from './collectStaleWidgetFilterIds';

/**
 * Slider min/max/step numeric input (architecture review finding 2.3): parsing and
 * committing `controller.updateWidgetConfig` on every keystroke made each digit an
 * undoable commit plus a mutation-log line plus a full pipeline recompute, and made
 * an in-progress value (e.g. a bare "-") impossible to type. Buffer the displayed
 * text locally and only parse/commit on blur/Enter, mirroring
 * `GaugeConfigSection.tsx`'s min/max inputs.
 */
function SliderBoundInput(props: {
  widgetId: string;
  value: number | undefined;
  label: string;
  onCommit: (next: number | undefined) => void;
}) {
  const { widgetId, value, label, onCommit } = props;
  const initialText = value !== undefined ? String(value) : '';
  const [text, setText] = React.useState(initialText);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed bound; resync on external change (field swap, widget switch, undo/redo). `widgetId` must be in the deps (not just `initialText`) — a widget switch that lands on the SAME bound value would otherwise leave a still-dirty buffer from the previous widget uncommitted into the new one.
  React.useEffect(() => {
    setText(initialText);
    setDirty(false);
  }, [initialText, widgetId]);

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
  const allFilters = useStudioSelector(selectFilters);
  const relationships = useStudioSelector(selectRelationships);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const localeText = useStudioLocaleText();

  const fieldCatalog = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields),
    [dataSources, expressionFields],
  );

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
      // Resolve the configured field scoped to its own source first (finding 3.14): a bare-id
      // lookup across every source lets an id collision on an unrelated source decide the type,
      // wiping (or wrongly keeping) the configured field on a control-type switch. Fall back to
      // the unscoped lookup only when no source is known.
      const scopeSourceId = config.filterWidgetSourceId ?? widget.sourceId;
      const currentField =
        (scopeSourceId
          ? fieldCatalog.find((f) => f.id === fieldId && f.sourceId === scopeSourceId)
          : undefined) ?? fieldCatalog.find((f) => f.id === fieldId);
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
      // When the field is cleared as incompatible, drop its source id too (finding 3.13) —
      // a lingering `filterWidgetSourceId` with no field is stale doc garbage.
      ...(clearField ? { filterWidgetField: undefined, filterWidgetSourceId: undefined } : {}),
    });
    controller.clearInteractiveFilter(widgetId);
  };

  const handleFieldChange = (newFieldId: string, newSourceId: string) => {
    if (!newFieldId) {
      // Clearing the field: drop both the field and its source id, storing `undefined` (not
      // the `''` the empty `newSourceId` would otherwise leave via the `!== widget.sourceId`
      // comparison when the widget has no source) — a persisted empty-string source id is
      // stale doc garbage that no lookup resolves (finding 3.13).
      controller.updateWidgetConfig(widgetId, {
        filterWidgetField: undefined,
        filterWidgetSourceId: undefined,
      });
      controller.clearInteractiveFilter(widgetId);
      return;
    }
    const configUpdate: Partial<StudioWidgetConfig> = {
      filterWidgetField: newFieldId,
      filterWidgetSourceId: newSourceId !== widget.sourceId ? newSourceId : undefined,
      // Finding 7 (architecture review): a slider's explicit min/max/step are scoped to the
      // PREVIOUS field's value range — re-pointing the filter at a different field (e.g. a
      // 0-1000 price slider re-pointed at a 0-1 rate field) otherwise keeps the stale bounds,
      // rendering a useless slider (the new field's whole value range collapses to a sliver of
      // the old scale). Reset them so `StudioFilterWidget`'s `autoMin`/`autoMax`/`autoSliderStep`
      // (already computed from the actual row data whenever these are `undefined`) recompute
      // sensible bounds for the NEW field instead of carrying over the old ones.
      ...(filterType === 'slider' && {
        filterWidgetMin: undefined,
        filterWidgetMax: undefined,
        filterWidgetStep: undefined,
      }),
    };
    // When the picked field belongs to a different source, adopt that source AND write
    // the field in ONE `updateWidget` commit so the cross-source field pick is a single
    // undo step (finding 2.2) — a lone Ctrl+Z otherwise lands on a torn state (new
    // sourceId, old field) the UI never produced. `clearInteractiveFilter` is a separate
    // non-undoable (session-scoped) commit and never adds an undo entry.
    if (newSourceId && newSourceId !== widget.sourceId) {
      // Fold in the removal of any widget-scoped filter that no longer resolves against
      // the new source (finding 2.10) — filter widgets support widget-scoped filters, so
      // left in place a stale filter's field is absent from the new source and renders as
      // broken raw-id rows in the edit dialog, leaving permanent doc garbage. Every other
      // source-adopting setup panel (Chart/Gauge/KPI/Grid) folds this into the same commit.
      controller.updateWidget(
        widgetId,
        {
          sourceId: newSourceId,
          config: { ...config, ...configUpdate },
        },
        {
          removeFilterIds: collectStaleWidgetFilterIds(
            allFilters,
            widgetId,
            newSourceId,
            fieldCatalog,
            relationships,
          ),
        },
      );
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
              widgetId={widgetId}
              value={config.filterWidgetMin}
              label={localeText.filterSetupMinLabel}
              onCommit={(next) =>
                controller.updateWidgetConfig(widgetId, { filterWidgetMin: next })
              }
            />
            <SliderBoundInput
              widgetId={widgetId}
              value={config.filterWidgetMax}
              label={localeText.filterSetupMaxLabel}
              onCommit={(next) =>
                controller.updateWidgetConfig(widgetId, { filterWidgetMax: next })
              }
            />
            <SliderBoundInput
              widgetId={widgetId}
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
