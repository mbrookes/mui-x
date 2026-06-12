import * as React from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { StudioFeatureFlags } from '@mui/x-studio';
import { FeatureFlagSettings } from 'x-studio-shared';
import { type SupportedLocale, LOCALE_LABELS } from '../locales';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export type DatasetMode = 'sales' | 'ag-studio';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  dataset: DatasetMode;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onClose, dataset, featureFlags, onFeatureFlagsChange, locale, onLocaleChange } =
    props;
  const [tab, setTab] = React.useState(0);
  const [pendingDataset, setPendingDataset] = React.useState<DatasetMode>(dataset);
  const t = useAppLocaleText();

  React.useEffect(() => {
    if (open) {
      setPendingDataset(dataset);
    }
  }, [open, dataset]);

  const needsReload = pendingDataset !== dataset;

  function applyAndReload() {
    const url = new URL(window.location.href);
    if (pendingDataset === 'ag-studio') {
      url.searchParams.set('dataset', 'ag-studio');
    } else {
      url.searchParams.delete('dataset');
    }
    window.location.href = url.toString();
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 0 }}>{t.settingsDialogTitle}</DialogTitle>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ px: 3 }}>
        <Tab label={t.settingsTabLabel} />
        <Tab label={t.featuresTabLabel} />
      </Tabs>
      <DialogContent
        sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 2, overflowY: 'auto' }}
      >
        {tab === 0 && (
          <React.Fragment>
            <FormControl>
              <FormLabel>{t.datasetLabel}</FormLabel>
              <RadioGroup
                value={pendingDataset}
                onChange={(_evt, val) => setPendingDataset(val as DatasetMode)}
              >
                <FormControlLabel
                  value="sales"
                  control={<Radio size="small" />}
                  label={t.datasetSales}
                />
                <FormControlLabel
                  value="ag-studio"
                  control={<Radio size="small" />}
                  label={t.datasetAg}
                />
              </RadioGroup>
            </FormControl>

            {needsReload && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'flex', gap: 0.5 }}
              >
                <InfoOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
                {t.settingsReloadHint}
              </Typography>
            )}

            <Divider />

            <FormControl>
              <FormLabel>{t.languageLabel}</FormLabel>
              <RadioGroup
                value={locale}
                onChange={(_evt, val) => onLocaleChange(val as SupportedLocale)}
              >
                {(Object.entries(LOCALE_LABELS) as [SupportedLocale, string][]).map(
                  ([key, label]) => (
                    <FormControlLabel
                      key={key}
                      value={key}
                      control={<Radio size="small" />}
                      label={label}
                    />
                  ),
                )}
              </RadioGroup>
            </FormControl>

            <Divider />

            <FormControl>
              <FormLabel sx={{ mb: 1 }}>{t.devServerConnectionLabel}</FormLabel>
              {(import.meta.env.STUDIO_SERVER_URL as string | undefined) ? (
                <Typography variant="body2" color="text.secondary">
                  {t.devServerConnectedLabel}{' '}
                  <strong>{import.meta.env.STUDIO_SERVER_URL as string}</strong>
                  <br />
                  {t.devServerConnectedDescription}
                  <br />
                  {t.devServerChangeInstructions}
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.devServerNotConnectedDescription}
                </Typography>
              )}
            </FormControl>
          </React.Fragment>
        )}

        {tab === 1 && (
          <Box>
            <FeatureFlagSettings
              featureFlags={featureFlags}
              onFeatureFlagsChange={onFeatureFlagsChange}
            />
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {tab === 0 && needsReload && (
          <Button variant="contained" onClick={applyAndReload}>
            {t.applyReloadButtonLabel}
          </Button>
        )}
        <Button onClick={onClose}>{t.closeButtonLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}
