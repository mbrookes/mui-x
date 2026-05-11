'use client';
import * as React from 'react';
import { Box, Dialog, DialogTitle, IconButton, Stack, Tab, Tabs, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useStudioSelector, selectWidgets } from '../context';
import { KIND_LABEL } from '../StudioComposeDrawer/StudioComposeDrawer';
import { ChartSetupPanel } from '../StudioComposeDrawer/ChartSetupPanel';
import { FilterSetupPanel } from '../StudioComposeDrawer/FilterSetupPanel';
import { FormatPanel } from '../StudioComposeDrawer/FormatPanel';
import { GridSetupPanel } from '../StudioComposeDrawer/GridSetupPanel';
import { KpiSetupPanel } from '../StudioComposeDrawer/KpiSetupPanel';
import { TextFormatPanel } from '../StudioComposeDrawer/TextFormatPanel';
import { TextSetupPanel } from '../StudioComposeDrawer/TextSetupPanel';
import { WidgetFiltersPanel } from './WidgetFiltersPanel';

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
  /** The live-rendered widget content to show in the preview panel. */
  children: React.ReactNode;
}

export function StudioWidgetEditDialog(props: StudioWidgetEditDialogProps) {
  const { open, onClose, widgetId, children } = props;
  const [tab, setTab] = React.useState(0);
  const widgets = useStudioSelector(selectWidgets);
  const widget = widgets[widgetId];

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

  const kindLabel = KIND_LABEL[widget.kind] ?? widget.kind;

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
        <Box sx={{ flex: 1, overflow: 'hidden', p: 2 }}>{children}</Box>
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
              {widget.title || `Untitled ${kindLabel}`}
            </Typography>
          </Box>
          <IconButton size="small" onClick={onClose} aria-label="Close edit dialog" sx={{ ml: 1 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>

        {/* Tabs */}
        <Tabs
          value={tab}
          onChange={handleTabChange}
          sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}
        >
          <Tab label="Setup" />
          <Tab label="Filters" />
          <Tab label="Format" />
        </Tabs>

        {/* Tab panels — scrollable */}
        <TabPanel value={tab} index={0}>
          {widget.kind === 'chart' && <ChartSetupPanel widgetId={widgetId} />}
          {widget.kind === 'grid' && <GridSetupPanel widgetId={widgetId} />}
          {widget.kind === 'kpi' && <KpiSetupPanel widgetId={widgetId} />}
          {widget.kind === 'text' && <TextSetupPanel widgetId={widgetId} />}
          {widget.kind === 'filter' && <FilterSetupPanel widgetId={widgetId} />}
        </TabPanel>

        <TabPanel value={tab} index={1}>
          <WidgetFiltersPanel widgetId={widgetId} />
        </TabPanel>

        <TabPanel value={tab} index={2}>
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
