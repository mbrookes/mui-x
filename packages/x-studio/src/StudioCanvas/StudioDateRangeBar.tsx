'use client';
import * as React from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import {
  useStudioController,
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectActivePageId,
} from '../context';
import type { StudioDateRangePreset, StudioFilterState } from '../models';

// ─── Preset configuration ────────────────────────────────────────────────────

const DATE_RANGE_PRESETS: Array<{ value: StudioDateRangePreset | 'all_time'; label: string }> = [
  { value: 'all_time', label: 'All time' },
  { value: 'ytd', label: 'YTD' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_3_months', label: 'Last 3 months' },
  { value: 'last_12_months', label: 'Last 12 months' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface DateField {
  fieldId: string;
  sourceId: string;
  label: string;
  type: 'date' | 'datetime';
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Compact date range toolbar rendered above the canvas.
 * Lets the user pick a date/datetime field and a preset range to filter all
 * widgets on the active page at once.
 *
 * Only rendered when at least one date or datetime field exists in any data source.
 */
export function StudioDateRangeBar() {
  const controller = useStudioController();
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const activePageId = useStudioSelector(selectActivePageId);

  // ── Derive the active date-range filter for this page ─────────────────────
  const dateRangeFilter = React.useMemo(
    () =>
      (filters as StudioFilterState[]).find(
        (f) => f.isDashboardDateRange && (!f.pageId || f.pageId === activePageId),
      ) ?? null,
    [filters, activePageId],
  );

  // ── Build the list of date/datetime fields ────────────────────────────────
  const dateFields = React.useMemo<DateField[]>(() => {
    const result: DateField[] = [];
    for (const source of Object.values(dataSources)) {
      for (const field of source.fields) {
        if ((field.type === 'date' || field.type === 'datetime') && !field.hidden) {
          result.push({
            fieldId: field.id,
            sourceId: source.id,
            label:
              Object.keys(dataSources).length > 1
                ? `${source.label} · ${field.label}`
                : field.label,
            type: field.type,
          });
        }
      }
    }
    return result;
  }, [dataSources]);

  // ── Local state: keep the field selection even when preset = "All time" ───
  const [localFieldKey, setLocalFieldKey] = React.useState<string>('');

  // Seed local field from the active filter on first render / when filter changes
  React.useEffect(() => {
    if (dateRangeFilter) {
      const key = `${dateRangeFilter.filterSourceId ?? ''}.${dateRangeFilter.field}`;
      setLocalFieldKey(key);
    }
  }, [dateRangeFilter]);

  if (dateFields.length === 0) {
    return null;
  }

  // ── Derived selection values ──────────────────────────────────────────────
  const activePreset: StudioDateRangePreset | 'all_time' = dateRangeFilter?.dateRangePreset ?? 'all_time';

  // Build a stable composite key for each field
  const fieldKey = (f: DateField) => `${f.sourceId}.${f.fieldId}`;

  const effectiveFieldKey = localFieldKey || (dateFields[0] ? fieldKey(dateFields[0]) : '');
  const selectedField = dateFields.find((f) => fieldKey(f) === effectiveFieldKey) ?? null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const applyRange = (
    field: DateField,
    preset: StudioDateRangePreset | 'all_time',
  ) => {
    if (preset === 'all_time') {
      controller.setDashboardDateRange(activePageId, null, null, null, null);
      return;
    }
    if (preset === 'custom') {
      return; // custom dates must be provided explicitly — no-op here
    }
    // Let the controller compute the dates from the preset
    controller.setDashboardDateRange(
      activePageId,
      field.fieldId,
      field.sourceId,
      field.type,
      preset,
    );
  };

  const handleFieldChange = (key: string) => {
    setLocalFieldKey(key);
    const field = dateFields.find((f) => fieldKey(f) === key);
    if (!field) {
      return;
    }
    if (activePreset !== 'all_time') {
      applyRange(field, activePreset);
    }
  };

  const handlePresetChange = (_: React.MouseEvent, value: string | null) => {
    if (!value) {
      return;
    }
    const preset = value as StudioDateRangePreset | 'all_time';
    const field = selectedField;
    if (preset === 'all_time') {
      controller.setDashboardDateRange(activePageId, null, null, null, null);
      return;
    }
    if (!field) {
      return;
    }
    applyRange(field, preset);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1.5,
        py: 0.75,
        borderBottom: 1,
        borderColor: 'divider',
        backgroundColor: 'background.paper',
        flexWrap: 'wrap',
      }}
    >
      <CalendarMonthIcon fontSize="small" color="action" sx={{ flexShrink: 0 }} />

      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        Date range
      </Typography>

      {/* Field selector */}
      <FormControl size="small" sx={{ minWidth: 160 }}>
        <InputLabel id="date-range-field-label" sx={{ fontSize: '0.8rem' }}>
          Field
        </InputLabel>
        <Select
          labelId="date-range-field-label"
          label="Field"
          value={effectiveFieldKey}
          onChange={(e) => handleFieldChange(e.target.value)}
          sx={{ fontSize: '0.8rem' }}
        >
          {dateFields.map((f) => (
            <MenuItem key={fieldKey(f)} value={fieldKey(f)} sx={{ fontSize: '0.8rem' }}>
              {f.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Preset toggle buttons */}
      <ToggleButtonGroup
        value={activePreset}
        exclusive
        onChange={handlePresetChange}
        size="small"
        aria-label="Date range preset"
        sx={{ flexShrink: 0 }}
      >
        {DATE_RANGE_PRESETS.map((p) => (
          <ToggleButton
            key={p.value}
            value={p.value}
            sx={{ px: 1.25, py: 0.375, fontSize: '0.75rem', textTransform: 'none' }}
          >
            {p.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}
