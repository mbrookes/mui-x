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
}

// react-doctor-disable-next-line react-doctor/no-event-handler -- immediate prop callbacks are acceptable in this small settings form
export function SettingsDialog(props: SettingsDialogProps) {
  // react-doctor-disable-next-line react-doctor/no-event-handler -- immediate prop callbacks are acceptable in this small settings form
  const { open, onClose, values, onSidebarSideChange } = props;

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
      <DialogTitle>Settings</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
        {/* Dataset — requires reload */}
        <FormControl component="fieldset">
          <FormLabel component="legend">Dataset</FormLabel>
          <RadioGroup
            value={pendingDataSource}
            onChange={(_evt, val) => setPendingDataSource(val as DatasetOption)}
          >
            <FormControlLabel
              value="sales"
              control={<Radio size="small" />}
              label="Sales (default)"
            />
            <FormControlLabel
              value="ag-studio"
              control={<Radio size="small" />}
              label="AG Studio Data"
            />
          </RadioGroup>
        </FormControl>

        <Divider />

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
            Changes take effect after reload.
          </Typography>
        )}
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
