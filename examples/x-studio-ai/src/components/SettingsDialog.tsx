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
} from '@mui/material';
import { type SupportedLocale, LOCALE_LABELS } from '../locales';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
}

export function SettingsDialog({
  open,
  onClose,
  locale,
  onLocaleChange,
}: SettingsDialogProps) {
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
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
