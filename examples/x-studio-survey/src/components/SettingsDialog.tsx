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
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import type { StudioFeatureFlags } from '@mui/x-studio';
import { FeatureFlagSettings } from 'x-studio-shared';
import { type SupportedLocale, LOCALE_LABELS } from '../locales';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export type SidebarLayout = 'stacked' | 'tabbed';
export type SidebarSide = 'left' | 'right';
export type TableSourceMode = 'explicit' | 'implicit';

export interface SettingsValues {
  sidebarLayout: SidebarLayout;
  sidebarSide: SidebarSide;
  tableSourceMode: TableSourceMode;
  stackBreakpoint: number;
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
  const { open, onClose, values, onSidebarLayoutChange, onSidebarSideChange } = props;
  const { onTableSourceModeChange, onStackBreakpointChange, featureFlags } = props;
  const { onFeatureFlagsChange, locale, onLocaleChange } = props;

  const t = useAppLocaleText();
  const [tab, setTab] = React.useState(0);

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
            {/* Language — immediate */}
            <FormControl size="small" fullWidth>
              <InputLabel id="settings-language-label">{t.languageLabel}</InputLabel>
              <Select
                labelId="settings-language-label"
                label={t.languageLabel}
                value={locale}
                onChange={(evt) => onLocaleChange(evt.target.value as SupportedLocale)}
              >
                {(Object.entries(LOCALE_LABELS) as [SupportedLocale, string][]).map(
                  ([key, label]) => (
                    <MenuItem key={key} value={key}>
                      {label}
                    </MenuItem>
                  ),
                )}
              </Select>
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
          <div>
            <FeatureFlagSettings
              featureFlags={featureFlags}
              onFeatureFlagsChange={onFeatureFlagsChange}
            />
          </div>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.closeButtonLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}
