'use client';
import * as React from 'react';
import { Box, IconButton, Stack, Tooltip } from '@mui/material';
import { DateRangePicker } from '@mui/x-date-pickers-pro/DateRangePicker';
import type { DateRange } from '@mui/x-date-pickers-pro/models';
import CloseIcon from '@mui/icons-material/Close';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useStudioLocaleText } from '../../../../internals/StudioUIConfigContext';

export interface StudioFilterDateRangeControlProps {
  label: string;
  currentValue: { from?: string; to?: string } | null;
  onApply: (value: { from?: string; to?: string }) => void;
  onClear: () => void;
}

export function DateRangeControl(props: StudioFilterDateRangeControlProps) {
  const { label, currentValue, onApply, onClear } = props;
  const localeText = useStudioLocaleText();

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- external sync is intentional; local state buffers UI interaction
  const [localValue, setLocalValue] = React.useState<DateRange<Dayjs>>([
    currentValue?.from ? dayjs(currentValue.from) : null,
    currentValue?.to ? dayjs(currentValue.to) : null,
  ]);

  // Sync when external value changes (e.g. filter cleared programmatically)
  React.useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- date pickers use local state to avoid re-render on every keystroke
    setLocalValue([
      currentValue?.from ? dayjs(currentValue.from) : null,
      currentValue?.to ? dayjs(currentValue.to) : null,
    ]);
  }, [currentValue?.from, currentValue?.to]);

  // Debounce onApply so that typing a date character-by-character doesn't trigger
  // a full pipeline re-render on every keystroke.
  const pendingApply = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleApply = React.useCallback(
    (value: DateRange<Dayjs>) => {
      if (pendingApply.current !== null) {
        clearTimeout(pendingApply.current);
      }
      pendingApply.current = setTimeout(() => {
        pendingApply.current = null;
        onApply({
          from: value[0]?.isValid() ? value[0].format('YYYY-MM-DD') : undefined,
          to: value[1]?.isValid() ? value[1].format('YYYY-MM-DD') : undefined,
        });
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

  const handleChange = (newValue: DateRange<Dayjs>) => {
    setLocalValue(newValue);
    scheduleApply(newValue);
  };

  const isActive = !!(currentValue?.from || currentValue?.to);

  return (
    <Stack spacing={1} role="group" aria-label={label}>
      {isActive && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title={localeText.filterWidgetClearAriaLabel}>
            <IconButton
              size="small"
              aria-label={localeText.filterWidgetClearAriaLabel}
              onClick={onClear}
              sx={{ color: 'text.secondary', p: 0.5 }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      <DateRangePicker
        value={localValue}
        onChange={handleChange}
        slotProps={{
          textField: {
            size: 'small',
            fullWidth: true,
          },
        }}
      />
    </Stack>
  );
}
