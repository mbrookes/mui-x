'use client';
import * as React from 'react';
import { Box, IconButton, Stack, Tooltip } from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import CloseIcon from '@mui/icons-material/Close';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useStudioLocaleText } from '../../../../internals/StudioUIConfigContext';

export interface StudioFilterDateRangeControlProps {
  label: string;
  fieldId: string;
  currentValue: { from?: string; to?: string } | null;
  onApply: (value: { from?: string; to?: string }) => void;
  onClear: () => void;
}

export function DateRangeControl(props: StudioFilterDateRangeControlProps) {
  const { label, fieldId, currentValue, onApply, onClear } = props;
  const localeText = useStudioLocaleText();
  const [from, setFrom] = React.useState<Dayjs | null>(
    currentValue?.from ? dayjs(currentValue.from) : null,
  );
  const [to, setTo] = React.useState<Dayjs | null>(
    currentValue?.to ? dayjs(currentValue.to) : null,
  );

  // Whether each field currently has local, uncommitted edits (finding 3.4). While
  // typing a "From" date, an intermediate invalid state (e.g. an incomplete section)
  // debounce-applies `{ from: undefined, to }` to the store; that round-trips back
  // through `currentValue` ~300ms later, and without this guard the sync effect below
  // would unconditionally clear the field the user is still mid-editing. Tracked via
  // focus rather than a "dirty" flag so the guard releases naturally once the user
  // tabs/clicks away, letting external updates (e.g. programmatic clear) resync then.
  const fromFocusedRef = React.useRef(false);
  const toFocusedRef = React.useRef(false);

  // Sync when external value changes (e.g. filter cleared programmatically)
  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- external sync is intentional; local state buffers UI interaction
  React.useEffect(() => {
    if (!fromFocusedRef.current) {
      // react-doctor-disable-next-line react-doctor/no-derived-state -- date pickers use local state to avoid re-render on every keystroke
      setFrom(currentValue?.from ? dayjs(currentValue.from) : null);
    }
    if (!toFocusedRef.current) {
      // react-doctor-disable-next-line react-doctor/no-derived-state -- same as above
      setTo(currentValue?.to ? dayjs(currentValue.to) : null);
    }
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

  // Cancel any pending debounced `onApply` before clearing (finding 2). Without this, a
  // date pick followed by a clear within the 300ms debounce window still fires the STALE
  // scheduled `onApply(value)` after `onClear()` has already reset the filter — silently
  // resurrecting the just-cleared date range moments later. Also reset the local buffered
  // state immediately rather than waiting for the sync effect's round-trip through
  // `currentValue`, so the pickers visually clear in the same tick as the click.
  const handleClear = () => {
    if (pendingApply.current !== null) {
      clearTimeout(pendingApply.current);
      pendingApply.current = null;
    }
    setFrom(null);
    setTo(null);
    onClear();
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
              onClick={handleClear}
              sx={{ color: 'text.secondary', p: 0.5 }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      <Stack direction="row" spacing={1}>
        <DatePicker
          label={localeText.filterWidgetDateFromLabel}
          value={from}
          onChange={handleFromChange}
          slotProps={{
            textField: {
              size: 'small',
              fullWidth: true,
              onFocus: () => {
                fromFocusedRef.current = true;
              },
              onBlur: () => {
                fromFocusedRef.current = false;
                // Re-sync to the current external value on blur. If an external change
                // (e.g. another part of the UI clearing this filter, or an undo/redo)
                // arrived while this field was focused, the sync effect above suppressed
                // it. Without this, the stale displayed date would persist indefinitely
                // even after the user tabs/clicks away.
                setFrom(currentValue?.from ? dayjs(currentValue.from) : null);
              },
            },
          }}
          data-field={fieldId}
        />
        <DatePicker
          label={localeText.filterWidgetDateToLabel}
          value={to}
          onChange={handleToChange}
          slotProps={{
            textField: {
              size: 'small',
              fullWidth: true,
              onFocus: () => {
                toFocusedRef.current = true;
              },
              onBlur: () => {
                toFocusedRef.current = false;
                // See comment on the "From" field's onBlur above.
                setTo(currentValue?.to ? dayjs(currentValue.to) : null);
              },
            },
          }}
        />
      </Stack>
    </Stack>
  );
}
