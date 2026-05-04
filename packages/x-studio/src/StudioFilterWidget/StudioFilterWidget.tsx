'use client';
import * as React from 'react';
import {
  Box,
  Checkbox,
  Chip,
  InputAdornment,
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
    <Stack spacing={1}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        {isActive && (
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
        )}
      </Box>
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
  const filtered = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));

  const toggle = (v: string) => {
    const next = selected.includes(v)
      ? selected.filter((s) => s !== v)
      : [...selected, v];
    onApply(next);
  };

  const isActive = selected.length > 0;

  return (
    <Stack spacing={1}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        {isActive && (
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
        )}
      </Box>
      {values.length > 6 && (
        <TextField
          size="small"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
      )}
      <Box
        sx={{
          maxHeight: 200,
          overflowY: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
        }}
      >
        {filtered.length === 0 ? (
          <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
            No options found.
          </Typography>
        ) : (
          filtered.map((v) => (
            <Box
              key={v}
              sx={{ display: 'flex', alignItems: 'center', px: 0.5, cursor: 'pointer' }}
              onClick={() => toggle(v)}
            >
              <Checkbox
                size="small"
                checked={selected.includes(v)}
                onChange={() => toggle(v)}
                onClick={(e) => e.stopPropagation()}
                sx={{ p: 0.5 }}
                slotProps={{ input: { 'aria-label': v } }}
              />
              <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0, ml: 0.5 }}>
                {v}
              </Typography>
            </Box>
          ))
        )}
      </Box>
      {isActive && (
        <Typography variant="caption" color="text.secondary">
          {selected.length} selected
        </Typography>
      )}
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
    <Stack spacing={1}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        {isActive && (
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
        )}
      </Box>
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

// ─── Slider (numeric range) control ──────────────────────────────────────────

function SliderControl({
  label,
  min,
  max,
  step,
  currentValue,
  onApply,
  onClear,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  currentValue: { from?: number; to?: number } | null;
  onApply: (from: number, to: number) => void;
  onClear: () => void;
}) {
  const [localValue, setLocalValue] = React.useState<[number, number]>([
    currentValue?.from ?? min,
    currentValue?.to ?? max,
  ]);

  // Sync when external value is cleared
  React.useEffect(() => {
    setLocalValue([currentValue?.from ?? min, currentValue?.to ?? max]);
  }, [currentValue?.from, currentValue?.to, min, max]);

  const isActive = localValue[0] !== min || localValue[1] !== max;

  const handleChange = (_event: Event, newValue: number | number[]) => {
    const [lo, hi] = newValue as [number, number];
    setLocalValue([lo, hi]);
  };

  const handleChangeCommitted = (_event: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const [lo, hi] = newValue as [number, number];
    if (lo === min && hi === max) {
      onClear();
    } else {
      onApply(lo, hi);
    }
  };

  return (
    <Stack spacing={0.5}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        {isActive && (
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
        )}
      </Box>
      <Box sx={{ px: 1 }}>
        <Slider
          value={localValue}
          onChange={handleChange}
          onChangeCommitted={handleChangeCommitted}
          min={min}
          max={max}
          step={step}
          valueLabelDisplay="auto"
          aria-label={label}
        />
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">
          {localValue[0].toLocaleString()}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {localValue[1].toLocaleString()}
        </Typography>
      </Box>
    </Stack>
  );
}

// ─── Search (text) control ────────────────────────────────────────────────────

function SearchControl({
  label,
  fieldId,
  currentValue,
  onApply,
  onClear,
}: {
  label: string;
  fieldId: string;
  currentValue: string;
  onApply: (v: string) => void;
  onClear: () => void;
}) {
  const [localValue, setLocalValue] = React.useState(currentValue);

  React.useEffect(() => {
    setLocalValue(currentValue);
  }, [currentValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocalValue(v);
    if (v.trim() === '') {
      onClear();
    } else {
      onApply(v.trim());
    }
  };

  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <TextField
        size="small"
        fullWidth
        placeholder={`Search ${label}…`}
        value={localValue}
        onChange={handleChange}
        data-field={fieldId}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 16 }} />
              </InputAdornment>
            ),
            endAdornment: localValue ? (
              <InputAdornment position="end">
                <Box
                  component="span"
                  role="button"
                  tabIndex={0}
                  aria-label="Clear search"
                  onClick={() => { setLocalValue(''); onClear(); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setLocalValue(''); onClear(); } }}
                  sx={{ cursor: 'pointer', color: 'text.secondary', display: 'flex' }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </Box>
              </InputAdornment>
            ) : null,
          },
        }}
      />
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

  const filterWidgetType = config.filterWidgetType ?? 'multi-select';
  const fieldId = config.filterWidgetField ?? '';

  // Resolve the field definition
  const field = React.useMemo(() => {
    if (!fieldId || !dataSource) {
      return undefined;
    }
    return dataSource.fields.find((f) => f.id === fieldId);
  }, [fieldId, dataSource]);

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
      !dataSource?.rows
    ) {
      return [];
    }
    const seen = new Set<string>();
    for (const row of dataSource.rows) {
      const v = row[fieldId];
      if (v != null && String(v) !== '') {
        seen.add(String(v));
      }
    }
    return Array.from(seen).sort();
  }, [filterWidgetType, fieldId, dataSource]);

  // Compute min/max for slider from data when not configured explicitly
  const { autoMin, autoMax } = React.useMemo(() => {
    if (filterWidgetType !== 'slider' || !fieldId || !dataSource?.rows) {
      return { autoMin: 0, autoMax: 100 };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of dataSource.rows) {
      const v = Number(row[fieldId]);
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return {
      autoMin: Number.isFinite(lo) ? lo : 0,
      autoMax: Number.isFinite(hi) ? hi : 100,
    };
  }, [filterWidgetType, fieldId, dataSource]);

  const sliderMin = config.filterWidgetMin ?? autoMin;
  const sliderMax = config.filterWidgetMax ?? autoMax;
  const sliderStep = config.filterWidgetStep ?? (sliderMax - sliderMin > 100 ? Math.round((sliderMax - sliderMin) / 100) : 1);

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
    const val = activeFilter?.value as { from?: number; to?: number } | null | undefined;
    return (
      <SliderControl
        label={label}
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        currentValue={val ?? null}
        onApply={(lo, hi) => {
          controller.applyInteractiveFilter(widget.id, fieldId, 'between', { from: lo, to: hi }, {
            fieldType: 'number',
            filterSourceId,
          });
        }}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'search') {
    const val = typeof activeFilter?.value === 'string' ? activeFilter.value : '';
    return (
      <SearchControl
        label={label}
        fieldId={fieldId}
        currentValue={val}
        onApply={(v) => {
          controller.applyInteractiveFilter(widget.id, fieldId, 'contains', v, {
            fieldType: 'string',
            filterSourceId,
          });
        }}
        onClear={handleClear}
      />
    );
  }

  return null;
});
