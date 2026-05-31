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
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { StudioFeatureFlags } from '@mui/x-studio';
import { FeatureFlagSettings } from 'x-studio-shared';

export type DatasetMode = 'sales' | 'ag-studio';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  dataset: DatasetMode;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onClose, dataset, featureFlags, onFeatureFlagsChange } = props;

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
      <DialogTitle>Settings</DialogTitle>
      <DialogContent
        sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1, overflowY: 'auto' }}
      >
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

        {needsReload && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', gap: 0.5 }}>
            <InfoOutlinedIcon sx={{ fontSize: 14, mt: '1px' }} />
            Dataset changes take effect after reload.
          </Typography>
        )}

        <Divider />

        <FeatureFlagSettings
          featureFlags={featureFlags}
          onFeatureFlagsChange={onFeatureFlagsChange}
        />
      </DialogContent>
      <DialogActions>
        {needsReload && (
          <Button variant="contained" onClick={applyAndReload}>
            Apply &amp; reload
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
