'use client';
import * as React from 'react';
import {
  Box,
  Checkbox,
  Chip,
  InputAdornment,
  ListItemText,
  MenuItem,
  Select,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
  IconButton,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { StudioWidget, StudioDataSource } from '../models';
import {
  useStudioController,
  useStudioSelector,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSource,
  makeSelectActiveInteractiveFilter,
} from '../context';
import { getCachedEnrichedRows } from '../internals/enrichedRowsCache';
import { getCachedNormalizedDataSource } from '../internals/normalizedRowsCache';

// ─── Control prop interfaces ──────────────────────────────────────────────────

export interface StudioFilterDateRangeControlProps {
  label: string;
  fieldId: string;
  currentValue: { from?: string; to?: string } | null;
  onApply: (value: { from?: string; to?: string }) => void;
  onClear: () => void;
}

export interface StudioFilterMultiSelectControlProps {
  label: string;
  values: string[];
  selected: string[];
  onApply: (v: string[]) => void;
  onClear: () => void;
  /** Whether the filter is in exclude (NOT IN) mode. @default false */
  exclude?: boolean;
  /** Called when the user toggles include/exclude mode. */
  onExcludeChange?: (exclude: boolean) => void;
}

export interface StudioFilterToggleControlProps {
  label: string;
  values: string[];
  selected: string[];
  onApply: (v: string[]) => void;
  onClear: () => void;
}

export interface StudioFilterSliderControlProps {
  label: string;
  min: number;
  max: number;
  step: number;
  isDate: boolean;
  currentValue: { from?: number; to?: number } | null;
  onApply: (from: number, to: number) => void;
  onClear: () => void;
}

// ─── Slot interfaces ──────────────────────────────────────────────────────────

export interface StudioFilterWidgetSlots {
  dateRangeControl?: React.ElementType<StudioFilterDateRangeControlProps>;
  multiSelectControl?: React.ElementType<StudioFilterMultiSelectControlProps>;
  toggleControl?: React.ElementType<StudioFilterToggleControlProps>;
  sliderControl?: React.ElementType<StudioFilterSliderControlProps>;
}

export interface StudioFilterWidgetSlotProps {
  dateRangeControl?: Partial<StudioFilterDateRangeControlProps>;
  multiSelectControl?: Partial<StudioFilterMultiSelectControlProps>;
  toggleControl?: Partial<StudioFilterToggleControlProps>;
  sliderControl?: Partial<StudioFilterSliderControlProps>;
}

export interface StudioFilterWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  slots?: StudioFilterWidgetSlots;
  slotProps?: StudioFilterWidgetSlotProps;
}

// ─── Date range control ───────────────────────────────────────────────────────

function DateRangeControl(props: StudioFilterDateRangeControlProps) {
  const { label, fieldId, currentValue, onApply, onClear } = props;
  const [from, setFrom] = React.useState<Dayjs | null>(
    currentValue?.from ? dayjs(currentValue.from) : null,
  );
  const [to, setTo] = React.useState<Dayjs | null>(
    currentValue?.to ? dayjs(currentValue.to) : null,
  );

  // Sync when external value changes (e.g. filter cleared programmatically)
  React.useEffect(() => {
    setFrom(currentValue?.from ? dayjs(currentValue.from) : null);
    setTo(currentValue?.to ? dayjs(currentValue.to) : null);
  }, [currentValue?.from, currentValue?.to]);

  // Debounce onApply so that typing a date character-by-character (e.g. in the text field
  // inside DatePicker) doesn't trigger a full pipeline re-render on every keystroke.
  const pendingApply = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleApply = React.useCallback(
    (value: { from?: string; to?: string }) => {
      if (pendingApply.current !== null) {
        clearTimeout(pendingApply.current);
      }
      pendingApply.current = setTimeout(() => {
        pendingApply.current = null;
        onApply(value);
      }, 300);
    },
    [onApply],
  );
  React.useEffect(
    () => () => {
      if (pendingApply.current !== null) {
        clearTimeout(pendingApply.current);
      }
    },
    [],
  );

  const handleFromChange = (val: Dayjs | null) => {
    setFrom(val);
    scheduleApply({
      from: val?.isValid() ? val.format('YYYY-MM-DD') : undefined,
      to: to?.isValid() ? to.format('YYYY-MM-DD') : undefined,
    });
  };

  const handleToChange = (val: Dayjs | null) => {
    setTo(val);
    scheduleApply({
      from: from?.isValid() ? from.format('YYYY-MM-DD') : undefined,
      to: val?.isValid() ? val.format('YYYY-MM-DD') : undefined,
    });
  };

  const isActive = !!(currentValue?.from || currentValue?.to);

  return (
    <Stack spacing={1} role="group" aria-label={label}>
      {isActive && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title="Clear filter">
            <Box
              component="span"
              role="button"
              tabIndex={0}
              aria-label="Clear date range filter"
              onClick={onClear}
              onKeyDown={(evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  onClear();
                }
              }}
              sx={{
                cursor: 'pointer',
                color: 'text.secondary',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </Box>
          </Tooltip>
        </Box>
      )}
      <Stack direction="row" spacing={1}>
        <DatePicker
          label="From"
          value={from}
          onChange={handleFromChange}
          slotProps={{ textField: { size: 'small', fullWidth: true } }}
          data-field={fieldId}
        />
        <DatePicker
          label="To"
          value={to}
          onChange={handleToChange}
          slotProps={{ textField: { size: 'small', fullWidth: true } }}
        />
      </Stack>
    </Stack>
  );
}

