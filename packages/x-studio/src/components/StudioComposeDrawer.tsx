import * as React from 'react';
import {
  Alert,
  Box,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  Autocomplete,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import type { StudioBarLayout, StudioDataField } from '../models';

import { useStudioController, useStudioSelector } from '../context';
import type {
  StudioChartType,
  StudioKpiAggregation,
  StudioKpiFormat,
  StudioWidgetKind,
} from '../models';
import { createDefaultWidget, WIDGET_TYPES, widgetKindRequiresDataSource } from './widgetUtils';

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

const KIND_LABEL: Record<StudioWidgetKind, string> = {
  grid: 'Table',
  chart: 'Chart',
  kpi: 'KPI',
  text: 'Text',
};

const TYPE_FORMAT_LABEL: Record<string, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  datetime: 'Date & Time',
};

// ── Add widget view (no selection) ───────────────────────────────────────────

function AddWidgetView() {
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);

  const handleAdd = (kind: StudioWidgetKind) => {
    const sources = Object.values(dataSources);
    if (widgetKindRequiresDataSource(kind) && sources.length === 0) {
      return;
    }
    controller.addWidget(createDefaultWidget(kind, sources[0]));
  };

  const hasSources = Object.keys(dataSources).length > 0;

  return (
    <Stack spacing={1.5}>
      <Typography variant="caption" color="text.secondary">
        Choose a widget type to add
      </Typography>
      {!hasSources && (
        <Alert severity="warning" sx={{ fontSize: 12 }}>
          No data sources available yet. Only text widgets can be added until one is connected.
        </Alert>
      )}
      {WIDGET_TYPES.map((wt) => {
        const canAdd = !widgetKindRequiresDataSource(wt.kind) || hasSources;
        const ref = React.useRef<HTMLDivElement>(null);
        const [isDragging, setIsDragging] = React.useState(false);
        React.useEffect(() => {
          if (!canAdd) {
            return undefined;
          }
          const node = ref.current;
          if (!node) return undefined;
          function handleDragStart(e: DragEvent) {
            setIsDragging(true);
            e.dataTransfer?.setData(
              'application/json',
              JSON.stringify({ type: 'compose-widget', kind: wt.kind }),
            );
            if (node) e.dataTransfer?.setDragImage(node, 0, 0);
          }
          function handleDragEnd() {
            setIsDragging(false);
          }
          node.setAttribute('draggable', 'true');
          node.addEventListener('dragstart', handleDragStart);
          node.addEventListener('dragend', handleDragEnd);
          return () => {
            node.removeEventListener('dragstart', handleDragStart);
            node.removeEventListener('dragend', handleDragEnd);
          };
        }, [canAdd, wt.kind]);
        return (
          <Paper
            key={wt.kind}
            ref={ref}
            variant="outlined"
            onClick={() => {
              if (canAdd) {
                handleAdd(wt.kind);
              }
            }}
            tabIndex={0}
            role="button"
            aria-label={`Add ${wt.label} widget`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (canAdd) {
                  handleAdd(wt.kind);
                }
              }
            }}
            sx={{
              p: 1.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              cursor: canAdd ? (isDragging ? 'grabbing' : 'grab') : 'not-allowed',
              opacity: canAdd ? 1 : 0.5,
              transition: 'border-color 0.15s, background-color 0.15s',
              '&:hover': canAdd ? { borderColor: 'primary.main', bgcolor: 'action.hover' } : {},
              '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
              boxShadow: isDragging ? 4 : undefined,
            }}
          >
            <Box sx={{ color: 'primary.main', display: 'flex', flexShrink: 0 }}>{wt.icon}</Box>
            <Box>
              <Typography variant="subtitle2">{wt.label}</Typography>
              <Typography variant="caption" color="text.secondary">
                {wt.description}
              </Typography>
            </Box>
          </Paper>
        );
      })}
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
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
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
  const allFields = (source?.fields ?? []).filter((f) => !f.hidden);
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

  const allFields = Object.values(dataSources).flatMap((ds) =>
    ds.fields
      .filter((f) => !f.hidden)
      .map((f) => ({ ...f, sourceId: ds.id, sourceLabel: ds.label })),
  );
  const config = widget?.config ?? {};
  const numericFields = allFields.filter((f) => f.type === 'number');
  const categoryFields = allFields.filter((f) => f.type === 'string');

  // Resolve base chart type (strip bar-grouped/bar-stacked into bar + layout)
  const rawChartType = config.chartType ?? 'bar';
  const chartType: StudioChartType =
    rawChartType === 'bar-grouped' || rawChartType === 'bar-stacked' ? 'bar' : rawChartType;
  const barLayout: StudioBarLayout =
    rawChartType === 'bar-grouped'
      ? 'grouped'
      : rawChartType === 'bar-stacked'
        ? 'stacked'
        : (config.barLayout ?? 'standard');

  // Y series: prefer ySeries, else seed from yField
  const ySeries = config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []);

  const selectedXField = allFields.find((f) => f.id === config.xField) ?? null;
  const selectedSeriesField = allFields.find((f) => f.id === config.seriesField) ?? null;

  const supportsMultipleSeries =
    chartType === 'bar' || chartType === 'line' || chartType === 'area';
  const supportsBarLayout = chartType === 'bar';
  const supportsSeriesField = supportsBarLayout && barLayout !== 'standard';
  // When multiple Y series are set, series-field grouping doesn't apply
  const showSeriesField = supportsSeriesField && ySeries.length <= 1;

  const handleChartTypeChange = (newType: StudioChartType) => {
    controller.updateWidgetConfig(widgetId, { chartType: newType, barLayout: 'standard' });
  };

  const handleBarLayoutChange = (_e: React.MouseEvent, newLayout: StudioBarLayout | null) => {
    if (!newLayout) return;
    controller.updateWidgetConfig(widgetId, { barLayout: newLayout });
  };

  const handleAddSeries = () => {
    controller.updateWidgetConfig(widgetId, { ySeries: [...ySeries, { fieldId: '' }] });
  };

  const handleRemoveSeries = (index: number) => {
    const next = ySeries.filter((_, i) => i !== index);
    controller.updateWidgetConfig(widgetId, {
      ySeries: next,
      yField: next[0]?.fieldId ?? '',
    });
  };

  const handleSeriesFieldChange = (index: number, fieldId: string) => {
    const next = ySeries.map((s, i) => (i === index ? { ...s, fieldId } : s));
    controller.updateWidgetConfig(widgetId, {
      ySeries: next,
      yField: next[0]?.fieldId ?? '',
    });
  };

  if (allFields.length === 0) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data fields available for chart configuration.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      {/* Chart type */}
      <FormControl size="small" fullWidth>
        <InputLabel>Chart type</InputLabel>
        <Select
          label="Chart type"
          value={chartType}
          onChange={(e) => handleChartTypeChange(e.target.value as StudioChartType)}
        >
          <MenuItem value="bar">Bar</MenuItem>
          <MenuItem value="line">Line</MenuItem>
          <MenuItem value="area">Area</MenuItem>
          <MenuItem value="pie">Pie / Donut</MenuItem>
          <MenuItem value="scatter">Scatter</MenuItem>
        </Select>
      </FormControl>

      {/* Bar layout toggle */}
      {supportsBarLayout && (
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
            Layout
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={barLayout}
            onChange={handleBarLayoutChange}
            sx={{ width: '100%', '& .MuiToggleButton-root': { flex: 1, py: 0.25 } }}
          >
            <ToggleButton value="standard">Standard</ToggleButton>
            <ToggleButton value="grouped">Grouped</ToggleButton>
            <ToggleButton value="stacked">Stacked</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}

      <Divider />

      {/* X field */}
      <Autocomplete
        size="small"
        fullWidth
        options={chartType === 'scatter' ? numericFields : allFields}
        groupBy={(option) => option.sourceLabel}
        getOptionLabel={(option) => option.label}
        value={selectedXField}
        onChange={(_e, newValue) =>
          controller.updateWidgetConfig(widgetId, { xField: newValue?.id ?? '' })
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label={chartType === 'scatter' ? 'X field (numeric)' : 'X / Category field'}
          />
        )}
        isOptionEqualToValue={(option, value) => option.id === value.id}
      />

      {/* Y series */}
      <Box>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            {supportsMultipleSeries ? 'Y / Measure fields' : 'Y / Measure field'}
          </Typography>
          {supportsMultipleSeries && (
            <Tooltip title="Add series">
              <IconButton size="small" onClick={handleAddSeries}>
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
        <Stack spacing={1}>
          {ySeries.map((s, index) => {
            const selectedField = allFields.find((f) => f.id === s.fieldId) ?? null;
            return (
              <Stack key={index} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Autocomplete
                  size="small"
                  fullWidth
                  options={numericFields}
                  groupBy={(option) => option.sourceLabel}
                  getOptionLabel={(option) => option.label}
                  value={selectedField}
                  onChange={(_e, newValue) => handleSeriesFieldChange(index, newValue?.id ?? '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label={ySeries.length > 1 ? `Series ${index + 1}` : 'Y / Measure field'}
                    />
                  )}
                  isOptionEqualToValue={(option, value) => option.id === value.id}
                />
                {ySeries.length > 1 && (
                  <Tooltip title="Remove series">
                    <IconButton size="small" onClick={() => handleRemoveSeries(index)}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            );
          })}
          {ySeries.length === 0 && (
            <Autocomplete
              size="small"
              fullWidth
              options={numericFields}
              groupBy={(option) => option.sourceLabel}
              getOptionLabel={(option) => option.label}
              value={null}
              onChange={(_e, newValue) => {
                controller.updateWidgetConfig(widgetId, {
                  ySeries: [{ fieldId: newValue?.id ?? '' }],
                  yField: newValue?.id ?? '',
                });
              }}
              renderInput={(params) => <TextField {...params} label="Y / Measure field" />}
              isOptionEqualToValue={(option, value) => option.id === value.id}
            />
          )}
        </Stack>
      </Box>

      {/* Series / group field for grouped/stacked (when single Y series) */}
      {showSeriesField && (
        <Autocomplete
          size="small"
          fullWidth
          options={categoryFields}
          groupBy={(option) => option.sourceLabel}
          getOptionLabel={(option) => option.label}
          value={selectedSeriesField}
          onChange={(_e, newValue) =>
            controller.updateWidgetConfig(widgetId, { seriesField: newValue?.id ?? '' })
          }
          renderInput={(params) => <TextField {...params} label="Group by field" />}
          isOptionEqualToValue={(option, value) => option.id === value.id}
        />
      )}
    </Stack>
  );
}

function KpiSetupPanel(props: { widgetId: string }) {
  const widget = useStudioSelector((state) => state.widgets[props.widgetId]);
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);
  const config = widget?.config ?? {};

  // Gather all fields from all data sources
  const allFields = Object.values(dataSources).flatMap((ds) =>
    ds.fields
      .filter((f) => !f.hidden)
      .map((f) => ({ ...f, sourceId: ds.id, sourceLabel: ds.label })),
  );
  const selectedField = allFields.find((f) => f.id === config.kpiValueField);
  const selectedFieldType = selectedField?.type ?? null;

  // Aggregation options by type
  const AGGREGATIONS: Record<string, { value: StudioKpiAggregation; label: string }[]> = {
    number: [
      { value: 'sum', label: 'Sum' },
      { value: 'avg', label: 'Average' },
      { value: 'count', label: 'Count' },
      { value: 'min', label: 'Min' },
      { value: 'max', label: 'Max' },
    ],
    string: [{ value: 'count', label: 'Count' }],
    boolean: [{ value: 'count', label: 'Count' }],
    date: [
      { value: 'count', label: 'Count' },
      { value: 'min', label: 'Earliest' },
      { value: 'max', label: 'Latest' },
    ],
    datetime: [
      { value: 'count', label: 'Count' },
      { value: 'min', label: 'Earliest' },
      { value: 'max', label: 'Latest' },
    ],
  };
  const aggregationOptions = selectedFieldType
    ? AGGREGATIONS[selectedFieldType] || [{ value: 'count', label: 'Count' }]
    : AGGREGATIONS['number'];
  const onlyOneAgg = aggregationOptions.length === 1;
  const selectedAgg = aggregationOptions.find((a) => a.value === config.kpiAggregation)
    ? config.kpiAggregation
    : aggregationOptions[0].value;

  const { widgetId } = props;

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const fields = source?.fields ?? [];
  const numericFields = fields.filter((f) => f.type === 'number');

  if (!source) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data source bound to this widget.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      <Autocomplete
        size="small"
        fullWidth
        options={allFields}
        groupBy={(option) => option.sourceLabel}
        getOptionLabel={(option) => option.label}
        value={allFields.find((f) => f.id === config.kpiValueField) || null}
        onChange={(_e, newValue) => {
          controller.updateWidgetConfig(widgetId, { kpiValueField: newValue?.id || '' });
        }}
        renderInput={(params) => <TextField {...params} label="Value field" />}
        isOptionEqualToValue={(option, value) =>
          option.id === value.id && option.sourceId === value.sourceId
        }
      />

      <FormControl size="small" fullWidth disabled={onlyOneAgg}>
        <InputLabel>Aggregation</InputLabel>
        <Select
          label="Aggregation"
          value={selectedAgg}
          onChange={(e) =>
            controller.updateWidgetConfig(widgetId, {
              kpiAggregation: e.target.value as StudioKpiAggregation,
            })
          }
        >
          {aggregationOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>Format</InputLabel>
        <Select
          label="Format"
          value={config.kpiFormat ?? 'number'}
          onChange={(e) =>
            controller.updateWidgetConfig(widgetId, {
              kpiFormat: e.target.value as StudioKpiFormat,
            })
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

function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const [subtitle, setSubtitle] = React.useState(widget?.config.textSubtitle ?? '');
  const [body, setBody] = React.useState(widget?.config.textBody ?? '');

  React.useEffect(() => {
    setSubtitle(widget?.config.textSubtitle ?? '');
    setBody(widget?.config.textBody ?? '');
  }, [widget?.config.textSubtitle, widget?.config.textBody, widgetId]);

  const handleBlur = () => {
    controller.updateWidgetConfig(widgetId, {
      textSubtitle: subtitle,
      textBody: body,
    });
  };

  return (
    <Stack spacing={2}>
      <TextField
        label="Subtitle"
        size="small"
        fullWidth
        value={subtitle}
        onChange={(e) => setSubtitle(e.target.value)}
        onBlur={handleBlur}
      />
      <TextField
        label="Body"
        fullWidth
        multiline
        minRows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={handleBlur}
      />
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
        {widget.kind === 'text' && <TextSetupPanel widgetId={widgetId} />}
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

  return <AddWidgetView />;
}
