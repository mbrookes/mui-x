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
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useAppLocaleText } from '../locales/AppLocaleContext';
import { LOCALE_LABELS, type SupportedLocale } from '../locales/index';

export type DatasetOption = 'sales' | 'ag-studio';
export type SidebarSide = 'left' | 'right';

export interface SettingsValues {
  dataSource: DatasetOption;
  sidebarSide: SidebarSide;
  rowCount: number | undefined;
  adapterEnabled: boolean;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  values: SettingsValues;
  onSidebarSideChange: (side: SidebarSide) => void;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
}

// react-doctor-disable-next-line react-doctor/no-event-handler -- immediate prop callbacks are acceptable in this small settings form
export function SettingsDialog(props: SettingsDialogProps) {
  // react-doctor-disable-next-line react-doctor/no-event-handler -- immediate prop callbacks are acceptable in this small settings form
  const { open, onClose, values, onSidebarSideChange, locale, onLocaleChange } = props;
  const t = useAppLocaleText();

  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingDataSource, setPendingDataSource] = React.useState<DatasetOption>(
    values.dataSource,
  );

  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [rowInput, setRowInput] = React.useState(
    values.rowCount !== undefined ? String(values.rowCount) : '',
  );
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingRowCount, setPendingRowCount] = React.useState<number | undefined>(values.rowCount);
  // react-doctor-disable-next-line react-doctor/no-derived-state -- editable form copy seeded from props
  const [pendingAdapter, setPendingAdapter] = React.useState(values.adapterEnabled);

  // Sync local state when dialog re-opens
  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change, react-doctor/no-cascading-set-state -- intentional batch reset of buffered form state when dialog opens
  React.useEffect(() => {
    if (open) {
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingDataSource(values.dataSource);
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setRowInput(values.rowCount !== undefined ? String(values.rowCount) : '');
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingRowCount(values.rowCount);
      // react-doctor-disable-next-line react-doctor/no-derived-state -- form copy resets on open
      setPendingAdapter(values.adapterEnabled);
    }
  }, [open, values.dataSource, values.rowCount, values.adapterEnabled]);

  const needsReload =
    pendingDataSource !== values.dataSource ||
    pendingRowCount !== values.rowCount ||
    pendingAdapter !== values.adapterEnabled;

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
    if (pendingDataSource === 'ag-studio') {
      url.searchParams.set('dataset', 'ag-studio');
    } else {
      url.searchParams.delete('dataset');
    }
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
    window.location.href = url.toString();
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t.settingsDialogTitle}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
        {/* Language — immediate */}
        <FormControl size="small">
          <FormLabel sx={{ mb: 0.5 }}>{t.languageLabel}</FormLabel>
          <Select
            value={locale}
            onChange={(e) => onLocaleChange(e.target.value as SupportedLocale)}
            size="small"
          >
            {(Object.keys(LOCALE_LABELS) as SupportedLocale[]).map((key) => (
              <MenuItem key={key} value={key}>
                {LOCALE_LABELS[key]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Divider />

        {/* Dataset — requires reload */}
        <FormControl component="fieldset">
          <FormLabel component="legend">{t.datasetLabel}</FormLabel>
          <RadioGroup
            value={pendingDataSource}
            onChange={(_evt, val) => setPendingDataSource(val as DatasetOption)}
          >
            <FormControlLabel
              value="sales"
              control={<Radio size="small" />}
              label={t.datasetSalesLabel}
            />
            <FormControlLabel
              value="ag-studio"
              control={<Radio size="small" />}
              label={t.datasetAgLabel}
            />
          </RadioGroup>
        </FormControl>

        <Divider />

        {/* Sidebar side — immediate */}
        <FormControl>
          <FormLabel>{t.sidebarPositionLabel}</FormLabel>
          <RadioGroup
            row
            value={values.sidebarSide}
            onChange={(_evt, val) => onSidebarSideChange(val as SidebarSide)}
          >
            <FormControlLabel value="left" control={<Radio size="small" />} label={t.sidebarLeft} />
            <FormControlLabel
              value="right"
              control={<Radio size="small" />}
              label={t.sidebarRight}
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
          label={t.serverAdapterLabel}
        />

        {needsReload && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', gap: 0.5 }}>
            <InfoOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
            {t.reloadNotice}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.closeButton}</Button>
        {needsReload && (
          <Button variant="contained" onClick={applyAndReload}>
            {t.applyReloadButton}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