// ─── Multi-select control ─────────────────────────────────────────────────────

function MultiSelectControl(props: StudioFilterMultiSelectControlProps) {
  const { label, values, selected, onApply, onClear, exclude = false, onExcludeChange } = props;
  const [search, setSearch] = React.useState('');
  const isActive = selected.length > 0;

  const filtered = search
    ? values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : values;

  const handleSelectionChange = (newValue: string[]) => {
    if (newValue.length === 0) {
      onClear();
    } else {
      onApply(newValue);
    }
  };

  return (
    <Stack spacing={0.5} role="group" aria-label={label}>
      {isActive && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title="Clear filter">
            <Box
              component="span"
              role="button"
              tabIndex={0}
              aria-label="Clear selection filter"
              onClick={onClear}
              onKeyDown={(evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  onClear();
                }
              }}
              sx={{
                cursor: 'pointer',
                color: 'text.secondary',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </Box>
          </Tooltip>
        </Box>
      )}
      <Select
        multiple
        size="small"
        fullWidth
        value={selected}
        onChange={(evt) => handleSelectionChange(evt.target.value as string[])}
        displayEmpty
        renderValue={(sel) => {
          if ((sel as string[]).length === 0) {
            return <em style={{ opacity: 0.5 }}>All</em>;
          }
          return `${(sel as string[]).length} selected`;
        }}
        MenuProps={{
          slotProps: { paper: { sx: { maxHeight: 320 } } },
          autoFocus: false,
        }}
      >
        {/* Search + bulk actions inside the dropdown */}
        <MenuItem
          disableRipple
          onKeyDown={(evt) => evt.stopPropagation()}
          sx={{ position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper', pb: 0.5 }}
        >
          <Stack spacing={0.5} sx={{ width: '100%' }}>
            <TextField
              size="small"
              fullWidth
              placeholder="Search…"
              value={search}
              onChange={(evt) => setSearch(evt.target.value)}
              onClick={(evt) => evt.stopPropagation()}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon sx={{ fontSize: 16 }} />
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Stack direction="row" spacing={1}>
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label="Select all options"
                onClick={(evt) => {
                  evt.stopPropagation();
                  handleSelectionChange(values);
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    handleSelectionChange(values);
                  }
                }}
                sx={{ cursor: 'pointer', color: 'primary.main', fontSize: 12 }}
              >
                Select all
              </Box>
              <Typography variant="caption" color="text.disabled">
                ·
              </Typography>
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label="Clear all selections"
                onClick={(evt) => {
                  evt.stopPropagation();
                  onClear();
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    onClear();
                  }
                }}
                sx={{ cursor: 'pointer', color: 'text.secondary', fontSize: 12 }}
              >
                Clear all
              </Box>
            </Stack>
            {onExcludeChange && (
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label={exclude ? 'Switch to include mode' : 'Switch to exclude mode'}
                aria-pressed={exclude}
                onClick={(evt) => {
                  evt.stopPropagation();
                  onExcludeChange(!exclude);
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    onExcludeChange(!exclude);
                  }
                }}
                sx={{
                  cursor: 'pointer',
                  fontSize: 12,
                  color: exclude ? 'error.main' : 'text.secondary',
                  mt: 0.5,
                }}
              >
                {exclude ? '⊘ Excluding selected' : 'Exclude selected'}
              </Box>
            )}
          </Stack>
        </MenuItem>
        {filtered.map((v) => (
          <MenuItem key={v} value={v} dense>
            <Checkbox
              size="small"
              checked={selected.includes(v)}
              sx={{ p: 0.5, mr: 0.5 }}
              slotProps={{ input: { 'aria-label': v } }}
            />
            <ListItemText primary={v} />
          </MenuItem>
        ))}
        {filtered.length === 0 && (
          <MenuItem disabled>
            <Typography variant="caption" color="text.secondary">
              No options found
            </Typography>
          </MenuItem>
        )}
      </Select>
    </Stack>
  );
}

