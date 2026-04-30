'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Box,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioSelector } from '../context';
import { NumberField } from '../internals/NumberField';
import type { StudioPageTheme, StudioChartPaletteName } from '../models';
import { ColorInput, ColorSwatch } from './ColorInput';

/** Stable empty theme used as fallback so the selector never returns a new object reference. */
const EMPTY_PAGE_THEME: StudioPageTheme = {};

/** Hard-coded light-mode swatches for each named palette (first 6 colors). */
const NAMED_PALETTES: { id: StudioChartPaletteName; label: string; swatches: string[] }[] = [
  {
    id: 'blueberryTwilight',
    label: 'Blueberry Twilight',
    swatches: ['#02B2AF', '#2E96FF', '#B800D8', '#60009B', '#2731C8', '#03008D'],
  },
  {
    id: 'mangoFusion',
    label: 'Mango Fusion',
    swatches: ['#173A5E', '#00A3A0', '#C91B63', '#EF5350', '#FFA726', '#B800D8'],
  },
  {
    id: 'cheerfulFiesta',
    label: 'Cheerful Fiesta',
    swatches: ['#003A75', '#007FFF', '#FFC24C', '#FF9D09', '#CA6C00', '#127D94'],
  },
  {
    id: 'rainbowSurge',
    label: 'Rainbow Surge',
    swatches: ['#4254FB', '#FFB422', '#FA4F58', '#0DBEFF', '#22BF75', '#FA83B4'],
  },
];

function PaletteSwatches({ colors }: { colors: string[] }) {
  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      {colors.map((color, i) => (
        <Box
          key={`${color}-${i}`}
          sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: color, flexShrink: 0 }}
        />
      ))}
    </Box>
  );
}

