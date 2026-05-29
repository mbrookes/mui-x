import * as React from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Switch,
} from '@mui/material';
import type { StudioFeatureFlags } from '@mui/x-studio';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
}

const WIDGET_KIND_FLAGS: { key: keyof StudioFeatureFlags; label: string }[] = [
  { key: 'grid', label: 'Table' },
  { key: 'chart', label: 'Chart' },
  { key: 'kpi', label: 'KPI' },
  { key: 'text', label: 'Text' },
  { key: 'filter', label: 'Filter widget' },
  { key: 'pivot', label: 'Pivot table' },
  { key: 'map', label: 'Map' },
];

const WIDGET_FEATURE_FLAGS: { key: keyof StudioFeatureFlags; label: string }[] = [
  { key: 'compose', label: 'Compose / edit mode' },
  { key: 'filters', label: 'Filters panel' },
  { key: 'savedFilterViews', label: 'Saved filter views' },
  { key: 'dataManagement', label: 'Data management drawer' },
  { key: 'aiChat', label: 'AI chat assistant' },
  { key: 'kpiSparkline', label: 'KPI sparkline' },
  { key: 'kpiTrend', label: 'KPI trend indicator' },
  { key: 'kpiTarget', label: 'KPI target line' },
  { key: 'chartAnnotations', label: 'Chart annotations' },
  { key: 'gridGroupBy', label: 'Table group by' },
  { key: 'gridSummary', label: 'Table summary row' },
  { key: 'gridConditionalFormats', label: 'Table conditional formats' },
];

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onClose, featureFlags, onFeatureFlagsChange } = props;

  function handleFlagToggle(key: keyof StudioFeatureFlags, checked: boolean) {
    onFeatureFlagsChange({ ...featureFlags, [key]: checked });
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Settings</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 0.5 }}>Widget types</FormLabel>
          {WIDGET_KIND_FLAGS.map(({ key, label }) => (
            <FormControlLabel
              key={key}
              control={
                <Switch
                  size="small"
                  checked={(featureFlags[key] as boolean | undefined) !== false}
                  onChange={(_evt, checked) => handleFlagToggle(key, checked)}
                />
              }
              label={label}
            />
          ))}
        </FormControl>

        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 0.5 }}>Features</FormLabel>
          {WIDGET_FEATURE_FLAGS.map(({ key, label }) => (
            <FormControlLabel
              key={key}
              control={
                <Switch
                  size="small"
                  checked={(featureFlags[key] as boolean | undefined) !== false}
                  onChange={(_evt, checked) => handleFlagToggle(key, checked)}
                />
              }
              label={label}
            />
          ))}
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
