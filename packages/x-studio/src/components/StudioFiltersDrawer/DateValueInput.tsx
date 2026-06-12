'use client';
import * as React from 'react';
import {
  Box,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import type { StudioMetricRef } from '../../models';
import type { RelativeDateValue } from '../../internals/filterTypes';
import { isRelativeDateValue, absoluteToRelative, relativeToAbsolute } from './filterDrawerUtils';
import { useStudioLocaleText } from '../../context';
import { MetricPickerButton } from './MetricPickerButton';
import { RelativeDateInput } from './RelativeDateInput';

/**
 * A single date value input that supports toggling between an absolute date picker
 * and a relative expression (e.g. "5 days ago").
 */
export function DateValueInput({
  value,
  onChange,
  label,
  fieldType,
  valueRef,
  onValueRefChange,
  onMetricSelect,
  metricLabel,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
  fieldType?: 'date' | 'datetime';
  valueRef?: StudioMetricRef;
  onValueRefChange?: (ref: StudioMetricRef | undefined) => void;
  onMetricSelect?: (value: unknown, ref: StudioMetricRef) => void;
  metricLabel?: string;
}) {
  const localeText = useStudioLocaleText();
  const isRel = isRelativeDateValue(value);
  const mode = isRel ? 'relative' : 'absolute';

  const handleModeChange = (_: React.MouseEvent, newMode: 'absolute' | 'relative' | null) => {
    if (!newMode || newMode === mode) {
      return;
    }
    if (valueRef && onValueRefChange) {
      onValueRefChange(undefined);
    }
    if (newMode === 'relative') {
      onChange(absoluteToRelative(String(value ?? '')));
    } else {
      onChange(relativeToAbsolute(value as RelativeDateValue));
    }
  };

  const dayjsVal: Dayjs | null = !isRel && value && typeof value === 'string' ? dayjs(value) : null;

  const isLinked = Boolean(valueRef);

  let dateContent: React.ReactNode;
  if (onValueRefChange) {
    dateContent = (
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <DatePicker
            label={label ?? localeText.filterDateLabel}
            value={dayjsVal?.isValid() ? dayjsVal : null}
            disabled={isLinked}
            onChange={(d) => {
              onChange(d?.isValid() ? d.format('YYYY-MM-DD') : '');
              if (valueRef) {
                onValueRefChange(undefined);
              }
            }}
            slotProps={{ textField: { size: 'small' } }}
            sx={{ flexGrow: 1, minWidth: 130 }}
          />
          <MetricPickerButton
            fieldType={fieldType ?? 'date'}
            isLinked={isLinked}
            onRemoveLink={() => onValueRefChange(undefined)}
            onSelect={(opt) => {
              const nextValue = String(opt.value);
              const nextRef = { sourceId: opt.sourceId, rowId: opt.rowId, field: opt.field };
              if (onMetricSelect) {
                onMetricSelect(nextValue, nextRef);
                return;
              }
              onChange(nextValue);
              onValueRefChange(nextRef);
            }}
          />
        </Box>
        {metricLabel && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.25, ml: 0.25 }}
          >
            {metricLabel}
          </Typography>
        )}
      </Box>
    );
  } else {
    dateContent = (
      <DatePicker
        label={label ?? localeText.filterDateLabel}
        value={dayjsVal?.isValid() ? dayjsVal : null}
        onChange={(d) => {
          onChange(d?.isValid() ? d.format('YYYY-MM-DD') : '');
        }}
        slotProps={{ textField: { size: 'small' } }}
        sx={{ flexGrow: 1, minWidth: 130 }}
      />
    );
  }

  return (
    <Stack spacing={1} sx={{ flexGrow: 1, minWidth: 0 }}>
      <ToggleButtonGroup
        exclusive
        value={mode}
        onChange={handleModeChange}
        sx={{ alignSelf: 'center' }}
      >
        <Tooltip title={localeText.filterAbsoluteDate}>
          <ToggleButton value="absolute" sx={{ px: 1.5, py: 0.5 }}>
            <CalendarTodayIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
        <Tooltip title={localeText.filterRelativeDate}>
          <ToggleButton value="relative" sx={{ px: 1.5, py: 0.5 }}>
            <AccessTimeIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
      </ToggleButtonGroup>

      {isRel ? (
        <RelativeDateInput
          value={value as RelativeDateValue}
          onChange={onChange}
          valueRef={valueRef}
          onValueRefChange={onValueRefChange}
          onMetricSelect={
            onMetricSelect as ((value: RelativeDateValue, ref: StudioMetricRef) => void) | undefined
          }
          metricLabel={metricLabel}
        />
      ) : (
        dateContent
      )}
    </Stack>
  );
}

