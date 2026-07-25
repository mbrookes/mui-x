'use client';
import * as React from 'react';
import { Box, Dialog, DialogTitle, IconButton, Stack, Tab, Tabs, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useStudioSelector, makeSelectWidget } from '../../context';
import { useStudioFeatures, useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { useWidgetDefMap } from '../../internals/builtinWidgetDefs';
import { lookup } from '../../utils/safeLookup';
import { StudioDrawerErrorBoundary } from '../../internals/StudioDrawerErrorBoundary';
import { useWidgetKindLabels } from '../StudioComposeDrawer/StudioComposeDrawerLabels';
import { FormatPanel } from '../StudioComposeDrawer/FormatPanel';
import { TextFormatPanel } from '../StudioComposeDrawer/TextFormatPanel';
import { WidgetFiltersPanel } from './WidgetFiltersPanel';
import { BuiltinWidgetPreview } from './BuiltinWidgetPreview';

// ── Tab panel ─────────────────────────────────────────────────────────────────

interface TabPanelProps {
  children: React.ReactNode;
  value: number;
  index: number;
  /** Referenced by the owning `<Tab>`'s `aria-controls`. */
  id: string;
  /** The owning `<Tab>`'s `id`. */
  labelledBy: string;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, id, labelledBy } = props;
  const selected = value === index;
  return (
    <Box
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      hidden={!selected}
      // The panel scrolls, and several of these panels contain stretches of read-only content
      // with no focusable child at all — without a tab stop of its own a keyboard-only user can
      // neither reach nor scroll it (WCAG 2.1.1). `tabIndex={0}` on the selected panel is the
      // APG tabs-pattern remedy; `Studio/TabbedSidebar.tsx` does the same for its panels.
      tabIndex={selected ? 0 : undefined}
      sx={{ overflowY: 'auto', flex: 1, p: 2.5, pt: 1.5 }}
    >
      {selected ? children : null}
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
  const selectWidgetFn = React.useMemo(() => makeSelectWidget(widgetId), [widgetId]);
  const widget = useStudioSelector(selectWidgetFn);
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
  // Unique per-mount id so two mounted <Studio> instances don't emit duplicate DOM ids
  // (matches `FieldDetailView.tsx` / `Studio/TabbedSidebar.tsx`). Wires each `<Tab>` to its
  // panel via `aria-controls`/`aria-labelledby`, which the tabs previously lacked entirely.
  const baseId = React.useId();
  const getTabId = (key: string) => `${baseId}-tab-${key}`;
  const getPanelId = (key: string) => `${baseId}-panel-${key}`;

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

  // `widget.kind` is doc/AI-authored and `StudioWidgetKind` is open (`string & {}`), so index
  // the label record through the prototype-chain-safe `lookup` — matching the guard
  // `StudioWidgetCard.tsx` already applies to this same map. A bare bracket lookup on
  // "toString" resolves the inherited function (truthy, so `??` never fires) and the dialog
  // title renders `function toString() { [native code] } preview`.
  const kindLabel = lookup(widgetKindLabels, widget.kind) ?? widget.kind;

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
            {localeText.widgetEditDialogPreviewLabel(kindLabel)}
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
          <Tab
            id={getTabId('setup')}
            aria-controls={getPanelId('setup')}
            label={localeText.widgetEditDialogTabSetup}
          />
          {showFiltersTab && (
            <Tab
              id={getTabId('filters')}
              aria-controls={getPanelId('filters')}
              label={localeText.widgetEditDialogTabFilters}
            />
          )}
          <Tab
            id={getTabId('format')}
            aria-controls={getPanelId('format')}
            label={localeText.widgetEditDialogTabFormat}
          />
        </Tabs>

        {/* Tab panels — scrollable. Setup-panel dispatch is a single lookup into the unified
            widget-kind registry, so custom widgets get their `setupPanel` rendered here too
            (previously this tab had no custom-widget handling at all and rendered blank).
            Each panel is the same class of content `StudioComposeDrawer`'s `WidgetConfigView`
            wraps in `StudioDrawerErrorBoundary` (setup panel / filters / format), but this
            dialog had no boundary of its own (Tier1 whole-dashboard-crash fix) — a render
            throw here previously unmounted the whole `<Studio>` tree. `resetKey` is the
            widget id, so switching to (or reopening for) a different widget clears a latched
            fallback instead of leaving it stuck. */}
        <TabPanel value={tab} index={0} id={getPanelId('setup')} labelledBy={getTabId('setup')}>
          <StudioDrawerErrorBoundary resetKey={widgetId}>
            {def?.setupPanel && <def.setupPanel widgetId={widgetId} />}
          </StudioDrawerErrorBoundary>
        </TabPanel>

        {showFiltersTab && (
          <TabPanel
            value={tab}
            index={1}
            id={getPanelId('filters')}
            labelledBy={getTabId('filters')}
          >
            <StudioDrawerErrorBoundary resetKey={widgetId}>
              <WidgetFiltersPanel widgetId={widgetId} />
            </StudioDrawerErrorBoundary>
          </TabPanel>
        )}

        <TabPanel
          value={tab}
          index={showFiltersTab ? 2 : 1}
          id={getPanelId('format')}
          labelledBy={getTabId('format')}
        >
          <StudioDrawerErrorBoundary resetKey={widgetId}>
            {widget.kind === 'text' ? (
              <TextFormatPanel widgetId={widgetId} />
            ) : (
              <FormatPanel widgetId={widgetId} />
            )}
          </StudioDrawerErrorBoundary>
        </TabPanel>
      </Box>
    </Dialog>
  );
}
