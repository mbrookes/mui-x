'use client';
import * as React from 'react';
import { Box, Stack, Tooltip } from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import CloseIcon from '@mui/icons-material/Close';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';

export interface StudioFilterDateRangeControlProps {
  label: string;
  fieldId: string;
  currentValue: { from?: string; to?: string } | null;
  onApply: (value: { from?: string; to?: string }) => void;
  onClear: () => void;
}

export function DateRangeControl(props: StudioFilterDateRangeControlProps) {
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
