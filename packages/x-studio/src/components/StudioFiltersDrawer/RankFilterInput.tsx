'use client';
import {
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import type { StudioFilterState } from '../../models';
import { NumberField } from '../../internals/NumberField';
import { useStudioLocaleText } from '../../context';

export interface AvailableSeries {
  fieldId: string;
  label: string;
}

export function RankFilterInput({
  direction,
  n,
  rankMultiSeriesBy,
  availableSeries,
  onChange,
}: {
  direction: 'top' | 'bottom';
  n: number | undefined;
  rankMultiSeriesBy?: string;
  availableSeries?: AvailableSeries[];
  onChange: (changes: Partial<StudioFilterState>) => void;
}) {
  const localeText = useStudioLocaleText();
  const showRankBy = availableSeries && availableSeries.length > 1;
  const aggregateOptions = [
    { value: '__sum', label: localeText.filterRankAggSumLabel },
    { value: '__avg', label: localeText.filterRankAggAvgLabel },
    { value: '__max', label: localeText.filterRankAggMaxLabel },
    { value: '__min', label: localeText.filterRankAggMinLabel },
  ];

  return (
    <Stack spacing={1}>
      {/* Top / Bottom toggle */}
      <ToggleButtonGroup
        exclusive
        size="small"
        value={direction}
        aria-label={localeText.filterRankDirectionAriaLabel}
        onChange={(_event, val) => {
          if (val) {
            onChange({ rankDirection: val as 'top' | 'bottom' });
          }
        }}
      >
        <ToggleButton value="top" sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: 'none' }}>
          {localeText.filterRankTop}
        </ToggleButton>
        <ToggleButton
          value="bottom"
          sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: 'none' }}
        >
          {localeText.filterRankBottom}
        </ToggleButton>
      </ToggleButtonGroup>

      {/* N items number field */}
      <NumberField
        size="small"
        label={localeText.filterRankCountLabel}
        value={n ?? null}
        min={1}
        onValueChange={(v) => onChange({ value: Math.max(1, v ?? 1) })}
      />

      {showRankBy && (
        <FormControl size="small" fullWidth>
          <InputLabel>{localeText.filterRankByLabel}</InputLabel>
          <Select
            label={localeText.filterRankByLabel}
            value={rankMultiSeriesBy ?? '__sum'}
            onChange={(event) => onChange({ rankMultiSeriesBy: event.target.value })}
          >
            {aggregateOptions.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
            <Divider />
            {availableSeries.map((s) => (
              <MenuItem key={s.fieldId} value={s.fieldId}>
                {s.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}
    </Stack>
  );
}
