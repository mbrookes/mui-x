'use client';
import * as React from 'react';
import { Box, Dialog, DialogTitle, IconButton, Stack, Tab, Tabs, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useStudioSelector, selectWidgets } from '../../context';
import { useStudioFeatures, useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { useWidgetDefMap } from '../../internals/builtinWidgetDefs';
import { useWidgetKindLabels } from '../StudioComposeDrawer/StudioComposeDrawerLabels';
import { FormatPanel } from '../StudioComposeDrawer/FormatPanel';
import { TextFormatPanel } from '../StudioComposeDrawer/TextFormatPanel';
import { WidgetFiltersPanel } from './WidgetFiltersPanel';
import { BuiltinWidgetPreview } from './BuiltinWidgetPreview';

// ── Tab panel ─────────────────────────────────────────────────────────────────

function TabPanel(props: { children: React.ReactNode; value: number; index: number }) {
  const { children, value, index } = props;
  return (
    <Box
      role="tabpanel"
      hidden={value !== index}
      sx={{ overflowY: 'auto', flex: 1, p: 2.5, pt: 1.5 }}
    >
      {value === index ? children : null}
    </Box>
  );
}

// ── Main dialog ───────────────────────────────────────────────────────────────

export interface StudioWidgetEditDialogProps {
  open: boolean;
  onClose: () => void;
  widgetId: string;
  /**
   * The live-rendered widget content to show in the preview panel.
   * When omitted, the dialog renders the widget automatically based on its kind.
   */
  children?: React.ReactNode;
}

export function StudioWidgetEditDialog(props: StudioWidgetEditDialogProps) {
  const { open, onClose, widgetId, children } = props;
  const [tab, setTab] = React.useState(0);
  const widgets = useStudioSelector(selectWidgets);
  const widget = widgets[widgetId];
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const widgetDefMap = useWidgetDefMap();
  const def = widget ? widgetDefMap.get(widget.kind) : undefined;
  // Text widgets render static content and don't query a data source, so widget filters
  // are meaningless for them (matches the filters drawer); hide the Filters tab entirely.
  // Consolidated into `capabilities.widgetFilters` (defaults to applicable for any kind
  // that doesn't explicitly opt out).
  const showFiltersTab =
    features.widgetFilters !== false && def?.capabilities?.widgetFilters !== false;
  const widgetKindLabels = useWidgetKindLabels();

  const handleTabChange = React.useCallback(
    (_event: React.SyntheticEvent, v: number) => setTab(v),
    [],
  );

  const handleClose = React.useCallback(() => {
    setTab(0);
    onClose();
  }, [onClose]);

  if (!widget) {
    return null;
  }

  const kindLabel = widgetKindLabels[widget.kind] ?? widget.kind;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="xl"
      fullWidth
      onClick={(event) => event.stopPropagation()}
      slotProps={{
        paper: {
          sx: {
            height: '85vh',
            display: 'flex',
            flexDirection: 'row',
            overflow: 'hidden',
          },
        },
      }}
    >
      {/* ── Left: widget preview ────────────────────────────────────────── */}
      <Box
        sx={{
          flex: 8,
          flexShrink: 0,
          bgcolor: 'action.hover',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRight: 1,
          borderColor: 'divider',
        }}
      >
        {/* Preview header */}
        <Stack
          direction="row"
          spacing={1}
          sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', alignItems: 'center' }}
        >
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ display: 'block', lineHeight: 1.2 }}
          >
            {kindLabel} preview
          </Typography>
        </Stack>

        {/* Live widget */}
        <Box sx={{ flex: 1, overflow: 'hidden', p: 2 }}>
          {/* Card-style header mirrors the canvas widget card layout */}
          <Box sx={{ mb: 0.5, minWidth: 0 }}>
            <Typography variant="h6" noWrap>
              {widget.title || localeText.widgetUntitledLabel(kindLabel)}
            </Typography>
            {widget.subtitle && (
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                {widget.subtitle}
              </Typography>
            )}
          </Box>
          {children ?? <BuiltinWidgetPreview widgetId={widgetId} />}
        </Box>
      </Box>

      {/* ── Right: config panel ─────────────────────────────────────────── */}
      <Box
        sx={{
          flex: 4,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        {/* Title row */}
        <DialogTitle
          component="div"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            py: 1.5,
            px: 2,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: 'block', lineHeight: 1.2 }}
            >
              {kindLabel}
            </Typography>
            <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600 }}>
              {widget.title || localeText.widgetUntitledLabel(kindLabel)}
            </Typography>
          </Box>
          <IconButton
            size="small"
            // 3.8: use the component's own `handleClose` (which resets `tab` to 0), not the
            // raw `onClose` — otherwise closing via X on a later tab and reopening for a kind
            // with fewer tabs leaves `Tabs value` pointing past the rendered tab list.
            onClick={handleClose}
            aria-label={localeText.widgetEditDialogCloseAriaLabel}
            sx={{ ml: 1 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>

        {/* Tabs */}
        <Tabs
          value={tab}
          onChange={handleTabChange}
          sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}
        >
          <Tab label={localeText.widgetEditDialogTabSetup} />
          {showFiltersTab && <Tab label={localeText.widgetEditDialogTabFilters} />}
          <Tab label={localeText.widgetEditDialogTabFormat} />
        </Tabs>

        {/* Tab panels — scrollable. Setup-panel dispatch is a single lookup into the unified
            widget-kind registry, so custom widgets get their `setupPanel` rendered here too
            (previously this tab had no custom-widget handling at all and rendered blank). */}
        <TabPanel value={tab} index={0}>
          {def?.setupPanel && <def.setupPanel widgetId={widgetId} />}
        </TabPanel>

        {showFiltersTab && (
          <TabPanel value={tab} index={1}>
            <WidgetFiltersPanel widgetId={widgetId} />
          </TabPanel>
        )}

        <TabPanel value={tab} index={showFiltersTab ? 2 : 1}>
          {widget.kind === 'text' ? (
            <TextFormatPanel widgetId={widgetId} />
          ) : (
            <FormatPanel widgetId={widgetId} />
          )}
        </TabPanel>
      </Box>
    </Dialog>
  );
}
