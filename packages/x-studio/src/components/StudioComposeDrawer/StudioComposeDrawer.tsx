'use client';
import * as React from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import { useDrawerSubheader } from '../Studio/DrawerPanelContext';
import { useStudioSelector, selectWidgets, selectShell, useCustomWidgetMap, useStudioLocaleText } from '../../context';
import { StudioUIConfigContext } from '../../internals/StudioUIConfigContext';
import { AddWidgetView } from './AddWidgetView';
import { ChartSetupPanel } from './ChartSetupPanel';
import { FieldDetailView } from './FieldDetailView';
import { FilterSetupPanel } from './FilterSetupPanel';
import { FormatPanel } from './FormatPanel';
import { GridSetupPanel } from './GridSetupPanel';
import { KpiSetupPanel } from './KpiSetupPanel';
import { MapSetupPanel } from './MapSetupPanel';
import { PivotSetupPanel } from './PivotSetupPanel';
import { TextFormatPanel } from './TextFormatPanel';
import { TextSetupPanel } from './TextSetupPanel';

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
  const customWidgetMap = useCustomWidgetMap();
  const customDef = widget ? (customWidgetMap.get(widget.kind) ?? null) : null;

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
        {widget.kind === 'text' && <TextSetupPanel widgetId={widgetId} />}
        {widget.kind === 'grid' && <GridSetupPanel widgetId={widgetId} />}
        {widget.kind === 'chart' && <ChartSetupPanel widgetId={widgetId} />}
        {widget.kind === 'kpi' && <KpiSetupPanel widgetId={widgetId} />}
        {widget.kind === 'filter' && <FilterSetupPanel widgetId={widgetId} />}
        {widget.kind === 'pivot' && <PivotSetupPanel widgetId={widgetId} />}
        {widget.kind === 'map' && <MapSetupPanel widgetId={widgetId} />}
        {customDef?.setupPanel && <customDef.setupPanel widgetId={widgetId} />}
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
  const localeText = useStudioLocaleText();
  const selectedWidgetId = shell.selectedWidgetId;
  const selectedFieldId = shell.selectedFieldId;

  const parentConfig = React.useContext(StudioUIConfigContext);
  const resolvedTableSourceMode = tableSourceMode ?? parentConfig.tableSourceMode;

  const configValue = React.useMemo(
    () => ({ ...parentConfig, tableSourceMode: resolvedTableSourceMode }),
    [parentConfig, resolvedTableSourceMode],
  );

  let content: React.ReactNode = <AddWidgetView />;
  if (selectedWidgetId) {
    content = <WidgetConfigView widgetId={selectedWidgetId} />;
  } else if (selectedFieldId) {
    content = <FieldDetailView />;
  }

  if (tableSourceMode !== undefined) {
    return (
      <StudioUIConfigContext.Provider value={configValue}>{content}</StudioUIConfigContext.Provider>
    );
  }

  return content;
}