// ─── Toggle (chip) control ────────────────────────────────────────────────────

function ToggleControl(props: StudioFilterToggleControlProps) {
  const { label, values, selected, onApply, onClear } = props;
  const isActive = selected.length > 0;

  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v];
    if (next.length === 0) {
      onClear();
    } else {
      onApply(next);
    }
  };

  return (
    <Stack spacing={1} role="group" aria-label={label}>
      {isActive && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title="Clear filter">
            <Box
              component="span"
              role="button"
              tabIndex={0}
              aria-label="Clear toggle filter"
              onClick={onClear}
              onKeyDown={(evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  onClear();
                }
              }}
              sx={{
                cursor: 'pointer',
                color: 'text.secondary',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </Box>
          </Tooltip>
        </Box>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
        {values.map((v) => (
          <Chip
            key={v}
            label={v}
            size="small"
            color={selected.includes(v) ? 'primary' : 'default'}
            onClick={() => toggle(v)}
            aria-pressed={selected.includes(v)}
          />
        ))}
      </Box>
    </Stack>
  );
}

// ─── Slider (numeric or date range) control ───────────────────────────────────

function SliderControl(props: StudioFilterSliderControlProps) {
  const { label, min, max, step, isDate, currentValue, onApply, onClear } = props;
  const [localValue, setLocalValue] = React.useState<[number, number]>([
    currentValue?.from ?? min,
    currentValue?.to ?? max,
  ]);

  React.useEffect(() => {
    setLocalValue([currentValue?.from ?? min, currentValue?.to ?? max]);
  }, [currentValue?.from, currentValue?.to, min, max]);

  const isActive = localValue[0] !== min || localValue[1] !== max;

  const handleSliderChange = (_event: Event, newValue: number | number[]) => {
    setLocalValue(newValue as [number, number]);
  };

  const handleChangeCommitted = (
    _event: React.SyntheticEvent | Event,
    newValue: number | number[],
  ) => {
    const [lo, hi] = newValue as [number, number];
    if (lo === min && hi === max) {
      onClear();
    } else {
      onApply(lo, hi);
    }
  };

  const formatLabel = (v: number) => (isDate ? dayjs(v).format('DD MMM YYYY') : v.toLocaleString());

  return (
    /* Prevent drag-and-drop of the widget card when interacting with the slider */
    <Box role="group" aria-label={label} sx={{ px: 1 }} data-no-drag>
      <Slider
        size="small"
        value={localValue}
        onChange={handleSliderChange}
        onChangeCommitted={handleChangeCommitted}
        min={min}
        max={max}
        step={step}
        valueLabelDisplay="auto"
        valueLabelFormat={formatLabel}
        aria-label={label}
        sx={{ display: 'block' }}
      />
    </Box>
  );
}

// ─── Main filter widget ───────────────────────────────────────────────────────

export const StudioFilterWidget = React.memo(function StudioFilterWidget(
  props: StudioFilterWidgetProps,
) {
  const { widget, dataSource, slots, slotProps } = props;
  const { config } = widget;
  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);

  const filterWidgetType = config.filterWidgetType ?? 'multi-select';
  const fieldId = config.filterWidgetField ?? '';

  // Normalize the data source lazily for just this filter field.
  // Provides pre-computed fieldDistinctValues[fieldId] for the fast path in
  // distinctValues below, without normalizing the entire source.
  const normalizedDataSource = React.useMemo(() => {
    if (!dataSource || !fieldId) {
      return dataSource;
    }
    return getCachedNormalizedDataSource(dataSource, new Set([fieldId]));
  }, [dataSource, fieldId]);

  // Resolve the field definition
  const field = React.useMemo(() => {
    if (!fieldId || !normalizedDataSource) {
      return undefined;
    }
    return (
      normalizedDataSource.fields.find((f) => f.id === fieldId) ??
      expressionFields.find((ef) => ef.id === fieldId && ef.sourceId === widget.sourceId)
    );
  }, [fieldId, normalizedDataSource, expressionFields, widget.sourceId]);

  const rows = React.useMemo(() => {
    if (!normalizedDataSource?.rows) {
      return [];
    }

    // Only enrich if the field being filtered on is a computed expression field.
    // Native fields (country, region, etc.) don't require enrichment — enriching
    // 100k rows just to scan a native field allocates N spread objects unnecessarily.
    const fieldIsExpression =
      fieldId !== '' &&
      expressionFields.some(
        (ef) => ef.id === fieldId && ef.sourceId === widget.sourceId && !ef.isMeasure,
      );

    if (!fieldIsExpression) {
      return normalizedDataSource.rows;
    }

    return getCachedEnrichedRows(
      normalizedDataSource.rows,
      widget.sourceId,
      expressionFields,
      dataSources,
      relationships,
      new Set([fieldId]),
    );
  }, [
    normalizedDataSource,
    expressionFields,
    fieldId,
    widget.sourceId,
    dataSources,
    relationships,
  ]);

  const label = widget.title || field?.label || fieldId || '';

  // Current interactive filter value for this widget (stable selector, not inline arrow)
  const selectActiveFilter = React.useMemo(
    () => makeSelectActiveInteractiveFilter(widget.id),
    [widget.id],
  );
  const activeFilter = useStudioSelector(selectActiveFilter);

  // Compute distinct values for select/toggle controls
  const distinctValues = React.useMemo(() => {
    if (
      (filterWidgetType !== 'multi-select' && filterWidgetType !== 'toggle') ||
      !fieldId ||
      rows.length === 0
    ) {
      return [];
    }
    // Fast path: use the pre-computed index built lazily for this filter field.
    // O(1) rather than O(N).
    const precomputed = normalizedDataSource?.fieldDistinctValues?.[fieldId];
    if (precomputed) {
      return precomputed;
    }
    // Slow path: scan enriched rows (required for expression fields).
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row[fieldId];
      if (v != null && String(v) !== '') {
        seen.add(String(v));
      }
    }
    return Array.from(seen).sort();
  }, [filterWidgetType, fieldId, rows, normalizedDataSource?.fieldDistinctValues]);

  // Compute min/max for slider from data when not configured explicitly
  const isDateField =
    filterWidgetType === 'slider' && (field?.type === 'date' || field?.type === 'datetime');

  const { autoMin, autoMax } = React.useMemo(() => {
    if (filterWidgetType !== 'slider' || !fieldId || rows.length === 0) {
      return { autoMin: 0, autoMax: 100 };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of rows) {
      const raw = row[fieldId];
      const v = isDateField ? dayjs(raw as string).valueOf() : Number(raw);
      if (Number.isFinite(v)) {
        if (v < lo) {
          lo = v;
        }
        if (v > hi) {
          hi = v;
        }
      }
    }
    return {
      autoMin: Number.isFinite(lo) ? lo : 0,
      autoMax: Number.isFinite(hi) ? hi : 100,
    };
  }, [filterWidgetType, fieldId, rows, isDateField]);

  const sliderMin = config.filterWidgetMin ?? autoMin;
  const sliderMax = config.filterWidgetMax ?? autoMax;
  const MS_PER_DAY = 86_400_000;
  const autoSliderStep =
    sliderMax - sliderMin > 100 ? Math.round((sliderMax - sliderMin) / 100) : 1;
  const sliderStep = config.filterWidgetStep ?? (isDateField ? MS_PER_DAY : autoSliderStep);

  const handleClear = React.useCallback(() => {
    controller.clearInteractiveFilter(widget.id);
  }, [controller, widget.id]);

  const DateRangeControlComponent = slots?.dateRangeControl ?? DateRangeControl;
  const MultiSelectControlComponent = slots?.multiSelectControl ?? MultiSelectControl;
  const ToggleControlComponent = slots?.toggleControl ?? ToggleControl;
  const SliderControlComponent = slots?.sliderControl ?? SliderControl;

  if (!fieldId) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          No field configured. Select a field in the Compose panel.
        </Typography>
      </Box>
    );
  }

  // Always pass filterSourceId so cross-source filtering works when this widget's
  // source differs from a chart/KPI/grid's source (e.g. customers → orders join).
  const filterSourceId = widget.sourceId;

  if (filterWidgetType === 'date-range') {
    const val = (activeFilter?.value as { from?: string; to?: string } | null) ?? null;
    const managedOnApply = (value: { from?: string; to?: string }) => {
      if (!value.from && !value.to) {
        handleClear();
        return;
      }
      controller.applyInteractiveFilter(widget.id, fieldId, 'between', value, {
        fieldType: field?.type ?? 'date',
        filterSourceId,
      });
    };
    return (
      <DateRangeControlComponent
        label={label}
        fieldId={fieldId}
        currentValue={val}
        {...slotProps?.dateRangeControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'multi-select') {
    const selected = (activeFilter?.value as string[] | undefined) ?? [];
    const exclude = activeFilter?.operator === 'not_in';
    const managedOnApply = (v: string[], op: 'in' | 'not_in' = exclude ? 'not_in' : 'in') => {
      if (v.length === 0) {
        handleClear();
        return;
      }
      controller.applyInteractiveFilter(widget.id, fieldId, op, v, {
        filterMode: 'selection',
        fieldType: field?.type ?? 'string',
        filterSourceId,
      });
    };
    const managedOnExcludeChange = (nextExclude: boolean) => {
      const op = nextExclude ? 'not_in' : 'in';
      if (selected.length > 0) {
        managedOnApply(selected, op);
      }
    };
    return (
      <MultiSelectControlComponent
        label={label}
        values={distinctValues}
        selected={selected}
        exclude={exclude}
        onExcludeChange={managedOnExcludeChange}
        {...slotProps?.multiSelectControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'toggle') {
    const selected = (activeFilter?.value as string[] | undefined) ?? [];
    const managedOnApply = (v: string[]) => {
      controller.applyInteractiveFilter(widget.id, fieldId, 'in', v, {
        filterMode: 'selection',
        fieldType: field?.type ?? 'string',
        filterSourceId,
      });
    };
    return (
      <ToggleControlComponent
        label={label}
        values={distinctValues}
        selected={selected}
        {...slotProps?.toggleControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'slider') {
    // The filter stores dates as ISO strings; convert back to timestamps for the numeric slider.
    const rawVal = activeFilter?.value as
      | { from?: string | number; to?: string | number }
      | null
      | undefined;
    let val: { from?: number; to?: number } | null;
    if (rawVal == null) {
      val = null;
    } else if (isDateField) {
      val = {
        from: rawVal.from != null ? dayjs(rawVal.from as string).valueOf() : undefined,
        to: rawVal.to != null ? dayjs(rawVal.to as string).valueOf() : undefined,
      };
    } else {
      val = rawVal as { from?: number; to?: number };
    }
    const fieldType = isDateField ? (field?.type ?? 'date') : 'number';
    const managedOnApply = (lo: number, hi: number) => {
      // For date sliders, convert timestamps back to ISO strings for filter matching
      const from = isDateField ? dayjs(lo).format('YYYY-MM-DD') : lo;
      const to = isDateField ? dayjs(hi).format('YYYY-MM-DD') : hi;
      controller.applyInteractiveFilter(
        widget.id,
        fieldId,
        'between',
        { from, to },
        {
          fieldType,
          filterSourceId,
        },
      );
    };
    return (
      <SliderControlComponent
        label={label}
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        isDate={isDateField}
        currentValue={val ?? null}
        {...slotProps?.sliderControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  return null;
});
