'use client';
import * as React from 'react';
import {
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectActivePage,
  useStudioLocaleText,
} from '../../context';
import { NumberField } from '../../internals/NumberField';
import type { StudioPageTheme } from '../../models';
import { ColorInput } from './ColorInput';

/** Stable empty theme used as fallback so the selector never returns a new object reference. */
const EMPTY_PAGE_THEME: StudioPageTheme = {};

export function PageConfigPanel() {
  const controller = useStudioController();
  const pageTheme = useStudioSelector(selectActivePage)?.theme ?? EMPTY_PAGE_THEME;
  const localeText = useStudioLocaleText();
  const paddingOptions = [
    { value: 0, label: localeText.pageConfigPaddingNone },
    { value: 1, label: localeText.pageConfigPaddingSmall },
    { value: 2, label: localeText.pageConfigPaddingMedium },
    { value: 3, label: localeText.pageConfigPaddingLarge },
  ];

  const update = React.useCallback(
    (changes: Partial<StudioPageTheme>) => {
      // Read the latest theme from the store at call time to avoid stale closures when
      // the active page changes while an event (e.g. native color picker) is in flight.
      const state = controller.getState();
      const currentTheme = state.pages[state.dashboard.activePageId]?.theme ?? EMPTY_PAGE_THEME;
      controller.updateActivePage({ theme: { ...currentTheme, ...changes } });
    },
    [controller],
  );

  const cardBorder = pageTheme.cardBorder !== false; // default true

  return (
    <Stack spacing={2.5} sx={{ pt: 1 }}>
      <Typography variant="subtitle2">{localeText.pageConfigPageSectionTitle}</Typography>

      <ColorInput
        label={localeText.pageConfigBackgroundColourLabel}
        value={pageTheme.pageBackground ?? ''}
        onChange={(v) => update({ pageBackground: v || undefined })}
        placeholder={localeText.pageConfigBackgroundColourPlaceholder}
      />

      <Divider />

      <Typography variant="subtitle2">{localeText.pageConfigCardsSectionTitle}</Typography>

      <ColorInput
        label={localeText.pageConfigCardBackgroundLabel}
        value={pageTheme.cardBackground ?? ''}
        onChange={(v) => update({ cardBackground: v || undefined })}
        placeholder={localeText.pageConfigCardBackgroundPlaceholder}
      />

      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.pageConfigPaddingLabel}</InputLabel>
        <Select
          label={localeText.pageConfigPaddingLabel}
          value={pageTheme.cardPadding ?? 2}
          onChange={(event) => update({ cardPadding: event.target.value as number })}
        >
          {paddingOptions.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <NumberField
        size="small"
        label={localeText.pageConfigCornerRadiusLabel}
        value={pageTheme.cardRadius ?? null}
        min={0}
        max={64}
        onValueChange={(v) => update({ cardRadius: v ?? undefined })}
      />

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            checked={cardBorder}
            onChange={(event) => update({ cardBorder: event.target.checked })}
            size="small"
          />
        }
        label={localeText.pageConfigCardBorderLabel}
      />

      {cardBorder && (
        <React.Fragment>
          <ColorInput
            label={localeText.pageConfigBorderColourLabel}
            value={pageTheme.cardBorderColor ?? ''}
            onChange={(v) => update({ cardBorderColor: v || undefined })}
            placeholder={localeText.pageConfigBorderColourPlaceholder}
          />
          <NumberField
            size="small"
            label={localeText.pageConfigBorderWidthLabel}
            value={pageTheme.cardBorderWidth ?? null}
            min={1}
            max={16}
            onValueChange={(v) => update({ cardBorderWidth: v ?? undefined })}
          />
        </React.Fragment>
      )}
    </Stack>
  );
}
