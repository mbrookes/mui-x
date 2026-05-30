import * as React from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import type { StudioFeatureFlags } from '@mui/x-studio';
import { FeatureFlagSettings } from 'x-studio-shared';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onClose, featureFlags, onFeatureFlagsChange } = props;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Settings</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
        <FeatureFlagSettings featureFlags={featureFlags} onFeatureFlagsChange={onFeatureFlagsChange} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

