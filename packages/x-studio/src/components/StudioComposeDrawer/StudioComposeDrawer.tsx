'use client';
import * as React from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import { useDrawerSubheader } from '../Studio/DrawerPanelContext';
import { useStudioSelector, selectWidgets, selectShell, useStudioLocaleText } from '../../context';
import { StudioUIConfigContext } from '../../internals/StudioUIConfigContext';
import { useWidgetDefMap } from '../../internals/builtinWidgetDefs';
import { StudioDrawerErrorBoundary } from '../../internals/StudioDrawerErrorBoundary';
import { AddWidgetView } from './AddWidgetView';
import { FieldDetailView } from './FieldDetailView';
import { FormatPanel } from './FormatPanel';
import { TextFormatPanel } from './TextFormatPanel';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface TabPanelProps {
  children: React.ReactNode;
  value: number;
  index: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, index, value } = props;

  return (
    <Box role="tabpanel" hidden={value !== index} sx={{ pt: 1.5 }}>
      {value === index ? children : null}
    </Box>
  );
}

// ── Widget config view (widget selected) ─────────────────────────────────────

function WidgetConfigView(props: { widgetId: string }) {
  const { widgetId } = props;
  const [tab, setTab] = React.useState(0);
  const localeText = useStudioLocaleText();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const widgetDefMap = useWidgetDefMap();
  const def = widget ? widgetDefMap.get(widget.kind) : undefined;

  const handleTabChange = React.useCallback(
    (_event: React.SyntheticEvent, v: number) => setTab(v),
    [],
  );

  // react-doctor-disable-next-line react-doctor/rerender-memo-before-early-return -- useDrawerSubheader is a hook and must be called unconditionally before the early return
  const subheaderNode = React.useMemo(
    () => (
      <Tabs
        value={tab}
        onChange={handleTabChange}
        variant="fullWidth"
        sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab label={localeText.widgetEditDialogTabSetup} />
        <Tab label={localeText.widgetEditDialogTabFormat} />
      </Tabs>
    ),
    [tab, handleTabChange, localeText],
  );

  useDrawerSubheader(subheaderNode);

  if (!widget) {
    return null;
  }

  return (
    <div>
      <TabPanel value={tab} index={0}>
        {def?.setupPanel && <def.setupPanel widgetId={widgetId} />}
      </TabPanel>
      <TabPanel value={tab} index={1}>
        {widget.kind === 'text' ? (
          <TextFormatPanel widgetId={widgetId} />
        ) : (
          <FormatPanel widgetId={widgetId} />
        )}
      </TabPanel>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface StudioComposeDrawerProps {
  /**
   * Controls how the table widget's data source is determined.
   * - `'explicit'` (default): a data source picker is shown at the top of the
   *   table setup panel.
   * - `'implicit'`: no source picker; the source is inferred from the first
   *   column added (Tableau / Power BI style).
   *
   * This prop overrides the value provided by the parent `Studio` component.
   */
  tableSourceMode?: 'explicit' | 'implicit';
}

export function StudioComposeDrawer(props: StudioComposeDrawerProps = {}) {
  const { tableSourceMode } = props;
  const shell = useStudioSelector(selectShell);
  const selectedWidgetId = shell.selectedWidgetId;
  const selectedFieldId = shell.selectedFieldId;

  const parentConfig = React.use(StudioUIConfigContext);
  const resolvedTableSourceMode = tableSourceMode ?? parentConfig.tableSourceMode;

  const configValue = React.useMemo(
    () => ({ ...parentConfig, tableSourceMode: resolvedTableSourceMode }),
    [parentConfig, resolvedTableSourceMode],
  );

  let content: React.ReactNode = <AddWidgetView />;
  if (selectedWidgetId) {
    // M2 — the `key` is load-bearing, not decoration. Without it React reconciles the
    // whole setup-panel subtree ACROSS a widget switch, so every piece of component-local
    // state below survives: buffered text inputs (`ColorInput`, `AnnotationsEditorSection`,
    // …) whose `useEffect` resync is keyed on `value` alone never fire when the two widgets
    // happen to hold the SAME value, and the next blur/Enter commits widget A's dirty
    // buffer to widget B; likewise stale `menuAnchor`/`dragIndex` state leaves a MUI popover
    // anchored to a node detached by the switch. `StudioDrawerErrorBoundary`'s `resetKey`
    // does NOT remount children, so it cannot stand in for this.
    //
    // Mouse-driven selection happens to be safe (blur precedes the click), but AI chat tool
    // calls and keyboard-driven selection move `selectedWidgetId` with focus still inside a
    // dirty field — remounting on identity is the only fix that covers every entry point.
    content = <WidgetConfigView key={selectedWidgetId} widgetId={selectedWidgetId} />;
  } else if (selectedFieldId) {
    // Same reasoning for the field detail view, which reads its own id from the store.
    content = <FieldDetailView key={selectedFieldId} />;
  }

  // Defense-in-depth (this drawer had no error boundary at all): a render throw from any
  // sub-view here (a custom `setupPanel`, `FormatPanel`, etc. — e.g. reached through a
  // hostile/malformed doc-authored id) previously had no boundary to stop at and unmounted
  // the entire `<Studio>` tree. `resetKey` is the current selection, so switching the
  // selected widget/field after a transient error clears the fallback instead of latching it.
  const boundedContent = (
    <StudioDrawerErrorBoundary resetKey={selectedWidgetId ?? selectedFieldId ?? 'none'}>
      {content}
    </StudioDrawerErrorBoundary>
  );

  if (tableSourceMode !== undefined) {
    return (
      <StudioUIConfigContext.Provider value={configValue}>
        {boundedContent}
      </StudioUIConfigContext.Provider>
    );
  }

  return boundedContent;
}
