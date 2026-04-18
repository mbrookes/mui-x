import * as React from 'react';
import {
  Alert,
  Box,
  Divider,
  FormControl,
  InputLabel,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import BarChartIcon from '@mui/icons-material/BarChart';
import GridOnIcon from '@mui/icons-material/GridOn';
import SpeedIcon from '@mui/icons-material/Speed';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioChartType, StudioKpiAggregation, StudioKpiFormat, StudioWidgetKind } from '../models';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface TabPanelProps {
  children: React.ReactNode;
  value: number;
  index: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, index, value } = props;

  return (
    <Box role="tabpanel" hidden={value !== index} sx={{ pt: 2 }}>
      {value === index ? children : null}
    </Box>
  );
}

const KIND_ICON: Record<StudioWidgetKind, React.ReactNode> = {
  grid: <GridOnIcon fontSize="small" />,
  chart: <BarChartIcon fontSize="small" />,
  kpi: <SpeedIcon fontSize="small" />,
};

const KIND_LABEL: Record<StudioWidgetKind, string> = {
  grid: 'Table',
  chart: 'Chart',
  kpi: 'KPI',
};

const TYPE_FORMAT_LABEL: Record<string, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  datetime: 'Date & Time',
};

// ── Widget list (no selection) ────────────────────────────────────────────────

function WidgetListView() {
  const controller = useStudioController();
  const widgets = useStudioSelector((state) => state.widgets);
  const activePageId = useStudioSelector((state) => state.dashboard.activePageId);
  const widgetIds = useStudioSelector((state) => state.pages[activePageId]?.widgetIds ?? []);

  if (widgetIds.length === 0) {
    return (
      <Alert severity="info" sx={{ mt: 1 }}>
        Add a widget to the canvas to configure it here.
      </Alert>
    );
  }

  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" color="text.secondary" sx={{ px: 0.5, pb: 0.5 }}>
        Select a widget to configure
      </Typography>
      <List dense disablePadding>
        {widgetIds.map((id) => {
          const widget = widgets[id];
          if (!widget) {
            return null;
          }
          return (
            <ListItemButton
              key={id}
              onClick={() => controller.setSelectedWidget(id)}
              sx={{ borderRadius: 1, px: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                {KIND_ICON[widget.kind]}
              </ListItemIcon>
              <ListItemText
                primary={widget.title}
                secondary={KIND_LABEL[widget.kind]}
                primaryTypographyProps={{ variant: 'body2', noWrap: true }}
                secondaryTypographyProps={{ variant: 'caption' }}
              />
            </ListItemButton>
          );
        })}
      </List>
    </Stack>
  );
}

// ── Field detail view ─────────────────────────────────────────────────────────

function FieldDetailView() {
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);
  const selectedSourceId = useStudioSelector((state) => state.shell.selectedSourceId);
  const source = useStudioSelector((state) =>
    state.shell.selectedSourceId ? state.dataSources[state.shell.selectedSourceId] : null,
  );
  const field = source?.fields.find((f) => f.id === selectedFieldId) ?? null;

  if (!field || !source) {
    return null;
  }

  const rows: { label: string; value: string }[] = [
    { label: 'Source ID', value: `${source.id}.${field.id}` },
    { label: 'Name', value: field.label },
    { label: 'Description', value: field.description ?? field.label },
    { label: 'Data Type', value: field.type.charAt(0).toUpperCase() + field.type.slice(1) },
    { label: 'Calculation Type', value: 'No Calculation' },
    { label: 'Format', value: TYPE_FORMAT_LABEL[field.type] ?? field.type },
  ];

  return (
    <Stack spacing={0}>
      {rows.map((row, i) => (
        <React.Fragment key={row.label}>
          {i > 0 && <Divider />}
          <Box sx={{ py: 1.25 }}>
            <Typography variant="caption" color="text.secondary" display="block">
              {row.label}
            </Typography>
            <Typography variant="body2">{row.value}</Typography>
          </Box>
        </React.Fragment>
      ))}
    </Stack>
  );
}

// ── Widget config panels ──────────────────────────────────────────────────────

function GridSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const allFields = source?.fields ?? [];
  const visibleColumns: string[] = widget?.config?.columns ?? allFields.map((f) => f.id);

  const handleColumnToggle = (fieldId: string) => {
    const next = visibleColumns.includes(fieldId)
      ? visibleColumns.filter((c) => c !== fieldId)
      : [...visibleColumns, fieldId];
    controller.updateWidgetConfig(widgetId, { columns: next });
  };

  if (!source) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data source bound to this widget.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="caption" color="text.secondary">
        Visible columns ({visibleColumns.length}/{allFields.length})
      </Typography>
      {allFields.map((field) => (
        <Box
          key={field.id}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            p: 1,
            borderRadius: 1,
            bgcolor: visibleColumns.includes(field.id) ? 'action.selected' : 'transparent',
            border: 1,
            borderColor: 'divider',
          }}
          onClick={() => handleColumnToggle(field.id)}
          role="checkbox"
          aria-checked={visibleColumns.includes(field.id)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              handleColumnToggle(field.id);
            }
          }}
        >
          <Typography variant="body2">{field.label}</Typography>
          <Typography variant="caption" color="text.secondary">
            {field.type}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

function ChartSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const fields = source?.fields ?? [];
  const numericFields = fields.filter((f) => f.type === 'number');
  const config = widget?.config ?? {};

  if (!source) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data source bound to this widget.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      <FormControl size="small" fullWidth>
        <InputLabel>Chart type</InputLabel>
        <Select
          label="Chart type"
          value={config.chartType ?? 'bar'}
          onChange={(e) =>
            controller.updateWidgetConfig(widgetId, { chartType: e.target.value as StudioChartType })
          }
        >
          <MenuItem value="bar">Bar</MenuItem>
          <MenuItem value="line">Line</MenuItem>
          <MenuItem value="pie">Pie / Donut</MenuItem>
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>X / Category field</InputLabel>
        <Select
          label="X / Category field"
          value={config.xField ?? ''}
          onChange={(e) => controller.updateWidgetConfig(widgetId, { xField: e.target.value })}
        >
          <MenuItem value=""><em>None</em></MenuItem>
          {fields.map((f) => (
            <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>Y / Measure field</InputLabel>
        <Select
          label="Y / Measure field"
          value={config.yField ?? ''}
          onChange={(e) => controller.updateWidgetConfig(widgetId, { yField: e.target.value })}
        >
          <MenuItem value=""><em>None</em></MenuItem>
          {numericFields.map((f) => (
            <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
}

function KpiSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const fields = source?.fields ?? [];
  const numericFields = fields.filter((f) => f.type === 'number');
  const config = widget?.config ?? {};

  if (!source) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data source bound to this widget.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      <FormControl size="small" fullWidth>
        <InputLabel>Value field</InputLabel>
        <Select
          label="Value field"
          value={config.kpiValueField ?? ''}
          onChange={(e) => controller.updateWidgetConfig(widgetId, { kpiValueField: e.target.value })}
        >
          <MenuItem value=""><em>None</em></MenuItem>
          {numericFields.map((f) => (
            <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>Aggregation</InputLabel>
        <Select
          label="Aggregation"
          value={config.kpiAggregation ?? 'sum'}
          onChange={(e) =>
            controller.updateWidgetConfig(widgetId, { kpiAggregation: e.target.value as StudioKpiAggregation })
          }
        >
          <MenuItem value="sum">Sum</MenuItem>
          <MenuItem value="avg">Average</MenuItem>
          <MenuItem value="count">Count</MenuItem>
          <MenuItem value="min">Min</MenuItem>
          <MenuItem value="max">Max</MenuItem>
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>Format</InputLabel>
        <Select
          label="Format"
          value={config.kpiFormat ?? 'number'}
          onChange={(e) =>
            controller.updateWidgetConfig(widgetId, { kpiFormat: e.target.value as StudioKpiFormat })
          }
        >
          <MenuItem value="number">Number</MenuItem>
          <MenuItem value="currency">Currency (USD)</MenuItem>
          <MenuItem value="percent">Percent</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}

function FormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const [title, setTitle] = React.useState(widget?.title ?? '');

  React.useEffect(() => {
    setTitle(widget?.title ?? '');
  }, [widget?.title, widgetId]);

  const handleTitleBlur = () => {
    if (title !== widget?.title) {
      controller.updateWidget(widgetId, { title });
    }
  };

  return (
    <Stack spacing={2}>
      <TextField
        label="Widget title"
        size="small"
        fullWidth
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleTitleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleTitleBlur();
          }
        }}
      />
    </Stack>
  );
}

// ── Widget config view (widget selected) ─────────────────────────────────────

function WidgetConfigView(props: { widgetId: string }) {
  const { widgetId } = props;
  const [tab, setTab] = React.useState(0);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);

  if (!widget) {
    return null;
  }

  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {KIND_LABEL[widget.kind]} widget
      </Typography>

      <Tabs
        value={tab}
        onChange={(_e, v) => setTab(v)}
        variant="fullWidth"
        sx={{ mt: 1.5, minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab label="Setup" />
        <Tab label="Format" />
      </Tabs>

      <TabPanel value={tab} index={0}>
        {widget.kind === 'grid' && <GridSetupPanel widgetId={widgetId} />}
        {widget.kind === 'chart' && <ChartSetupPanel widgetId={widgetId} />}
        {widget.kind === 'kpi' && <KpiSetupPanel widgetId={widgetId} />}
      </TabPanel>

      <TabPanel value={tab} index={1}>
        <FormatPanel widgetId={widgetId} />
      </TabPanel>
    </Box>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function StudioComposeDrawer() {
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);

  if (selectedWidgetId) {
    return <WidgetConfigView widgetId={selectedWidgetId} />;
  }

  if (selectedFieldId) {
    return <FieldDetailView />;
  }

  return <WidgetListView />;
}

