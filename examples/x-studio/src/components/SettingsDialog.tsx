import * as React from 'react';
import {
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
  TextField,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { StudioFeatureFlags } from '@mui/x-studio';
import { FeatureFlagSettings } from 'x-studio-shared';
import { type SupportedLocale, LOCALE_LABELS } from '../locales';

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

export function SettingsDialog(props: SettingsDialogProps) {
  const {
    open,
    onClose,
    values,
    onSidebarLayoutChange,
    onSidebarSideChange,
    onTableSourceModeChange,
    onStackBreakpointChange,
    featureFlags,
    onFeatureFlagsChange,
    locale,
    onLocaleChange,
  } = props;

  const [rowInput, setRowInput] = React.useState(
    values.rowCount !== undefined ? String(values.rowCount) : '',
  );
  const [pendingRowCount, setPendingRowCount] = React.useState<number | undefined>(values.rowCount);
  const [pendingAdapter, setPendingAdapter] = React.useState(values.adapterEnabled);
  const [pendingDataset, setPendingDataset] = React.useState<DatasetMode>(values.dataset);

  // Sync local state when dialog re-opens
  React.useEffect(() => {
    if (open) {
      setRowInput(values.rowCount !== undefined ? String(values.rowCount) : '');
      setPendingRowCount(values.rowCount);
      setPendingAdapter(values.adapterEnabled);
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
      <DialogTitle>Settings</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
        {/* Sidebar layout — immediate */}
        <FormControl>
          <FormLabel>Sidebar layout</FormLabel>
          <RadioGroup
            row
            value={values.sidebarLayout}
            onChange={(_evt, val) => onSidebarLayoutChange(val as SidebarLayout)}
          >
            <FormControlLabel value="tabbed" control={<Radio size="small" />} label="Tabbed" />
            <FormControlLabel value="stacked" control={<Radio size="small" />} label="Stacked" />
          </RadioGroup>
        </FormControl>

        {/* Sidebar side — immediate */}
        <FormControl>
          <FormLabel>Sidebar position</FormLabel>
          <RadioGroup
            row
            value={values.sidebarSide}
            onChange={(_evt, val) => onSidebarSideChange(val as SidebarSide)}
          >
            <FormControlLabel value="left" control={<Radio size="small" />} label="Left" />
            <FormControlLabel value="right" control={<Radio size="small" />} label="Right" />
          </RadioGroup>
        </FormControl>

        {/* Table source mode — immediate */}
        <FormControl>
          <FormLabel>Table source mode</FormLabel>
          <RadioGroup
            row
            value={values.tableSourceMode}
            onChange={(_evt, val) => onTableSourceModeChange(val as TableSourceMode)}
          >
            <FormControlLabel
              value="explicit"
              control={<Radio size="small" />}
              label="Explicit (picker)"
            />
            <FormControlLabel
              value="implicit"
              control={<Radio size="small" />}
              label="Implicit (inferred)"
            />
          </RadioGroup>
        </FormControl>

        {/* Responsive stack breakpoint — immediate */}
        <TextField
          label="Responsive stack breakpoint"
          helperText="Canvas width (px) below which widgets stack. Set to 0 to disable."
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

        {/* Dataset — requires reload */}
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

        <Divider />

        {/* Data rows — requires reload */}
        <TextField
          label="Generated row count"
          helperText="Leave blank to use the default bundled data"
          value={rowInput}
          onChange={handleRowInputChange}
          size="small"
          type="number"
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">rows</InputAdornment> },
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
          label="Simulated server adapter"
        />

        {needsReload && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', gap: 0.5 }}>
            <InfoOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
            Row count and adapter changes take effect after reload.
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

        <FeatureFlagSettings
          featureFlags={featureFlags}
          onFeatureFlagsChange={onFeatureFlagsChange}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {needsReload && (
          <Button variant="contained" onClick={applyAndReload}>
            Apply &amp; Reload
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
