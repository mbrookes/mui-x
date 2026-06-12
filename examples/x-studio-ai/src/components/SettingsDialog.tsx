import * as React from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import { type SupportedLocale, LOCALE_LABELS } from '../locales';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
}

export function SettingsDialog({ open, onClose, locale, onLocaleChange }: SettingsDialogProps) {
  const [serverUrl, setServerUrl] = React.useState(
    () => (import.meta.env.STUDIO_SERVER_URL as string | undefined) ?? '',
  );

  const envServerUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
  const isEnvConfigured = Boolean(envServerUrl);
  const t = useAppLocaleText();

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>{t.settingsDialogTitle}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
        <FormControl>
          <FormLabel>{t.languageLabel}</FormLabel>
          <RadioGroup
            value={locale}
            onChange={(_event, value) => onLocaleChange(value as SupportedLocale)}
          >
            {(Object.entries(LOCALE_LABELS) as [SupportedLocale, string][]).map(([key, label]) => (
              <FormControlLabel
                key={key}
                value={key}
                control={<Radio size="small" />}
                label={label}
              />
            ))}
          </RadioGroup>
        </FormControl>

        <FormControl>
          <FormLabel sx={{ mb: 1 }}>{t.devServerConnectionLabel}</FormLabel>
          {isEnvConfigured ? (
            <Typography variant="body2" color="text.secondary">
              {t.devServerConnectedLabel} <strong>{envServerUrl}</strong>
              <br />
              {t.devServerConnectedDescription}
              <br />
              {t.devServerChangeInstructions}
            </Typography>
          ) : (
            <>
              <TextField
                size="small"
                label={t.serverUrlLabel}
                placeholder={t.serverUrlPlaceholder}
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                helperText={t.serverUrlHelper}
              />
              {serverUrl && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                  {t.serverUrlSessionHint}
                </Typography>
              )}
            </>
          )}
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.closeButtonLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}
