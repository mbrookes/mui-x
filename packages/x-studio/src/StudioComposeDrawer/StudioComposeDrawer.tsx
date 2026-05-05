'use client';
import * as React from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import { useDrawerSubheader } from '../internals/DrawerPanel';
import type { StudioWidgetKind } from '../models';
import { useStudioSelector } from '../context';
import { AddWidgetView } from './AddWidgetView';
import { ChartSetupPanel } from './ChartSetupPanel';
import { FieldDetailView } from './FieldDetailView';
import { FilterSetupPanel } from './FilterSetupPanel';
import { FormatPanel } from './FormatPanel';
import { GridSetupPanel } from './GridSetupPanel';
import { KpiSetupPanel } from './KpiSetupPanel';
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

export const KIND_LABEL: Record<StudioWidgetKind, string> = {
  grid: 'Table',
  chart: 'Chart',
  kpi: 'KPI',
  text: 'Text',
  filter: 'Filter',
};

export const TYPE_FORMAT_LABEL: Record<string, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  datetime: 'Date & Time',
};

// ── Widget config view (widget selected) ─────────────────────────────────────

function WidgetConfigView(props: { widgetId: string }) {
  const { widgetId } = props;
  const [tab, setTab] = React.useState(0);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);

  const handleTabChange = React.useCallback(
    (_event: React.SyntheticEvent, v: number) => setTab(v),
    [],
  );

  const subheaderNode = React.useMemo(
    () => (
      <Tabs
        value={tab}
        onChange={handleTabChange}
        variant="fullWidth"
        sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab label="Setup" />
        <Tab label="Format" />
      </Tabs>
    ),
    [tab, handleTabChange],
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

export function StudioComposeDrawer() {
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);

  useDrawerSubheader(null);

  if (selectedWidgetId) {
    return <WidgetConfigView widgetId={selectedWidgetId} />;
  }

  if (selectedFieldId) {
    return <FieldDetailView />;
  }

  return <AddWidgetView />;
}
