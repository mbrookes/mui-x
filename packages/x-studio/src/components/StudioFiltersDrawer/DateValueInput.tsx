'use client';
import * as React from 'react';
import { Stack, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import type { RelativeDateValue } from '../../internals/filterTypes';
import { isRelativeDateValue, absoluteToRelative, relativeToAbsolute } from './filterDrawerUtils';
import { useStudioLocaleText } from '../../context';
import { RelativeDateInput } from './RelativeDateInput';

/**
 * A single date value input that supports toggling between an absolute date picker
 * and a relative expression (e.g. "5 days ago").
 */
export function DateValueInput({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
}) {
  const localeText = useStudioLocaleText();
  const isRel = isRelativeDateValue(value);
  const mode = isRel ? 'relative' : 'absolute';

  // `absoluteToRelative`/`relativeToAbsolute` are lossy: "2024-05-20" viewed 45 days later
  // becomes "2 months ago", and converting that back yields ~60 days ago — the original date
  // is gone. The control reads as a display-mode switch, so remember the last value the user
  // actually had in each mode and restore it verbatim when they toggle back; conversion runs
  // only the first time a mode is entered, when there is nothing to restore.
  const lastAbsoluteRef = React.useRef<string | null>(null);
  const lastRelativeRef = React.useRef<RelativeDateValue | null>(null);
  if (isRel) {
    lastRelativeRef.current = value as RelativeDateValue;
  } else if (typeof value === 'string' && value !== '') {
    lastAbsoluteRef.current = value;
  }

  const handleModeChange = (_: React.MouseEvent, newMode: 'absolute' | 'relative' | null) => {
    if (!newMode || newMode === mode) {
      return;
    }
    if (newMode === 'relative') {
      onChange(lastRelativeRef.current ?? absoluteToRelative(String(value ?? '')));
    } else {
      onChange(lastAbsoluteRef.current ?? relativeToAbsolute(value as RelativeDateValue));
    }
  };

  const dayjsVal: Dayjs | null = !isRel && value && typeof value === 'string' ? dayjs(value) : null;

  return (
    <Stack spacing={1} sx={{ flexGrow: 1, minWidth: 0 }}>
      <ToggleButtonGroup
        exclusive
        value={mode}
        onChange={handleModeChange}
        aria-label={localeText.filterDateModeAriaLabel}
        sx={{ alignSelf: 'center' }}
      >
        <Tooltip title={localeText.filterAbsoluteDate}>
          <ToggleButton
            value="absolute"
            aria-label={localeText.filterAbsoluteDate}
            sx={{ px: 1.5, py: 0.5 }}
          >
            <CalendarTodayIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
        <Tooltip title={localeText.filterRelativeDate}>
          <ToggleButton
            value="relative"
            aria-label={localeText.filterRelativeDate}
            sx={{ px: 1.5, py: 0.5 }}
          >
            <AccessTimeIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
      </ToggleButtonGroup>

      {isRel ? (
        <RelativeDateInput value={value as RelativeDateValue} onChange={onChange} />
      ) : (
        <DatePicker
          label={label ?? localeText.filterDateLabel}
          value={dayjsVal?.isValid() ? dayjsVal : null}
          onChange={(d: Dayjs | null) => {
            onChange(d?.isValid() ? d.format('YYYY-MM-DD') : '');
          }}
          slotProps={{ textField: { size: 'small' } }}
          sx={{ flexGrow: 1, minWidth: 130 }}
        />
      )}
    </Stack>
  );
}
