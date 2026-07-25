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
import { fieldHasCapability } from '../../utils/fieldCapabilities';
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
  /**
   * Cross-field validation message. The three bounds are only meaningful RELATIVE to each
   * other, so no single field can validate itself — the parent computes the message and
   * hands it down. Purely advisory: the value is still committed (the user may be halfway
   * through raising Max after raising Min), but the panel now says what the widget will do
   * with it instead of silently overriding it.
   */
  error?: string;
  onCommit: (next: number | undefined) => void;
}) {
  const { widgetId, value, label, error, onCommit } = props;
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
      error={error !== undefined}
      helperText={error}
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
  // MUI's `Select` only emits `aria-labelledby` when handed an explicit `labelId`, and
  // `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context (its `label`
  // prop only sizes the outline notch), so an unpaired combobox has no accessible name
  // (`combobox` is not a name-from-content role). Unique per mount so two mounted
  // `<Studio>` instances never emit duplicate DOM ids.
  const controlTypeLabelId = React.useId();

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

  // Cross-validate the slider bounds against each other. `StudioFilterWidget` sanitizes
  // this triple at render time — it SWAPS an inverted min/max, replaces a zero-width range
  // with a hard-coded 0-100, and discards a non-positive step in favour of its auto step —
  // all silently, on the canvas, with nothing said here. So the author sees a slider that
  // simply ignores what they typed. Surface the conflict at the point of authoring instead;
  // the values are still committed (a half-finished edit is legitimate), only now explained.
  const sliderMin = config.filterWidgetMin;
  const sliderMax = config.filterWidgetMax;
  const sliderStep = config.filterWidgetStep;
  const boundsBothSet = sliderMin !== undefined && sliderMax !== undefined;
  // `>=` (not `>`): the widget treats a zero-width range as unusable too, replacing it
  // wholesale with 0-100.
  const boundsConflict = boundsBothSet && sliderMin >= sliderMax;
  let stepError: string | undefined;
  if (sliderStep !== undefined && !(Number.isFinite(sliderStep) && sliderStep > 0)) {
    stepError = localeText.filterSetupStepNotPositiveError;
  } else if (
    sliderStep !== undefined &&
    boundsBothSet &&
    !boundsConflict &&
    sliderStep > sliderMax - sliderMin
  ) {
    stepError = localeText.filterSetupStepExceedsRangeError;
  }

  // Capability constraint for the field picker based on filter type
  // (slider supports both numeric and temporal — filtered via getOptionDisabled)
  const fieldCapability = filterType === 'date-range' ? 'temporal' : undefined;

  // Finding 8: the picker is fed the FULL field catalog (physical + expression fields)
  // rather than the raw `dataSources` record. `DataSourceFieldSelect`'s `dataSources`
  // branch folds `src.fields` only, so a calculated field could never be chosen as a
  // filter-widget field — with nothing in the UI explaining the absence — even though
  // every other setup panel routes through `buildFieldCatalog`/`buildSourceFieldEntries`.
  // The capability filter that `dataSources` + `filterCapability` used to apply is
  // re-applied here, since `filterCapability` is only honoured on the `dataSources` branch.
  const pickerFields = React.useMemo(
    () =>
      fieldCapability
        ? fieldCatalog.filter((f) => fieldHasCapability(f, fieldCapability))
        : fieldCatalog,
    [fieldCatalog, fieldCapability],
  );

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
        <InputLabel id={controlTypeLabelId}>{localeText.filterSetupControlTypeLabel}</InputLabel>
        <Select
          labelId={controlTypeLabelId}
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
        // Finding 7: the panel already stores which source the configured field belongs to
        // (`config.filterWidgetSourceId`, read by `handleTypeChange` above), so hand it to the
        // picker. Without it the picker resolves the stored id by a bare-id lookup across every
        // source and can display a same-id field from a DIFFERENT source (wrong label, group,
        // and type icon) as if it were the configured value.
        valueSourceId={config.filterWidgetSourceId ?? widget.sourceId}
        onChange={handleFieldChange}
        fields={pickerFields}
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
              error={boundsConflict ? localeText.filterSetupMinAboveMaxError : undefined}
              onCommit={(next) =>
                controller.updateWidgetConfig(widgetId, { filterWidgetMin: next })
              }
            />
            <SliderBoundInput
              widgetId={widgetId}
              value={config.filterWidgetMax}
              label={localeText.filterSetupMaxLabel}
              error={boundsConflict ? localeText.filterSetupMinAboveMaxError : undefined}
              onCommit={(next) =>
                controller.updateWidgetConfig(widgetId, { filterWidgetMax: next })
              }
            />
            <SliderBoundInput
              widgetId={widgetId}
              value={config.filterWidgetStep}
              label={localeText.filterSetupStepLabel}
              error={stepError}
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
