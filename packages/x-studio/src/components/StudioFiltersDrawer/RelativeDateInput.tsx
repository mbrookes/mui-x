'use client';
import { Box, Chip, FormControl, MenuItem, Select, Stack } from '@mui/material';
import { NumberField } from '../../internals/NumberField';
import type { RelativeDateUnit, RelativeDateValue } from '../../internals/filterTypes';
import { useStudioLocaleText } from '../../context';

function getRelativeUnits(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    { value: 'second', label: localeText.filterRelativeUnitSeconds },
    { value: 'minute', label: localeText.filterRelativeUnitMinutes },
    { value: 'hour', label: localeText.filterRelativeUnitHours },
    { value: 'day', label: localeText.filterRelativeUnitDays },
    { value: 'week', label: localeText.filterRelativeUnitWeeks },
    { value: 'month', label: localeText.filterRelativeUnitMonths },
    { value: 'year', label: localeText.filterRelativeUnitYears },
  ] satisfies { value: RelativeDateUnit; label: string }[];
}

function getDatePresets(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    {
      label: localeText.filterDatePreset7Days,
      value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset30Days,
      value: { relative: true, amount: 30, unit: 'day', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset3Months,
      value: { relative: true, amount: 3, unit: 'month', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset12Months,
      value: { relative: true, amount: 12, unit: 'month', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset1Year,
      value: { relative: true, amount: 1, unit: 'year', direction: 'past' },
    },
  ] satisfies { label: string; value: RelativeDateValue }[];
}

export function RelativeDateInput({
  value,
  onChange,
}: {
  value: RelativeDateValue;
  onChange: (v: RelativeDateValue) => void;
}) {
  const localeText = useStudioLocaleText();
  const relativeUnits = getRelativeUnits(localeText);
  const datePresets = getDatePresets(localeText);

  return (
    <Stack spacing={0.75} sx={{ flexGrow: 1, minWidth: 0 }}>
      {/* Quick preset chips */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {datePresets.map((preset) => {
          const isActive =
            value.amount === preset.value.amount &&
            value.unit === preset.value.unit &&
            value.direction === preset.value.direction;
          return (
            <Chip
              key={preset.label}
              label={preset.label}
              size="small"
              color={isActive ? 'primary' : 'default'}
              variant={isActive ? 'filled' : 'outlined'}
              // M20: these are toggle buttons whose selected state was conveyed by colour and
              // fill alone — invisible to a screen reader and to anyone who can't distinguish
              // the two. `aria-pressed` is the pattern `ToggleControl` already uses next door.
              aria-pressed={isActive}
              onClick={() => onChange(preset.value)}
            />
          );
        })}
      </Box>
      {/* H5: `onValueCommitted` (blur semantics), not `onValueChange` (per keystroke) — see
          `RankFilterInput` for the full rationale. Typing "12" here used to commit `1` and then
          `12` as two undoable filter mutations, and the `Math.max(1, …)` clamp on a controlled
          field made the input impossible to clear before retyping. A `null` commit (empty
          field) is ignored: `RelativeDateValue.amount` is required, and Base UI resyncs the
          displayed text back to the stored amount on blur. */}
      <NumberField
        size="small"
        label={localeText.filterValueAmountLabel}
        value={value.amount}
        onValueCommitted={(v) => {
          if (v !== null && v !== value.amount) {
            onChange({ ...value, amount: v });
          }
        }}
        min={1}
        fullWidth
      />
      <FormControl size="small" fullWidth>
        {/* M19: MUI's `SelectInput` reads the accessible name off `inputProps` (it forwards
            `inputProps['aria-label']` onto the rendered combobox); a bare `aria-label` prop
            lands on the wrapper `div` and names nothing. There is no `InputLabel` in this
            FormControl to fall back to, so the combobox was anonymous. Same pattern as
            `StudioWidgetEditDialog/FilterRow` and `MultiSelectControl`. */}
        <Select
          value={value.unit}
          inputProps={{ 'aria-label': localeText.filterRelativeDateUnitAriaLabel }}
          onChange={(event) => onChange({ ...value, unit: event.target.value as RelativeDateUnit })}
        >
          {relativeUnits.map((u) => (
            <MenuItem key={u.value} value={u.value}>
              {u.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <Select
          value={value.direction}
          inputProps={{ 'aria-label': localeText.filterRelativeDateDirectionAriaLabel }}
          onChange={(event) =>
            onChange({ ...value, direction: event.target.value as 'past' | 'next' })
          }
        >
          <MenuItem value="past">{localeText.filterRelativeDateAgo}</MenuItem>
          <MenuItem value="next">{localeText.filterRelativeDateFromNow}</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}
