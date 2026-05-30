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

export type SidebarLayout = 'stacked' | 'tabbed';
export type SidebarSide = 'left' | 'right';
export type TableSourceMode = 'explicit' | 'implicit';

export interface SettingsValues {
  sidebarLayout: SidebarLayout;
  sidebarSide: SidebarSide;
  tableSourceMode: TableSourceMode;
  stackBreakpoint: number;
  rowCount: number | undefined;
  adapterEnabled: boolean;
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

const WIDGET_FEATURE_FLAGS: { key: keyof StudioFeatureFlags; label: string; parentKey?: keyof StudioFeatureFlags }[] = [
  { key: 'compose', label: 'Compose panel' },
  { key: 'filters', label: 'Filters panel' },
  { key: 'savedFilterViews', label: 'Saved filter views' },
  { key: 'dataManagement', label: 'Data management drawer' },
  { key: 'relationships', label: 'Relationships panel', parentKey: 'dataManagement' },
  { key: 'widgetFilters', label: 'Widget filters tab' },
  { key: 'aiChat', label: 'AI chat assistant' },
  { key: 'calculatedFields', label: 'Calculated fields (all)' },
  { key: 'kpiCalculatedFields', label: 'KPI calculated fields', parentKey: 'calculatedFields' },
  { key: 'chartCalculatedFields', label: 'Chart calculated fields', parentKey: 'calculatedFields' },
  { key: 'gridCalculatedFields', label: 'Table calculated fields', parentKey: 'calculatedFields' },
  { key: 'kpiSparkline', label: 'KPI sparkline', parentKey: 'kpi' },
  { key: 'kpiTrend', label: 'KPI trend indicator', parentKey: 'kpi' },
  { key: 'kpiTarget', label: 'KPI target line', parentKey: 'kpi' },
  { key: 'chartAnnotations', label: 'Chart annotations', parentKey: 'chart' },
  { key: 'gridGroupBy', label: 'Table group by', parentKey: 'grid' },
  { key: 'gridSummary', label: 'Table summary row', parentKey: 'grid' },
  { key: 'gridConditionalFormats', label: 'Table conditional formats', parentKey: 'grid' },
];

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
  } = props;

  const [rowInput, setRowInput] = React.useState(
    values.rowCount !== undefined ? String(values.rowCount) : '',
  );
  const [pendingRowCount, setPendingRowCount] = React.useState<number | undefined>(values.rowCount);
  const [pendingAdapter, setPendingAdapter] = React.useState(values.adapterEnabled);

  // Sync local state when dialog re-opens
  React.useEffect(() => {
    if (open) {
      setRowInput(values.rowCount !== undefined ? String(values.rowCount) : '');
      setPendingRowCount(values.rowCount);
      setPendingAdapter(values.adapterEnabled);
    }
  }, [open, values.rowCount, values.adapterEnabled]);

  const needsReload =
    pendingRowCount !== values.rowCount || pendingAdapter !== values.adapterEnabled;

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
    window.location.href = url.toString();
  }

  function handleFlagToggle(key: keyof StudioFeatureFlags, checked: boolean) {
    onFeatureFlagsChange({ ...featureFlags, [key]: checked });
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

        {/* Feature flags — widget kinds */}
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 0.5 }}>
            Widget types
          </FormLabel>
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

        {/* Feature flags — UI features */}
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 0.5 }}>
            Features
          </FormLabel>
          {WIDGET_FEATURE_FLAGS.map(({ key, label, parentKey }) => {
            const parentDisabled = parentKey
              ? (featureFlags[parentKey] as boolean | undefined) === false
              : false;
            return (
              <FormControlLabel
                key={key}
                control={
                  <Switch
                    size="small"
                    checked={!parentDisabled && (featureFlags[key] as boolean | undefined) !== false}
                    disabled={parentDisabled}
                    onChange={(_evt, checked) => handleFlagToggle(key, checked)}
                  />
                }
                label={label}
              />
            );
          })}
        </FormControl>
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
