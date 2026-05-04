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
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { StudioWidget, StudioDataSource } from '../models';
import { useStudioController, useStudioSelector } from '../context';
import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';

export interface StudioFilterWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
}

// ─── Date range control ───────────────────────────────────────────────────────

function DateRangeControl({
  label,
  fieldId,
  currentValue,
  onApply,
  onClear,
}: {
  label: string;
  fieldId: string;
  currentValue: { from?: string; to?: string } | null;
  onApply: (value: { from?: string; to?: string }) => void;
  onClear: () => void;
}) {
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

  const handleFromChange = (val: Dayjs | null) => {
    setFrom(val);
    onApply({
      from: val?.isValid() ? val.format('YYYY-MM-DD') : undefined,
      to: to?.isValid() ? to.format('YYYY-MM-DD') : undefined,
    });
  };

  const handleToChange = (val: Dayjs | null) => {
    setTo(val);
    onApply({
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
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClear(); }}
              sx={{ cursor: 'pointer', color: 'text.secondary', display: 'flex', alignItems: 'center' }}
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

function MultiSelectControl({
  label,
  values,
  selected,
  onApply,
  onClear,
}: {
  label: string;
  values: string[];
  selected: string[];
  onApply: (v: string[]) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = React.useState('');
  const isActive = selected.length > 0;

  const filtered = search
    ? values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : values;

  const handleChange = (newValue: string[]) => {
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
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClear(); }}
              sx={{ cursor: 'pointer', color: 'text.secondary', display: 'flex', alignItems: 'center' }}
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
        onChange={(e) => handleChange(e.target.value as string[])}
        displayEmpty
        renderValue={(sel) => {
          if ((sel as string[]).length === 0) return <em style={{ opacity: 0.5 }}>All</em>;
          return `${(sel as string[]).length} selected`;
        }}
        MenuProps={{
          slotProps: { paper: { sx: { maxHeight: 320 } } },
          autoFocus: false,
        }}
      >
        {/* Search inside the dropdown */}
        <MenuItem
          disableRipple
          onKeyDown={(e) => e.stopPropagation()}
          sx={{ position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper', pb: 0.5 }}
        >
          <TextField
            size="small"
            fullWidth
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
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

function ToggleControl({
  label,
  values,
  selected,
  onApply,
  onClear,
}: {
  label: string;
  values: string[];
  selected: string[];
  onApply: (v: string[]) => void;
  onClear: () => void;
}) {
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
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClear(); }}
              sx={{ cursor: 'pointer', color: 'text.secondary', display: 'flex', alignItems: 'center' }}
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

function SliderControl({
  label,
  min,
  max,
  step,
  isDate,
  currentValue,
  onApply,
  onClear,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  isDate: boolean;
  currentValue: { from?: number; to?: number } | null;
  onApply: (from: number, to: number) => void;
  onClear: () => void;
}) {
  const [localValue, setLocalValue] = React.useState<[number, number]>([
    currentValue?.from ?? min,
    currentValue?.to ?? max,
  ]);

  React.useEffect(() => {
    setLocalValue([currentValue?.from ?? min, currentValue?.to ?? max]);
  }, [currentValue?.from, currentValue?.to, min, max]);

  const isActive = localValue[0] !== min || localValue[1] !== max;

  const handleChange = (_event: Event, newValue: number | number[]) => {
    setLocalValue(newValue as [number, number]);
  };

  const handleChangeCommitted = (_event: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const [lo, hi] = newValue as [number, number];
    if (lo === min && hi === max) {
      onClear();
    } else {
      onApply(lo, hi);
    }
  };

  const formatLabel = (v: number) =>
    isDate ? dayjs(v).format('D MMM YYYY') : v.toLocaleString();

  return (
    <Stack spacing={0.5} role="group" aria-label={label}>
      {isActive && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title="Clear filter">
            <Box
              component="span"
              role="button"
              tabIndex={0}
              aria-label="Clear slider filter"
              onClick={onClear}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClear(); }}
              sx={{ cursor: 'pointer', color: 'text.secondary', display: 'flex', alignItems: 'center' }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </Box>
          </Tooltip>
        </Box>
      )}
      {/* Stop pointer events from bubbling to the widget card's drag handler */}
      <Box sx={{ px: 1 }} onPointerDown={(e) => e.stopPropagation()}>
        <Slider
          value={localValue}
          onChange={handleChange}
          onChangeCommitted={handleChangeCommitted}
          min={min}
          max={max}
          step={step}
          valueLabelDisplay="auto"
          valueLabelFormat={formatLabel}
          aria-label={label}
        />
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">
          {formatLabel(localValue[0])}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatLabel(localValue[1])}
        </Typography>
      </Box>
    </Stack>
  );
}

// ─── Main filter widget ───────────────────────────────────────────────────────

export const StudioFilterWidget = React.memo(function StudioFilterWidget(
  props: StudioFilterWidgetProps,
) {
  const { widget, dataSource } = props;
  const { config } = widget;
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);
  const relationships = useStudioSelector((state) => state.relationships);
  const expressionFields = useStudioSelector((state) => state.expressionFields);

  const filterWidgetType = config.filterWidgetType ?? 'multi-select';
  const fieldId = config.filterWidgetField ?? '';

  // Resolve the field definition
  const field = React.useMemo(() => {
    if (!fieldId || !dataSource) {
      return undefined;
    }
    return (
      dataSource.fields.find((f) => f.id === fieldId) ??
      expressionFields.find((ef) => ef.id === fieldId && ef.sourceId === widget.sourceId)
    );
  }, [fieldId, dataSource, expressionFields, widget.sourceId]);

  const rows = React.useMemo(() => {
    if (!dataSource?.rows) {
      return [];
    }

    if (expressionFields.length === 0) {
      return dataSource.rows;
    }

    return enrichRowsWithExpressions(
      dataSource.rows,
      expressionFields,
      widget.sourceId,
      dataSources,
      relationships,
    );
  }, [dataSource?.rows, expressionFields, widget.sourceId, dataSources, relationships]);

  const label = config.filterWidgetLabel ?? field?.label ?? fieldId ?? 'Filter';

  // Current interactive filter value for this widget
  const activeFilter = useStudioSelector((state) =>
    state.filters.find((f) => f.scope === 'interactive' && f.sourceWidgetId === widget.id),
  );

  // Compute distinct values for select/toggle controls
  const distinctValues = React.useMemo(() => {
    if (
      (filterWidgetType !== 'multi-select' && filterWidgetType !== 'toggle') ||
      !fieldId ||
      rows.length === 0
    ) {
      return [];
    }
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row[fieldId];
      if (v != null && String(v) !== '') {
        seen.add(String(v));
      }
    }
    return Array.from(seen).sort();
  }, [filterWidgetType, fieldId, rows]);

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
        if (v < lo) lo = v;
        if (v > hi) hi = v;
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
  const sliderStep =
    config.filterWidgetStep ??
    (isDateField
      ? MS_PER_DAY // default to 1-day steps for date sliders
      : sliderMax - sliderMin > 100
        ? Math.round((sliderMax - sliderMin) / 100)
        : 1);

  const handleClear = React.useCallback(() => {
    controller.clearInteractiveFilter(widget.id);
  }, [controller, widget.id]);

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
    return (
      <DateRangeControl
        label={label}
        fieldId={fieldId}
        currentValue={val}
        onApply={(value) => {
          if (!value.from && !value.to) {
            handleClear();
            return;
          }
          controller.applyInteractiveFilter(widget.id, fieldId, 'between', value, {
            fieldType: field?.type ?? 'date',
            filterSourceId,
          });
        }}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'multi-select') {
    const selected = (activeFilter?.value as string[] | undefined) ?? [];
    return (
      <MultiSelectControl
        label={label}
        values={distinctValues}
        selected={selected}
        onApply={(v) => {
          if (v.length === 0) {
            handleClear();
            return;
          }
          controller.applyInteractiveFilter(widget.id, fieldId, 'in', v, {
            filterMode: 'selection',
            fieldType: field?.type ?? 'string',
            filterSourceId,
          });
        }}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'toggle') {
    const selected = (activeFilter?.value as string[] | undefined) ?? [];
    return (
      <ToggleControl
        label={label}
        values={distinctValues}
        selected={selected}
        onApply={(v) => {
          controller.applyInteractiveFilter(widget.id, fieldId, 'in', v, {
            filterMode: 'selection',
            fieldType: field?.type ?? 'string',
            filterSourceId,
          });
        }}
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
    const val: { from?: number; to?: number } | null =
      rawVal == null
        ? null
        : isDateField
          ? {
              from: rawVal.from != null ? dayjs(rawVal.from as string).valueOf() : undefined,
              to: rawVal.to != null ? dayjs(rawVal.to as string).valueOf() : undefined,
            }
          : (rawVal as { from?: number; to?: number });
    const fieldType = isDateField ? (field?.type ?? 'date') : 'number';
    return (
      <SliderControl
        label={label}
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        isDate={isDateField}
        currentValue={val ?? null}
        onApply={(lo, hi) => {
          // For date sliders, convert timestamps back to ISO strings for filter matching
          const from = isDateField ? dayjs(lo).format('YYYY-MM-DD') : lo;
          const to = isDateField ? dayjs(hi).format('YYYY-MM-DD') : hi;
          controller.applyInteractiveFilter(widget.id, fieldId, 'between', { from, to }, {
            fieldType,
            filterSourceId,
          });
        }}
        onClear={handleClear}
      />
    );
  }

  return null;
});
