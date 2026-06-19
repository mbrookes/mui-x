'use client';
import * as React from 'react';
import { Box, FormControl, InputLabel, ListSubheader, MenuItem, Select } from '@mui/material';
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

interface DateField {
  fieldId: string;
  sourceId: string;
  type: 'date' | 'datetime';
}

/**
 * Compact date range toolbar rendered above the canvas.
 * Lets the user pick a preset range to filter all widgets on the active page.
 * Automatically applies to the first date/datetime field found in any data source.
 *
 * Only rendered when at least one date or datetime field exists.
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

  const dateRangeFilter = React.useMemo(
    () =>
      (filters as StudioFilterState[]).find(
        (f) => f.isDashboardDateRange && (!f.pageId || f.pageId === activePageId),
      ) ?? null,
    [filters, activePageId],
  );

  // First date/datetime field across all sources — used as the implicit filter target.
  const firstDateField = React.useMemo<DateField | null>(() => {
    for (const source of Object.values(dataSources)) {
      for (const field of source.fields) {
        if ((field.type === 'date' || field.type === 'datetime') && !field.hidden) {
          return { fieldId: field.id, sourceId: source.id, type: field.type };
        }
      }
    }
    return null;
  }, [dataSources]);

  if (!firstDateField) {
    return null;
  }

  const activePreset: StudioDateRangePreset | 'all_time' =
    dateRangeFilter?.dateRangePreset ?? 'all_time';

  const handlePresetChange = (value: string) => {
    const preset = value as StudioDateRangePreset | 'all_time';
    if (preset === 'all_time') {
      controller.setDashboardDateRange(activePageId, null, null, null, null);
      return;
    }
    if (preset === 'custom') {
      return;
    }
    controller.setDashboardDateRange(
      activePageId,
      firstDateField.fieldId,
      firstDateField.sourceId,
      firstDateField.type,
      preset,
    );
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
      }}
    >
      <CalendarMonthIcon fontSize="small" color="action" sx={{ flexShrink: 0 }} />

      <FormControl size="small" sx={{ minWidth: 170 }}>
        <InputLabel id="date-range-preset-label" sx={{ fontSize: '0.8rem' }}>
          {localeText.dateRangeBarFieldLabel}
        </InputLabel>
        <Select
          labelId="date-range-preset-label"
          label={localeText.dateRangeBarFieldLabel}
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
