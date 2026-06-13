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
  InputAdornment,
  Radio,
  RadioGroup,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { StudioFeatureFlags } from '@mui/x-studio';
import { FeatureFlagSettings } from 'x-studio-shared';
import { type SupportedLocale, LOCALE_LABELS } from '../locales';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export type DatasetMode = 'sales' | 'ag-studio';
export type DataMode = 'memory' | 'adapter' | 'server';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  dataset: DatasetMode;
  rowCount: number | undefined;
  dataMode: DataMode;
  serverConfigured: boolean;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const {
    open,
    onClose,
    dataset,
    rowCount,
    dataMode,
    serverConfigured,
    featureFlags,
    onFeatureFlagsChange,
    locale,
    onLocaleChange,
  } = props;
  const [tab, setTab] = React.useState(0);
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingDataset, setPendingDataset] = React.useState<DatasetMode>(dataset);
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [rowInput, setRowInput] = React.useState(rowCount !== undefined ? String(rowCount) : '');
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingRowCount, setPendingRowCount] = React.useState<number | undefined>(rowCount);
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingMode, setPendingMode] = React.useState<DataMode>(dataMode);
  const t = useAppLocaleText();

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change, react-doctor/no-cascading-set-state -- intentional batch reset of buffered form state when dialog opens
  React.useEffect(() => {
    if (open) {
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingDataset(dataset);
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setRowInput(rowCount !== undefined ? String(rowCount) : '');
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingRowCount(rowCount);
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingMode(dataMode);
    }
  }, [open, dataset, rowCount, dataMode]);

  const needsReload =
    pendingDataset !== dataset || pendingRowCount !== rowCount || pendingMode !== dataMode;

  function handleRowInputChange(evt: React.ChangeEvent<HTMLInputElement>) {
    const raw = evt.target.value;
    setRowInput(raw);
    if (raw === '') {
      setPendingRowCount(undefined);
    } else {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) {
        setPendingRowCount(n);
      }
    }
  }

  function applyAndReload() {
    const url = new URL(window.location.href);
    if (pendingDataset === 'ag-studio') {
      url.searchParams.set('dataset', 'ag-studio');
    } else {
      url.searchParams.delete('dataset');
    }
    if (pendingRowCount !== undefined) {
      url.searchParams.set('rows', String(pendingRowCount));
    } else {
      url.searchParams.delete('rows');
    }
    // Omit ?mode when the selected mode is already the natural default so URLs stay clean.
    // The legacy ?adapter param is removed in favour of the explicit ?mode param.
    url.searchParams.delete('adapter');
    const naturalDefault: DataMode = serverConfigured ? 'server' : 'memory';
    if (pendingMode === naturalDefault) {
      url.searchParams.delete('mode');
    } else {
      url.searchParams.set('mode', pendingMode);
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

            <Divider />

            {/* Data rows — requires reload */}
            <TextField
              label={t.rowCountLabel}
              helperText={t.rowCountHelper}
              value={rowInput}
              onChange={handleRowInputChange}
              size="small"
              type="number"
              slotProps={{
                input: {
                  endAdornment: <InputAdornment position="end">{t.rowCountUnit}</InputAdornment>,
                },
                htmlInput: { min: 1, step: 1 },
              }}
            />

            {/* Data source mode — requires reload */}
            <FormControl>
              <FormLabel>{t.dataSourceModeLabel}</FormLabel>
              <RadioGroup
                value={pendingMode}
                onChange={(_evt, val) => setPendingMode(val as DataMode)}
              >
                <FormControlLabel
                  value="memory"
                  control={<Radio size="small" />}
                  label={t.dataModeMemory}
                />
                <FormControlLabel
                  value="adapter"
                  control={<Radio size="small" />}
                  label={t.serverAdapterLabel}
                />
                <FormControlLabel
                  value="server"
                  control={<Radio size="small" />}
                  label={t.serverModeLabel}
                  disabled={!serverConfigured}
                />
              </RadioGroup>
              {!serverConfigured && (
                <Typography variant="caption" color="text.secondary">
                  {t.dataModeServerUnavailableHint}
                </Typography>
              )}
              {pendingRowCount !== undefined && pendingMode === 'server' && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'flex', gap: 0.5 }}
                >
                  <InfoOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
                  {t.rowCountOverridesServerHint}
                </Typography>
              )}
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
