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
import { useAppLocaleText } from '../locales/AppLocaleContext';

type Severity = 'success' | 'info' | 'warning' | 'error';

/**
 * Compose-drawer setup panel for the Alert Banner custom widget.
 * Edits `widget.config.customConfig.title`, `message`, and `severity`.
 */
export function AlertBannerSetupPanel({ widgetId }: StudioCustomWidgetSetupPanelProps) {
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const t = useAppLocaleText();

  if (!widget) {
    return null;
  }

  const severityOptions: { value: Severity; label: string }[] = [
    { value: 'info', label: t.alertSeverityInfo },
    { value: 'success', label: t.alertSeveritySuccess },
    { value: 'warning', label: t.alertSeverityWarning },
    { value: 'error', label: t.alertSeverityError },
  ];

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
        {t.alertBannerSettingsTitle}
      </Typography>
      <TextField
        label={t.alertTitleLabel}
        value={title}
        onChange={(event) => updateCustomConfig({ title: event.target.value })}
        size="small"
        fullWidth
      />
      <TextField
        label={t.alertMessageLabel}
        value={message}
        onChange={(event) => updateCustomConfig({ message: event.target.value })}
        size="small"
        fullWidth
        multiline
        rows={3}
      />
      <FormControl size="small" fullWidth>
        <InputLabel>{t.alertSeverityLabel}</InputLabel>
        <Select
          value={severity}
          label={t.alertSeverityLabel}
          onChange={(event) => updateCustomConfig({ severity: event.target.value as Severity })}
        >
          {severityOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
}
