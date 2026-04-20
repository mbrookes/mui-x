import * as React from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioColorMode } from '../models';

const PRESET_COLORS = [
  { label: 'Blue', value: '#1976d2' },
  { label: 'Purple', value: '#9c27b0' },
  { label: 'Teal', value: '#009688' },
  { label: 'Orange', value: '#ed6c02' },
  { label: 'Red', value: '#d32f2f' },
  { label: 'Green', value: '#2e7d32' },
  { label: 'Pink', value: '#c2185b' },
  { label: 'Indigo', value: '#303f9f' },
];

const FONT_FAMILIES = [
  { label: 'Roboto (Default)', value: '"Roboto", "Helvetica", "Arial", sans-serif' },
  { label: 'Inter', value: '"Inter", "Helvetica", "Arial", sans-serif' },
  { label: 'Open Sans', value: '"Open Sans", "Helvetica", "Arial", sans-serif' },
  { label: 'System UI', value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Monospace', value: '"Roboto Mono", "Courier New", monospace' },
];

export function StudioThemeDrawer() {
  const controller = useStudioController();
  const theme = useStudioSelector((state) => state.theme);
  const dashboardTitle = useStudioSelector((state) => state.dashboard.title);

  const [titleValue, setTitleValue] = React.useState(dashboardTitle);

  React.useEffect(() => {
    setTitleValue(dashboardTitle);
  }, [dashboardTitle]);

  const handleTitleBlur = () => {
    if (titleValue !== dashboardTitle) {
      controller.setDashboardTitle(titleValue);
    }
  };

  return (
    <Stack spacing={3}>
      {/* Dashboard Title */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Dashboard
        </Typography>
        <TextField
          label="Title"
          size="small"
          fullWidth
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleTitleBlur();
            }
          }}
        />
      </Box>

      {/* Color Mode */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Appearance
        </Typography>
        <FormControl size="small" fullWidth>
          <InputLabel>Color mode</InputLabel>
          <Select
            label="Color mode"
            value={theme.colorMode}
            onChange={(e) => controller.updateTheme({ colorMode: e.target.value as StudioColorMode })}
          >
            <MenuItem value="light">Light</MenuItem>
            <MenuItem value="dark">Dark</MenuItem>
            <MenuItem value="system">System</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {/* Primary Color */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Primary color
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {PRESET_COLORS.map((color) => (
            <Box
              key={color.value}
              onClick={() => controller.updateTheme({ primaryColor: color.value })}
              sx={{
                width: 32,
                height: 32,
                borderRadius: 1,
                bgcolor: color.value,
                cursor: 'pointer',
                border: 2,
                borderColor: theme.primaryColor === color.value ? 'text.primary' : 'transparent',
                '&:hover': { opacity: 0.8 },
              }}
              title={color.label}
              role="button"
              tabIndex={0}
              aria-label={`Select ${color.label} color`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  controller.updateTheme({ primaryColor: color.value });
                }
              }}
            />
          ))}
        </Stack>
        <TextField
          label="Custom color (hex)"
          size="small"
          fullWidth
          value={theme.primaryColor}
          onChange={(e) => {
            const value = e.target.value;
            if (/^#[0-9A-Fa-f]{0,6}$/.test(value)) {
              controller.updateTheme({ primaryColor: value });
            }
          }}
          sx={{ mt: 1.5 }}
          placeholder="#1976d2"
        />
      </Box>

      {/* Density */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Density
        </Typography>
        <FormControl size="small" fullWidth>
          <InputLabel>Component density</InputLabel>
          <Select
            label="Component density"
            value={theme.density}
            onChange={(e) =>
              controller.updateTheme({
                density: e.target.value as 'compact' | 'standard' | 'comfortable',
              })
            }
          >
            <MenuItem value="compact">Compact</MenuItem>
            <MenuItem value="standard">Standard</MenuItem>
            <MenuItem value="comfortable">Comfortable</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {/* Border Radius */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Border radius: {theme.borderRadius}px
        </Typography>
        <Slider
          value={theme.borderRadius}
          onChange={(_e, value) => controller.updateTheme({ borderRadius: value as number })}
          min={0}
          max={24}
          step={1}
          marks={[
            { value: 0, label: '0' },
            { value: 4, label: '4' },
            { value: 8, label: '8' },
            { value: 16, label: '16' },
            { value: 24, label: '24' },
          ]}
          valueLabelDisplay="auto"
        />
      </Box>

      {/* Font Family */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Typography
        </Typography>
        <FormControl size="small" fullWidth>
          <InputLabel>Font family</InputLabel>
          <Select
            label="Font family"
            value={theme.fontFamily}
            onChange={(e) => controller.updateTheme({ fontFamily: e.target.value })}
          >
            {FONT_FAMILIES.map((font) => (
              <MenuItem key={font.value} value={font.value} sx={{ fontFamily: font.value }}>
                {font.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Stack>
  );
}
