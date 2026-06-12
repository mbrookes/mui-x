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
      <DialogTitle sx={{ pb: 0 }}>Settings</DialogTitle>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ px: 3 }}>
        <Tab label="Settings" />
        <Tab label="Features" />
      </Tabs>
      <DialogContent
        sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 2, overflowY: 'auto' }}
      >
        {tab === 0 && (
          <React.Fragment>
            {/* Dataset — requires reload (top) */}
            <FormControl>
              <FormLabel>Dataset</FormLabel>
              <RadioGroup
                value={pendingDataset}
                onChange={(_evt, val) => setPendingDataset(val as DatasetMode)}
              >
                <FormControlLabel
                  value="sales"
                  control={<Radio size="small" />}
                  label="MUI X Sales (generated)"
                />
                <FormControlLabel
                  value="ag-studio"
                  control={<Radio size="small" />}
                  label="AG Studio Office Supplies"
                />
              </RadioGroup>
            </FormControl>

            {needsReload && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', gap: 0.5 }}>
                <InfoOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
                Dataset changes take effect after reload.
              </Typography>
            )}

            <Divider />

            {/* Language — immediate, no reload needed */}
            <FormControl>
              <FormLabel>Language</FormLabel>
              <RadioGroup
                value={locale}
                onChange={(_evt, val) => onLocaleChange(val as SupportedLocale)}
              >
                {(Object.entries(LOCALE_LABELS) as [SupportedLocale, string][]).map(([key, label]) => (
                  <FormControlLabel key={key} value={key} control={<Radio size="small" />} label={label} />
                ))}
              </RadioGroup>
            </FormControl>

            <Divider />

            {/* Dev server connection — informational only (set via .env.local) */}
            <FormControl>
              <FormLabel sx={{ mb: 1 }}>Dev Server Connection</FormLabel>
              {(import.meta.env.STUDIO_SERVER_URL as string | undefined) ? (
                <Typography variant="body2" color="text.secondary">
                  Connected to:{' '}
                  <strong>{import.meta.env.STUDIO_SERVER_URL as string}</strong>
                  <br />
                  AI and data queries are routed through the dev server.
                  <br />
                  To change, update <code>STUDIO_SERVER_URL</code> in{' '}
                  <code>.env.local</code>.
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Not connected. Set <code>STUDIO_SERVER_URL</code> in{' '}
                  <code>.env.local</code> to route queries through{' '}
                  <code>examples/x-studio-dev-server</code>.
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
            Apply &amp; reload
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
