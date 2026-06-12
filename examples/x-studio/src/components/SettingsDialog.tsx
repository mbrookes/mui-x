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
  Switch,
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

export type SidebarLayout = 'stacked' | 'tabbed';
export type SidebarSide = 'left' | 'right';
export type TableSourceMode = 'explicit' | 'implicit';
export type DatasetMode = 'sales' | 'ag-studio';

export interface SettingsValues {
  sidebarLayout: SidebarLayout;
  sidebarSide: SidebarSide;
  tableSourceMode: TableSourceMode;
  stackBreakpoint: number;
  rowCount: number | undefined;
  adapterEnabled: boolean;
  dataset: DatasetMode;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  values: SettingsValues;
  onSidebarLayoutChange: (layout: SidebarLayout) => void;
  onSidebarSideChange: (side: SidebarSide) => void;
  onTableSourceModeChange: (mode: TableSourceMode) => void;
  onStackBreakpointChange: (breakpoint: number) => void;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
}

// react-doctor-disable-next-line react-doctor/prefer-useReducer, react-doctor/no-event-handler -- dialog state is intentionally buffered locally and immediate prop callbacks are acceptable in this form
export function SettingsDialog(props: SettingsDialogProps) {
  // react-doctor-disable-next-line react-doctor/no-event-handler -- immediate prop callbacks are acceptable in this small settings form
  const { open, onClose, values, onSidebarLayoutChange, onSidebarSideChange } = props;
  const { onTableSourceModeChange, onStackBreakpointChange, featureFlags } = props;
  const { onFeatureFlagsChange, locale, onLocaleChange } = props;

  const t = useAppLocaleText();
  const [tab, setTab] = React.useState(0);
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [rowInput, setRowInput] = React.useState(
    values.rowCount !== undefined ? String(values.rowCount) : '',
  );
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingRowCount, setPendingRowCount] = React.useState<number | undefined>(values.rowCount);
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingAdapter, setPendingAdapter] = React.useState(values.adapterEnabled);
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingDataset, setPendingDataset] = React.useState<DatasetMode>(values.dataset);

  // Sync local state when dialog re-opens
  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change, react-doctor/no-cascading-set-state -- intentional batch reset of buffered form state when dialog opens
  React.useEffect(() => {
    if (open) {
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setRowInput(values.rowCount !== undefined ? String(values.rowCount) : '');
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingRowCount(values.rowCount);
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingAdapter(values.adapterEnabled);
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingDataset(values.dataset);
    }
  }, [open, values.rowCount, values.adapterEnabled, values.dataset]);

  const needsReload =
    pendingRowCount !== values.rowCount ||
    pendingAdapter !== values.adapterEnabled ||
    pendingDataset !== values.dataset;

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
    if (pendingRowCount !== undefined) {
      url.searchParams.set('rows', String(pendingRowCount));
    } else {
      url.searchParams.delete('rows');
    }
    if (pendingAdapter) {
      url.searchParams.set('adapter', '');
    } else {
      url.searchParams.delete('adapter');
    }
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
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 2 }}>
        {tab === 0 && (
          <React.Fragment>
            {/* Dataset — requires reload (top) */}
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

            {/* Language — immediate */}
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

            {/* Sidebar layout — immediate */}
            <FormControl>
              <FormLabel>{t.sidebarLayoutLabel}</FormLabel>
              <RadioGroup
                row
                value={values.sidebarLayout}
                onChange={(_evt, val) => onSidebarLayoutChange(val as SidebarLayout)}
              >
                <FormControlLabel
                  value="tabbed"
                  control={<Radio size="small" />}
                  label={t.sidebarLayoutTabbed}
                />
                <FormControlLabel
                  value="stacked"
                  control={<Radio size="small" />}
                  label={t.sidebarLayoutStacked}
                />
              </RadioGroup>
            </FormControl>

            {/* Sidebar side — immediate */}
            <FormControl>
              <FormLabel>{t.sidebarPositionLabel}</FormLabel>
              <RadioGroup
                row
                value={values.sidebarSide}
                onChange={(_evt, val) => onSidebarSideChange(val as SidebarSide)}
              >
                <FormControlLabel
                  value="left"
                  control={<Radio size="small" />}
                  label={t.sidebarPositionLeft}
                />
                <FormControlLabel
                  value="right"
                  control={<Radio size="small" />}
                  label={t.sidebarPositionRight}
                />
              </RadioGroup>
            </FormControl>

            {/* Table source mode — immediate */}
            <FormControl>
              <FormLabel>{t.tableSourceModeLabel}</FormLabel>
              <RadioGroup
                row
                value={values.tableSourceMode}
                onChange={(_evt, val) => onTableSourceModeChange(val as TableSourceMode)}
              >
                <FormControlLabel
                  value="explicit"
                  control={<Radio size="small" />}
                  label={t.tableSourceExplicit}
                />
                <FormControlLabel
                  value="implicit"
                  control={<Radio size="small" />}
                  label={t.tableSourceImplicit}
                />
              </RadioGroup>
            </FormControl>

            {/* Responsive stack breakpoint — immediate */}
            <TextField
              label={t.stackBreakpointLabel}
              helperText={t.stackBreakpointHelper}
              value={values.stackBreakpoint}
              onChange={(evt) => {
                const n = Number.parseInt(evt.target.value, 10);
                if (Number.isFinite(n) && n >= 0) {
                  onStackBreakpointChange(n);
                }
              }}
              size="small"
              type="number"
              slotProps={{
                input: { endAdornment: <InputAdornment position="end">px</InputAdornment> },
                htmlInput: { min: 0, step: 100 },
              }}
            />

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

            {/* Adapter mode — requires reload */}
            <FormControlLabel
              control={
                <Switch
                  checked={pendingAdapter}
                  onChange={(_evt, checked) => setPendingAdapter(checked)}
                  size="small"
                />
              }
              label={t.serverAdapterLabel}
            />

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

            {/* Dev server connection — informational only (set via .env.local) */}
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
        <Button onClick={onClose}>{t.closeButtonLabel}</Button>
        {tab === 0 && needsReload && (
          <Button variant="contained" onClick={applyAndReload}>
            {t.applyReloadButtonLabel}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
