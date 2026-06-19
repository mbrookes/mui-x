'use client';
import * as React from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  ListSubheader,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectFilters,
  selectDataSources,
  selectActivePageId,
} from '../../context';
import type { StudioDateRangePreset, StudioFilterState } from '../../models';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DateField {
  fieldId: string;
  sourceId: string;
  label: string;
  type: 'date' | 'datetime';
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Build a stable composite key for each date field. */
const fieldKey = (f: DateField) => `${f.sourceId}.${f.fieldId}`;

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
  const localeText = useStudioLocaleText();

  const dateRangePresetGroups = React.useMemo(
    () => [
      {
        label: localeText.dateRangePresetGroupRolling,
        options: [
          { value: 'all_time' as const, label: localeText.dateRangePresetAllTime },
          { value: 'this_month' as const, label: localeText.dateRangePresetThisMonth },
          { value: 'last_3_months' as const, label: localeText.dateRangePresetLast3Months },
          { value: 'last_12_months' as const, label: localeText.dateRangePresetLast12Months },
          { value: 'ytd' as const, label: localeText.dateRangePresetYTD },
        ],
      },
      {
        label: localeText.dateRangePresetGroupCalendarYear,
        options: [
          {
            value: 'this_calendar_year' as const,
            label: localeText.dateRangePresetThisCalendarYear,
          },
          {
            value: 'last_calendar_year' as const,
            label: localeText.dateRangePresetLastCalendarYear,
          },
          {
            value: 'last_2_calendar_years' as const,
            label: localeText.dateRangePresetLast2CalendarYears,
          },
        ],
      },
      {
        label: localeText.dateRangePresetGroupQuarter,
        options: [
          { value: 'this_quarter' as const, label: localeText.dateRangePresetThisQuarter },
          { value: 'last_quarter' as const, label: localeText.dateRangePresetLastQuarter },
          {
            value: 'this_and_last_quarter' as const,
            label: localeText.dateRangePresetThisAndLastQuarter,
          },
        ],
      },
    ],
    [localeText],
  );

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
  const activePreset: StudioDateRangePreset | 'all_time' =
    dateRangeFilter?.dateRangePreset ?? 'all_time';

  const effectiveFieldKey = localFieldKey || (dateFields[0] ? fieldKey(dateFields[0]) : '');
  const selectedField = dateFields.find((f) => fieldKey(f) === effectiveFieldKey) ?? null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const applyRange = (field: DateField, preset: StudioDateRangePreset | 'all_time') => {
    if (preset === 'all_time') {
      controller.setDashboardDateRange(activePageId, null, null, null, null);
      return;
    }
    if (preset === 'custom') {
      return; // custom dates must be provided explicitly — no-op here
    }
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

  const handlePresetChange = (value: string) => {
    const preset = value as StudioDateRangePreset | 'all_time';
    if (preset === 'all_time') {
      controller.setDashboardDateRange(activePageId, null, null, null, null);
      return;
    }
    if (!selectedField) {
      return;
    }
    applyRange(selectedField, preset);
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
        {localeText.dateRangeBarFieldLabel}
      </Typography>

      {/* Field selector */}
      <FormControl size="small" sx={{ minWidth: 160 }}>
        <InputLabel id="date-range-field-label" sx={{ fontSize: '0.8rem' }}>
          {localeText.filterFieldLabel}
        </InputLabel>
        <Select
          labelId="date-range-field-label"
          label={localeText.filterFieldLabel}
          value={effectiveFieldKey}
          onChange={(event) => handleFieldChange(event.target.value)}
          sx={{ fontSize: '0.8rem' }}
        >
          {dateFields.map((f) => (
            <MenuItem key={fieldKey(f)} value={fieldKey(f)} sx={{ fontSize: '0.8rem' }}>
              {f.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Preset selector */}
      <FormControl size="small" sx={{ minWidth: 170 }}>
        <InputLabel id="date-range-preset-label" sx={{ fontSize: '0.8rem' }}>
          {localeText.dateRangePresetAriaLabel}
        </InputLabel>
        <Select
          labelId="date-range-preset-label"
          label={localeText.dateRangePresetAriaLabel}
          value={activePreset}
          onChange={(event) => handlePresetChange(event.target.value)}
          sx={{ fontSize: '0.8rem' }}
        >
          {dateRangePresetGroups.map((group) => [
            <ListSubheader key={group.label} sx={{ fontSize: '0.7rem', lineHeight: '2rem' }}>
              {group.label}
            </ListSubheader>,
            ...group.options.map((opt) => (
              <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: '0.8rem' }}>
                {opt.label}
              </MenuItem>
            )),
          ])}
        </Select>
      </FormControl>
    </Box>
  );
}
