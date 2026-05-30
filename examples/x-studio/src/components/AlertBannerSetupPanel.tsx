import * as React from 'react';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioSelector } from '@mui/x-studio';
import type { StudioCustomWidgetSetupPanelProps } from '@mui/x-studio';

type Severity = 'success' | 'info' | 'warning' | 'error';

const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

/**
 * Compose-drawer setup panel for the Alert Banner custom widget.
 * Edits `widget.config.customConfig.title`, `message`, and `severity`.
 */
export function AlertBannerSetupPanel({ widgetId }: StudioCustomWidgetSetupPanelProps) {
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);

  if (!widget) {
    return null;
  }

  const custom = (widget.config.customConfig ?? {}) as Record<string, unknown>;
  const title = (custom.title as string | undefined) ?? '';
  const message = (custom.message as string | undefined) ?? '';
  const severity = (custom.severity as Severity | undefined) ?? 'info';

  function updateCustomConfig(changes: Record<string, unknown>) {
    controller.updateWidgetConfig(widgetId, {
      customConfig: { ...custom, ...changes },
    });
  }

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2" color="text.secondary">
        Alert Banner settings
      </Typography>
      <TextField
        label="Title (optional)"
        value={title}
        onChange={(e) => updateCustomConfig({ title: e.target.value })}
        size="small"
        fullWidth
      />
      <TextField
        label="Message"
        value={message}
        onChange={(e) => updateCustomConfig({ message: e.target.value })}
        size="small"
        fullWidth
        multiline
        rows={3}
      />
      <FormControl size="small" fullWidth>
        <InputLabel>Severity</InputLabel>
        <Select
          value={severity}
          label="Severity"
          onChange={(e) => updateCustomConfig({ severity: e.target.value as Severity })}
        >
          {SEVERITY_OPTIONS.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
}
