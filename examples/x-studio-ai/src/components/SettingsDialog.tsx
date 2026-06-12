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

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Settings</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
        <FormControl>
          <FormLabel>Language</FormLabel>
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
          <FormLabel sx={{ mb: 1 }}>Dev Server Connection</FormLabel>
          {isEnvConfigured ? (
            <Typography variant="body2" color="text.secondary">
              Connected to: <strong>{envServerUrl}</strong>
              <br />
              AI and data queries are routed through the dev server.
              <br />
              To change, update <code>STUDIO_SERVER_URL</code> in <code>.env.local</code>.
            </Typography>
          ) : (
            <>
              <TextField
                size="small"
                label="Server URL"
                placeholder="http://localhost:3020"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                helperText="Optional. Set STUDIO_SERVER_URL in .env.local to persist."
              />
              {serverUrl && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                  URL changes here apply only for this session — the page must reload to take
                  effect. Add to .env.local to persist.
                </Typography>
              )}
            </>
          )}
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