function ChartPalettePanel({
  pageTheme,
  update,
}: {
  pageTheme: StudioPageTheme;
  update: (changes: Partial<StudioPageTheme>) => void;
}) {
  const selected = pageTheme.chartPalette;

  const handleSelect = (id: StudioChartPaletteName | undefined) => {
    update({ chartPalette: id, chartCustomColors: undefined });
  };

  const customColors = pageTheme.chartCustomColors ?? [];

  const handleCustomColorChange = (index: number, value: string) => {
    const next = [...customColors];
    next[index] = value;
    update({ chartCustomColors: next });
  };

  const handleAddCustomColor = () => {
    update({ chartCustomColors: [...customColors, '#2196f3'] });
  };

  const handleRemoveCustomColor = (index: number) => {
    const next = customColors.filter((_, i) => i !== index);
    update({ chartCustomColors: next.length ? next : undefined });
  };

  const handleSelectCustom = () => {
    if (selected !== 'custom') {
      // Seed custom colors from the currently-selected named palette, or a default set
      const currentPalette = NAMED_PALETTES.find((p) => p.id === selected);
      const seed = currentPalette
        ? currentPalette.swatches
        : NAMED_PALETTES[0].swatches;
      update({ chartPalette: 'custom', chartCustomColors: [...seed] });
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Chart colours</Typography>

      <Stack spacing={0.5}>
        {/* "Default" (no override) option */}
        <Box
          onClick={() => handleSelect(undefined)}
          sx={{
            px: 1.5,
            py: 1,
            borderRadius: 1,
            cursor: 'pointer',
            border: 1,
            borderColor: !selected ? 'primary.main' : 'divider',
            bgcolor: !selected ? 'action.selected' : 'transparent',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              Theme default
            </Typography>
            {!selected && (
              <Typography variant="caption" color="primary">✓</Typography>
            )}
          </Box>
        </Box>

        {NAMED_PALETTES.map((p) => (
          <Box
            key={p.id}
            onClick={() => handleSelect(p.id)}
            sx={{
              px: 1.5,
              py: 1,
              borderRadius: 1,
              cursor: 'pointer',
              border: 1,
              borderColor: selected === p.id ? 'primary.main' : 'divider',
              bgcolor: selected === p.id ? 'action.selected' : 'transparent',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.75 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                {p.label}
              </Typography>
              {selected === p.id && (
                <Typography variant="caption" color="primary">✓</Typography>
              )}
            </Box>
            <PaletteSwatches colors={p.swatches} />
          </Box>
        ))}

        {/* Custom option */}
        <Box
          onClick={handleSelectCustom}
          sx={{
            px: 1.5,
            py: 1,
            borderRadius: 1,
            cursor: selected === 'custom' ? 'default' : 'pointer',
            border: 1,
            borderColor: selected === 'custom' ? 'primary.main' : 'divider',
            bgcolor: selected === 'custom' ? 'action.selected' : 'transparent',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', mb: customColors.length ? 0.75 : 0 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              Custom
            </Typography>
            {selected === 'custom' && (
              <Typography variant="caption" color="primary">✓</Typography>
            )}
          </Box>
          {customColors.length > 0 && (
            <PaletteSwatches colors={customColors} />
          )}
        </Box>
      </Stack>

      {selected === 'custom' && (
        <Stack spacing={1}>
          {customColors.map((color, index) => (
            <Box key={index} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <ColorSwatch
                value={color}
                onChange={(v) => handleCustomColorChange(index, v)}
                label={`Custom colour ${index + 1}`}
                size={28}
              />
              <TextField
                size="small"
                value={color}
                onChange={(e) => handleCustomColorChange(index, e.target.value)}
                sx={{ flex: 1 }}
                slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } }}
              />
              <IconButton
                size="small"
                onClick={() => handleRemoveCustomColor(index)}
                disabled={customColors.length <= 1}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
          <Box>
            <IconButton size="small" onClick={handleAddCustomColor}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Box>
        </Stack>
      )}
    </Stack>
  );
}

export function PageConfigPanel() {
  const controller = useStudioController();
  const pageTheme =
    useStudioSelector((state) => state.pages[state.dashboard.activePageId]?.theme) ??
    EMPTY_PAGE_THEME;

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

  const PADDING_OPTIONS = [
    { value: 0, label: 'None' },
    { value: 1, label: 'Small (8px)' },
    { value: 2, label: 'Medium (16px)' },
    { value: 3, label: 'Large (24px)' },
  ];

  return (
    <Stack spacing={2.5} sx={{ pt: 1 }}>
      <Typography variant="subtitle2">Page</Typography>

      <ColorInput
        label="Background colour"
        value={pageTheme.pageBackground ?? ''}
        onChange={(v) => update({ pageBackground: v || undefined })}
        placeholder="e.g. #f5f5f5"
      />

      <Divider />

      <Typography variant="subtitle2">Cards</Typography>

      <ColorInput
        label="Card background"
        value={pageTheme.cardBackground ?? ''}
        onChange={(v) => update({ cardBackground: v || undefined })}
        placeholder="e.g. #ffffff"
      />

      <FormControl size="small" fullWidth>
        <InputLabel>Padding</InputLabel>
        <Select
          label="Padding"
          value={pageTheme.cardPadding ?? 2}
          onChange={(event) => update({ cardPadding: event.target.value as number })}
        >
          {PADDING_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <NumberField
        size="small"
        label="Corner radius (px)"
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
        label="Card border"
      />

      {cardBorder && (
        <React.Fragment>
          <ColorInput
            label="Border colour"
            value={pageTheme.cardBorderColor ?? ''}
            onChange={(v) => update({ cardBorderColor: v || undefined })}
            placeholder="e.g. #e0e0e0"
          />
          <NumberField
            size="small"
            label="Border width (px)"
            value={pageTheme.cardBorderWidth ?? null}
            min={1}
            max={16}
            onValueChange={(v) => update({ cardBorderWidth: v ?? undefined })}
          />
        </React.Fragment>
      )}

      <Divider />

      <ChartPalettePanel pageTheme={pageTheme} update={update} />
    </Stack>
  );
}
