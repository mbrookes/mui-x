'use client';
import * as React from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  Autocomplete,
  useTheme,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import BoltIcon from '@mui/icons-material/Bolt';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft';
import FormatAlignCenterIcon from '@mui/icons-material/FormatAlignCenter';
import FormatAlignRightIcon from '@mui/icons-material/FormatAlignRight';
import type {
  StudioNumberFormat,
  StudioChartType,
  StudioChartPaletteName,
  StudioKpiAggregation,
  StudioPageTheme,
  StudioWidgetKind,
  StudioWidgetConfig,
} from '../models';

import { CanvasScrollContext, useStudioController, useStudioSelector } from '../context';
import { createDefaultWidget, inferWidgetTitles, WIDGET_TYPES, widgetKindRequiresDataSource } from '../internals/widgetUtils';
import { fieldsForCapability, fieldHasCapability } from '../utils/fieldCapabilities';
import { getReachableSourceIds } from '../internals/chartUtils';
import { FieldTypeIcon } from '../internals/FieldTypeIcon';
import { NumberField } from '../internals/NumberField';
import { AreaIcon } from '../icons/charts/AreaIcon';
import { Area100Icon } from '../icons/charts/Area100Icon';
import { AreaStackedIcon } from '../icons/charts/AreaStackedIcon';
import { BarGroupedIcon } from '../icons/charts/BarGroupedIcon';
import { Bar100Icon } from '../icons/charts/Bar100Icon';
import { BarStackedIcon } from '../icons/charts/BarStackedIcon';
import { DonutIcon } from '../icons/charts/DonutIcon';
import { LineIcon } from '../icons/charts/LineIcon';
import { PieIcon } from '../icons/charts/PieIcon';
import { ScatterIcon } from '../icons/charts/ScatterIcon';

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

// ── Chart type picker ─────────────────────────────────────────────────────────

interface ChartTypeOption {
  value: StudioChartType;
  label: string;
  Icon: React.FC<{ size?: number; color?: string; secondaryColor?: string }>;
}

const CHART_TYPE_OPTIONS: ChartTypeOption[] = [
  { value: 'bar', label: 'Bar (grouped)', Icon: BarGroupedIcon },
  { value: 'bar-stacked', label: 'Bar (stacked)', Icon: BarStackedIcon },
  { value: 'bar-100', label: 'Bar (100%)', Icon: Bar100Icon },
  { value: 'line', label: 'Line', Icon: LineIcon },
  { value: 'area', label: 'Area', Icon: AreaIcon },
  { value: 'area-stacked', label: 'Area (stacked)', Icon: AreaStackedIcon },
  { value: 'area-100', label: 'Area (100%)', Icon: Area100Icon },
  { value: 'scatter', label: 'Scatter', Icon: ScatterIcon },
  { value: 'pie', label: 'Pie', Icon: PieIcon },
  { value: 'donut', label: 'Donut', Icon: DonutIcon },
];

function ChartTypePicker({
  value,
  onChange,
}: {
  value: StudioChartType;
  onChange: (v: StudioChartType) => void;
}) {
  const theme = useTheme();
  const primary = theme.palette.primary.main;
  const secondary = theme.palette.secondary.main || theme.palette.primary.light;

  return (
    <div>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block' }}>
        Chart type
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(36px, 1fr))',
          gap: 0.5,
        }}
      >
        {CHART_TYPE_OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <Tooltip key={opt.value} title={opt.label} placement="top">
              <Box
                role="button"
                tabIndex={0}
                aria-label={opt.label}
                aria-pressed={selected}
                onClick={() => onChange(opt.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    onChange(opt.value);
                  }
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  p: 0.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: selected ? 'primary.main' : 'divider',
                  bgcolor: selected ? 'primary.main18' : 'transparent',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  color: selected ? 'primary.main' : 'text.secondary',
                  '&:hover': {
                    borderColor: 'primary.main',
                    bgcolor: 'primary.main10',
                    color: 'primary.main',
                  },
                  '&:focus-visible': {
                    outline: 2,
                    outlineColor: 'primary.main',
                    outlineOffset: 1,
                  },
                }}
              >
                <opt.Icon
                  size={28}
                  color={selected ? primary : 'currentColor'}
                  secondaryColor={selected ? secondary : 'currentColor'}
                />
              </Box>
            </Tooltip>
          );
        })}
      </Box>
    </div>
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

function getCursor(isDragging: boolean) {
  return isDragging ? 'grabbing' : 'grab';
}

// ── Widget type card (extracted to avoid hooks-in-callbacks) ──────────────────

interface WidgetTypeEntry {
  kind: StudioWidgetKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}

interface WidgetTypeCardProps {
  wt: WidgetTypeEntry;
  canAdd: boolean;
  onAdd: (kind: StudioWidgetKind) => void;
}

function WidgetTypeCard({ wt, canAdd, onAdd }: WidgetTypeCardProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  React.useEffect(() => {
    if (!canAdd) {
      return undefined;
    }
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    function handleDragStart(event: DragEvent) {
      setIsDragging(true);
      event.dataTransfer?.setData(
        'application/json',
        JSON.stringify({ type: 'compose-widget', kind: wt.kind }),
      );
      if (node) {
        event.dataTransfer?.setDragImage(node, 0, 0);
      }
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
      ref={ref}
      variant="outlined"
      onClick={() => {
        if (canAdd) {
          onAdd(wt.kind);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Add ${wt.label} widget`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (canAdd) {
            onAdd(wt.kind);
          }
        }
      }}
      sx={{
        p: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        cursor: canAdd ? getCursor(isDragging) : 'not-allowed',
        opacity: canAdd ? 1 : 0.5,
        transition: 'border-color 0.15s, background-color 0.15s',
        '&:hover': canAdd ? { borderColor: 'primary.main', bgcolor: 'action.hover' } : {},
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
        boxShadow: isDragging ? 4 : undefined,
      }}
    >
      <Box sx={{ color: 'primary.main', display: 'flex', flexShrink: 0 }}>{wt.icon}</Box>
      <div>
        <Typography variant="subtitle2">{wt.label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {wt.description}
        </Typography>
      </div>
    </Paper>
  );
}

function AddWidgetView() {
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);
  const canvasScrollRef = React.useContext(CanvasScrollContext);

  const handleAdd = (kind: StudioWidgetKind) => {
    const sources = Object.values(dataSources).filter((s) => !s.hidden);
    if (widgetKindRequiresDataSource(kind) && sources.length === 0) {
      return;
    }
    controller.addWidget(createDefaultWidget(kind));
    // Scroll the canvas to the bottom so the new widget is visible
    requestAnimationFrame(() => {
      canvasScrollRef?.current?.scrollTo({
        top: canvasScrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  };

  const hasSources = Object.values(dataSources).some((s) => !s.hidden);

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
        return <WidgetTypeCard key={wt.kind} wt={wt} canAdd={canAdd} onAdd={handleAdd} />;
      })}
    </Stack>
  );
}

// ── Field detail view ─────────────────────────────────────────────────────────

const NUMBER_FORMAT_OPTIONS: { value: StudioNumberFormat; label: string }[] = [
  { value: 'integer', label: 'Integer' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'percent', label: 'Percent' },
  { value: 'currency', label: 'Currency' },
];

function FieldDetailView() {
  const controller = useStudioController();
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);
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
      {field.type === 'number' && (
        <React.Fragment>
          <Divider />
          <Box sx={{ py: 1.25 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="field-number-format-label">Number Format</InputLabel>
              <Select
                labelId="field-number-format-label"
                label="Number Format"
                value={field.format ?? ''}
                onChange={(event) => {
                  const val = event.target.value as StudioNumberFormat | '';
                  controller.updateDataSourceField(source.id, field.id, {
                    format: val === '' ? undefined : val,
                  });
                }}
                displayEmpty
              >
                <MenuItem value="">
                  <em>Default</em>
                </MenuItem>
                {NUMBER_FORMAT_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </React.Fragment>
      )}
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
  const crossFilterField = widget?.config?.crossFilterField ?? '';

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

  const crossFilterFieldOption = allFields.find((f) => f.id === crossFilterField) ?? null;

  return (
    <Stack spacing={2}>
      {/* Cross-filter field */}
      <Autocomplete
        size="small"
        fullWidth
        options={allFields}
        getOptionLabel={(option) => option.label}
        value={crossFilterFieldOption}
        onChange={(_e, newValue) =>
          controller.updateWidgetConfig(widgetId, { crossFilterField: newValue?.id ?? undefined })
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label="Cross-filter field"
            helperText="Field applied to other widgets when a row is selected"
          />
        )}
        isOptionEqualToValue={(option, value) => option.id === value.id}
      />

      <Divider />

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
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              handleColumnToggle(field.id);
            }
          }}
        >
          <FieldTypeIcon type={field.type} generated={field.generated} size={14} />
          <Typography variant="body2">{field.label}</Typography>
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
  const expressionFields = useStudioSelector((state) => state.expressionFields);

  const relationships = useStudioSelector((state) => state.relationships);

  const allFields = React.useMemo(() => {
    const physicalFields = Object.values(dataSources)
      .filter((ds) => !ds.hidden)
      .flatMap((ds) =>
        ds.fields
          .filter((f) => !f.hidden)
          .map((f) => ({ ...f, sourceId: ds.id, sourceLabel: ds.label })),
      );
    const exprFields = expressionFields
      .filter((ef) => !ef.hidden)
      .map((ef) => {
        const ds = dataSources[ef.sourceId];
        return {
          id: ef.id,
          label: ef.label,
          description: ef.description,
          type: ef.type ?? ('number' as const),
          format: ef.format,
          currencyCode: ef.currencyCode,
          generated: true,
          sourceId: ef.sourceId,
          sourceLabel: ds?.label ?? ef.sourceId,
        };
      });
    return [...physicalFields, ...exprFields];
  }, [dataSources, expressionFields]);

  // Once the X field anchors a source, restrict all other pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!widget?.sourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, widget?.sourceId, relationships]);

  const config = widget?.config ?? {};
  const numericFields = fieldsForCapability(reachableFields, 'numeric');

  const chartType: StudioChartType = config.chartType ?? 'bar';

  // Y series: prefer ySeries, else seed from yField
  const ySeries = config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []);

  const selectedXField = allFields.find((f) => f.id === config.xField) ?? null;

  const supportsMultipleSeries =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100';

  const supportsSeriesField =
    (chartType === 'bar' ||
      chartType === 'bar-stacked' ||
      chartType === 'bar-100' ||
      chartType === 'line' ||
      chartType === 'area' ||
      chartType === 'area-stacked' ||
      chartType === 'area-100') &&
    ySeries.length <= 1;

  const categoryFields = fieldsForCapability(reachableFields, 'categorical');
  const selectedSeriesField =
    config.seriesField ? (reachableFields.find((f) => f.id === config.seriesField) ?? null) : null;
  const isScatter = chartType === 'scatter';

  const handleChartTypeChange = (newType: StudioChartType) => {
    controller.updateWidgetConfig(widgetId, { chartType: newType });
  };

  const usedYFieldIds = ySeries.map((s) => s.fieldId).filter(Boolean);

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
      {/* Chart type icon picker */}
      <ChartTypePicker value={chartType} onChange={handleChartTypeChange} />

      <Divider />

      {/* X field */}
      <Autocomplete
        size="small"
        fullWidth
        options={isScatter ? fieldsForCapability(allFields, 'numeric') : allFields}
        groupBy={(option) => option.sourceLabel}
        getOptionLabel={(option) => option.label}
        value={selectedXField}
        onChange={(_e, newValue) => {
          controller.updateWidgetConfig(widgetId, { xField: newValue?.id ?? '' });
          if (newValue?.sourceId && newValue.sourceId !== widget?.sourceId) {
            controller.updateWidget(widgetId, { sourceId: newValue.sourceId });
          }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={isScatter ? 'X field (numeric)' : 'X / Category field'}
            helperText={isScatter ? 'Plotted on the horizontal axis' : 'Groups data along the horizontal axis'}
          />
        )}
        isOptionEqualToValue={(option, value) =>
          option.id === value.id && option.sourceId === value.sourceId
        }
      />

      {/* Group by — shown only when x field is a date/datetime type */}
      {(selectedXField?.type === 'date' || selectedXField?.type === 'datetime') && (
        <FormControl size="small" fullWidth>
          <InputLabel>Group by</InputLabel>
          <Select
            label="Group by"
            value={config.xGroupBy ?? ''}
            onChange={(e) => {
              const val = e.target.value as string;
              controller.updateWidgetConfig(widgetId, {
                xGroupBy: val ? (val as 'day' | 'week' | 'month' | 'quarter' | 'year') : undefined,
              });
            }}
          >
            <MenuItem value="">None (raw values)</MenuItem>
            <MenuItem value="day">Day</MenuItem>
            <MenuItem value="week">Week</MenuItem>
            <MenuItem value="month">Month</MenuItem>
            <MenuItem value="quarter">Quarter</MenuItem>
            <MenuItem value="year">Year</MenuItem>
          </Select>
        </FormControl>
      )}

      {/* Y series */}
      <div>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            {supportsMultipleSeries ? 'Y / Measure fields' : 'Y / Measure field'}
          </Typography>
          {supportsMultipleSeries && (
            <Tooltip
              title={
                usedYFieldIds.length >= numericFields.length
                  ? 'No more fields to add'
                  : 'Add series'
              }
            >
              <span>
                <IconButton
                  size="small"
                  onClick={handleAddSeries}
                  disabled={usedYFieldIds.length >= numericFields.length}
                >
                  <AddIcon fontSize="small" />
                </IconButton>
              </span>
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
                  getOptionDisabled={(option) =>
                    option.id !== s.fieldId && usedYFieldIds.includes(option.id)
                  }
                  value={selectedField}
                  onChange={(_e, newValue) => handleSeriesFieldChange(index, newValue?.id ?? '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label={ySeries.length > 1 ? `Series ${index + 1}` : 'Y / Measure field'}
                      helperText="Numeric field summed or averaged per category"
                    />
                  )}
                  isOptionEqualToValue={(option, value) =>
                    option.id === value.id && option.sourceId === value.sourceId
                  }
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
              renderInput={(params) => <TextField {...params} label="Y / Measure field" helperText="Numeric field summed or averaged per category" />}
              isOptionEqualToValue={(option, value) =>
                option.id === value.id && option.sourceId === value.sourceId
              }
            />
          )}
        </Stack>
      </div>
      {/* Split by / series field */}
      {supportsSeriesField && (
        <Autocomplete
          size="small"
          fullWidth
          options={categoryFields}
          groupBy={(option) => option.sourceLabel}
          getOptionLabel={(option) => option.label}
          value={selectedSeriesField}
          onChange={(_e, newValue) =>
            controller.updateWidgetConfig(widgetId, {
              seriesField: newValue?.id ?? undefined,
            })
          }
          renderInput={(params) => <TextField {...params} label="Split by (series field)" helperText="Divides data into a separate series per value" />}
          isOptionEqualToValue={(option, value) =>
            option.id === value.id && option.sourceId === value.sourceId
          }
        />
      )}
    </Stack>
  );
}

function KpiSetupPanel(props: { widgetId: string }) {
  const widget = useStudioSelector((state) => state.widgets[props.widgetId]);
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);
  const expressionFields = useStudioSelector((state) => state.expressionFields);
  const relationships = useStudioSelector((state) => state.relationships);
  const config = widget?.config ?? {};

  // Gather fields from all data sources (used for the value field anchor picker)
  const allFields = React.useMemo(() => {
    const physicalFields = Object.values(dataSources)
      .filter((ds) => !ds.hidden)
      .flatMap((ds) =>
        ds.fields
          .filter((f) => !f.hidden)
          .map((f) => ({ ...f, sourceId: ds.id, sourceLabel: ds.label })),
      );
    const exprFields = expressionFields
      .filter((ef) => !ef.hidden)
      .map((ef) => {
        const ds = dataSources[ef.sourceId];
        return {
          id: ef.id,
          label: ef.label,
          description: ef.description,
          type: ef.type ?? ('number' as const),
          format: ef.format,
          currencyCode: ef.currencyCode,
          generated: true,
          sourceId: ef.sourceId,
          sourceLabel: ds?.label ?? ef.sourceId,
        };
      });
    return [...physicalFields, ...exprFields];
  }, [dataSources, expressionFields]);

  // Once the value field anchors a source, restrict subsequent pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!widget?.sourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, widget?.sourceId, relationships]);

  const selectedField = reachableFields.find((f) => f.id === config.kpiValueField)
    ?? allFields.find((f) => f.id === config.kpiValueField);
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
    : AGGREGATIONS.number;
  const onlyOneAgg = aggregationOptions.length === 1;
  const selectedAgg = aggregationOptions.find((a) => a.value === config.kpiAggregation)
    ? config.kpiAggregation
    : aggregationOptions[0].value;

  const { widgetId } = props;

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
          if (newValue?.sourceId && newValue.sourceId !== widget?.sourceId) {
            controller.updateWidget(widgetId, { sourceId: newValue.sourceId });
          }
        }}
        renderInput={(params) => <TextField {...params} label="Value field" helperText="Numeric field to aggregate" />}
        isOptionEqualToValue={(option, value) =>
          option.id === value.id && option.sourceId === value.sourceId
        }
      />

      <FormControl size="small" fullWidth disabled={onlyOneAgg}>
        <InputLabel>Aggregation</InputLabel>
        <Select
          label="Aggregation"
          value={selectedAgg}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiAggregation: event.target.value as StudioKpiAggregation,
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

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            size="small"
            checked={config.kpiSparkline ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, { kpiSparkline: event.target.checked })
            }
          />
        }
        label="Sparkline"
      />

      {config.kpiSparkline && <KpiSparklineOptions widgetId={widgetId} config={config} />}

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            size="small"
            checked={config.kpiTrend ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, { kpiTrend: event.target.checked })
            }
          />
        }
        label="Trend (period-over-period)"
      />

      {config.kpiTrend && (
        <Stack spacing={1.5} sx={{ pl: 1 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Comparison period</InputLabel>
            <Select
              label="Comparison period"
              value={config.kpiTrendComparison ?? 'previous-period'}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, {
                  kpiTrendComparison: event.target.value as
                    | 'previous-period'
                    | 'previous-calendar-period'
                    | 'year-over-year',
                })
              }
            >
              <MenuItem value="previous-period">Previous period (matching duration)</MenuItem>
              <MenuItem value="previous-calendar-period">Previous calendar period</MenuItem>
              <MenuItem value="year-over-year">Same period last year</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
            control={
              <Switch
                size="small"
                checked={config.kpiTrendInvert ?? false}
                onChange={(event) =>
                  controller.updateWidgetConfig(widgetId, { kpiTrendInvert: event.target.checked })
                }
              />
            }
            label="Invert colours (lower is better)"
          />
        </Stack>
      )}
    </Stack>
  );
}

function KpiSparklineOptions(props: { widgetId: string; config: StudioWidgetConfig }) {
  const { widgetId, config } = props;
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);
  const filters = useStudioSelector((state) => state.filters);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);

  // Auto-detected date filter field
  const sourceId = widget?.sourceId;
  const source = sourceId ? dataSources[sourceId] : undefined;
  const relationships = useStudioSelector((state) => state.relationships);

  // Collect date fields from primary source + all directly related sources
  const allDateFieldsWithJoined = React.useMemo(() => {
    if (!source || !sourceId) {
      return [];
    }
    const result: { id: string; label: string; sourceId: string; sourceLabel: string }[] = [];
    source.fields
      .filter((f) => fieldHasCapability(f, 'temporal'))
      .forEach((f) => result.push({ id: f.id, label: f.label, sourceId, sourceLabel: source.label }));
    for (const rel of relationships) {
      let relatedId: string | null = null;
      if (rel.sourceId === sourceId) {
        relatedId = rel.targetId;
      } else if (rel.targetId === sourceId) {
        relatedId = rel.sourceId;
      }
      if (!relatedId) {
        continue;
      }
      const relSource = dataSources[relatedId];
      if (!relSource) {
        continue;
      }
      relSource.fields
        .filter((f) => fieldHasCapability(f, 'temporal'))
        .forEach((f) => {
          if (!result.find((r) => r.id === f.id && r.sourceId === relatedId)) {
            result.push({
              id: f.id,
              label: f.label,
              sourceId: relatedId!,
              sourceLabel: relSource.label,
            });
          }
        });
    }
    return result;
  }, [source, sourceId, relationships, dataSources]);

  const autoDateFilter = React.useMemo(() => {
    if (!sourceId) {
      return null;
    }
    const relevant = filters.filter(
      (f) => f.scope === 'page' || (f.scope === 'widget' && f.widgetId === widgetId),
    );
    return (
      relevant.find((f) => {
        return allDateFieldsWithJoined.some(
          (df) => df.id === f.field && (!f.filterSourceId || f.filterSourceId === df.sourceId),
        );
      }) ?? null
    );
  }, [filters, sourceId, widgetId, allDateFieldsWithJoined]);

  const autoFieldLabel = autoDateFilter
    ? allDateFieldsWithJoined.find((f) => f.id === autoDateFilter.field)?.label
    : null;

  // The composite value stored in the select: "sourceId:fieldId" (or just "fieldId" for primary)
  let sparklineComposite = '';
  if (config.kpiSparklineField) {
    sparklineComposite =
      config.kpiSparklineSourceId && config.kpiSparklineSourceId !== sourceId
        ? `${config.kpiSparklineSourceId}:${config.kpiSparklineField}`
        : config.kpiSparklineField;
  }

  const plotType = config.kpiSparklinePlotType ?? 'line';

  const GRANULARITIES: {
    value: NonNullable<StudioWidgetConfig['kpiSparklineGranularity']>;
    label: string;
  }[] = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'quarter', label: 'Quarter' },
    { value: 'year', label: 'Year' },
  ];

  return (
    <Stack spacing={2} sx={{ pl: 1, borderLeft: 2, borderColor: 'divider' }}>
      {autoDateFilter ? (
        <Typography variant="caption" color="text.secondary">
          Using date filter: <strong>{autoFieldLabel}</strong>
        </Typography>
      ) : (
        <FormControl size="small" fullWidth>
          <InputLabel>Time field</InputLabel>
          <Select
            label="Time field"
            value={sparklineComposite}
            onChange={(event) => {
              const val = event.target.value;
              if (!val) {
                controller.updateWidgetConfig(widgetId, {
                  kpiSparklineField: undefined,
                  kpiSparklineSourceId: undefined,
                });
                return;
              }
              const sepIdx = val.indexOf(':');
              const [fSourceId, fieldId] =
                sepIdx >= 0 ? [val.slice(0, sepIdx), val.slice(sepIdx + 1)] : [sourceId, val];
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineField: fieldId,
                kpiSparklineSourceId: fSourceId !== sourceId ? fSourceId : undefined,
              });
            }}
          >
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
            {(() => {
              // Group by source label
              const groups = new Map<string, typeof allDateFieldsWithJoined>();
              for (const f of allDateFieldsWithJoined) {
                if (!groups.has(f.sourceLabel)) {
                  groups.set(f.sourceLabel, []);
                }
                groups.get(f.sourceLabel)!.push(f);
              }
              return Array.from(groups.entries()).flatMap(([srcLabel, fields]) => {
                const isSecondary = fields[0]?.sourceId !== sourceId;
                return [
                  isSecondary ? (
                    <ListSubheader key={`hdr-${srcLabel}`}>{srcLabel}</ListSubheader>
                  ) : null,
                  ...fields.map((f) => {
                    const compositeKey =
                      f.sourceId !== sourceId ? `${f.sourceId}:${f.id}` : f.id;
                    return (
                      <MenuItem key={compositeKey} value={compositeKey}>
                        {f.label}
                      </MenuItem>
                    );
                  }),
                ].filter(Boolean);
              });
            })()}
          </Select>
        </FormControl>
      )}

      <FormControl size="small" fullWidth>
        <InputLabel>Granularity</InputLabel>
        <Select
          label="Granularity"
          value={config.kpiSparklineGranularity ?? ''}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiSparklineGranularity:
                (event.target.value as StudioWidgetConfig['kpiSparklineGranularity']) || undefined,
            })
          }
        >
          <MenuItem value="">
            <em>Auto</em>
          </MenuItem>
          {GRANULARITIES.map((g) => (
            <MenuItem key={g.value} value={g.value}>
              {g.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>Plot type</InputLabel>
        <Select
          label="Plot type"
          value={plotType}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiSparklinePlotType: event.target.value as 'line' | 'bar',
            })
          }
        >
          <MenuItem value="line">Line</MenuItem>
          <MenuItem value="bar">Bar</MenuItem>
        </Select>
      </FormControl>

      {plotType === 'line' && (
        <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
          control={
            <Switch
              size="small"
              checked={config.kpiSparklineArea ?? false}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, {
                  kpiSparklineArea: event.target.checked,
                })
              }
            />
          }
          label="Fill area"
        />
      )}

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            size="small"
            checked={config.kpiSparklineCumulative ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineCumulative: event.target.checked,
              })
            }
          />
        }
        label="Cumulative (running total)"
      />
    </Stack>
  );
}

function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const [title, setTitle] = React.useState(widget?.title ?? '');
  const [subtitle, setSubtitle] = React.useState(widget?.config.textSubtitle ?? '');
  const [body, setBody] = React.useState(widget?.config.textBody ?? '');

  React.useEffect(() => {
    setTitle(widget?.title ?? '');
    setSubtitle(widget?.config.textSubtitle ?? '');
    setBody(widget?.config.textBody ?? '');
  }, [widget?.title, widget?.config.textSubtitle, widget?.config.textBody, widgetId]);

  const handleTitleBlur = () => {
    if (title !== widget?.title) {
      controller.updateWidget(widgetId, { title });
    }
  };

  const handleBlur = () => {
    controller.updateWidgetConfig(widgetId, {
      textSubtitle: subtitle,
      textBody: body,
    });
  };

  return (
    <Stack spacing={2}>
      <TextField
        label="Title"
        size="small"
        fullWidth
        helperText="Heading displayed at the top of the widget"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={handleTitleBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            handleTitleBlur();
          }
        }}
      />
      <TextField
        label="Subtitle"
        size="small"
        fullWidth
        helperText="Smaller text below the heading"
        value={subtitle}
        onChange={(event) => setSubtitle(event.target.value)}
        onBlur={handleBlur}
      />
      <TextField
        label="Body"
        fullWidth
        multiline
        minRows={5}
        helperText="Main content of the widget; supports plain text"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onBlur={handleBlur}
      />
    </Stack>
  );
}

// ── Text formatting ────────────────────────────────────────────────────────────

interface TextSectionFormatProps {
  label: string;
  fontFamily?: 'serif' | 'monospace';
  fontSize?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  onFontFamilyChange: (v: 'serif' | 'monospace' | undefined) => void;
  onFontSizeChange: (v: number | undefined) => void;
  onColorChange: (v: string | undefined) => void;
  onAlignChange: (v: 'left' | 'center' | 'right' | undefined) => void;
}

function TextSectionFormat(props: TextSectionFormatProps) {
  const { label, fontFamily, fontSize, color, align,
    onFontFamilyChange, onFontSizeChange, onColorChange, onAlignChange } = props;

  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, '&:before': { display: 'none' } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />} sx={{ minHeight: 40, '& .MuiAccordionSummary-content': { my: 0 } }}>
        <Typography variant="body2">{label}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0, pb: 2 }}>
        <Stack spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>Font family</InputLabel>
            <Select
              label="Font family"
              value={fontFamily ?? ''}
              onChange={(event) => {
                const v = event.target.value as string;
                onFontFamilyChange(v === '' ? undefined : (v as 'serif' | 'monospace'));
              }}
            >
              <MenuItem value="">Default (theme)</MenuItem>
              <MenuItem value="serif">Serif</MenuItem>
              <MenuItem value="monospace">Monospace</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth>
            <InputLabel>Font size</InputLabel>
            <Select
              label="Font size"
              value={fontSize ?? 0}
              onChange={(event) => {
                const v = Number(event.target.value);
                onFontSizeChange(v === 0 ? undefined : v);
              }}
            >
              <MenuItem value={0}>Default</MenuItem>
              <MenuItem value={12}>12 px</MenuItem>
              <MenuItem value={14}>14 px</MenuItem>
              <MenuItem value={16}>16 px</MenuItem>
              <MenuItem value={18}>18 px</MenuItem>
              <MenuItem value={20}>20 px</MenuItem>
              <MenuItem value={24}>24 px</MenuItem>
              <MenuItem value={32}>32 px</MenuItem>
            </Select>
          </FormControl>

          <ColorInput
            label="Colour"
            value={color ?? ''}
            onChange={(v) => onColorChange(v || undefined)}
            placeholder="Default"
          />

          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Alignment
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={align ?? 'left'}
              onChange={(_event, val) => {
                if (val) {
                  onAlignChange(val === 'left' ? undefined : (val as 'center' | 'right'));
                }
              }}
            >
              <ToggleButton value="left" aria-label="Align left">
                <FormatAlignLeftIcon fontSize="small" />
              </ToggleButton>
              <ToggleButton value="center" aria-label="Align center">
                <FormatAlignCenterIcon fontSize="small" />
              </ToggleButton>
              <ToggleButton value="right" aria-label="Align right">
                <FormatAlignRightIcon fontSize="small" />
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

function TextFormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const config = useStudioSelector((state) => state.widgets[widgetId]?.config);

  if (!config) {
    return null;
  }

  const update = (changes: Partial<StudioWidgetConfig>) =>
    controller.updateWidgetConfig(widgetId, changes);

  return (
    <Stack spacing={1.5}>
      <TextSectionFormat
        label="Subtitle"
        fontFamily={config.textSubtitleFontFamily}
        fontSize={config.textSubtitleFontSize}
        color={config.textSubtitleColor}
        align={config.textSubtitleAlign}
        onFontFamilyChange={(v) => update({ textSubtitleFontFamily: v })}
        onFontSizeChange={(v) => update({ textSubtitleFontSize: v })}
        onColorChange={(v) => update({ textSubtitleColor: v })}
        onAlignChange={(v) => update({ textSubtitleAlign: v })}
      />
      <TextSectionFormat
        label="Body"
        fontFamily={config.textBodyFontFamily}
        fontSize={config.textBodyFontSize}
        color={config.textBodyColor}
        align={config.textBodyAlign}
        onFontFamilyChange={(v) => update({ textBodyFontFamily: v })}
        onFontSizeChange={(v) => update({ textBodyFontSize: v })}
        onColorChange={(v) => update({ textBodyColor: v })}
        onAlignChange={(v) => update({ textBodyAlign: v })}
      />
    </Stack>
  );
}


function FormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const [title, setTitle] = React.useState(widget?.title ?? '');
  const [subtitle, setSubtitle] = React.useState(widget?.subtitle ?? '');

  const isAutoTitle = widget?.titleMode === 'auto' || (!widget?.titleMode && !widget?.title);
  const isAutoSubtitle = widget?.subtitleMode === 'auto' || (!widget?.subtitleMode && !widget?.subtitle);

  React.useEffect(() => {
    setTitle(widget?.title ?? '');
    setSubtitle(widget?.subtitle ?? '');
  }, [widget?.title, widget?.subtitle, widgetId]);

  const handleTitleBlur = () => {
    const trimmed = title.trim();
    if (trimmed !== (widget?.title ?? '')) {
      controller.updateWidget(widgetId, { title: trimmed, titleMode: 'manual' });
    }
  };

  const handleResetTitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources);
    controller.updateWidget(widgetId, { title: inferred.title, titleMode: 'auto' });
    setTitle(inferred.title);
  };

  const handleSubtitleBlur = () => {
    const trimmed = subtitle.trim();
    if (trimmed !== (widget?.subtitle ?? '')) {
      controller.updateWidget(widgetId, {
        subtitle: trimmed || undefined,
        subtitleMode: trimmed ? 'manual' : 'auto',
      });
    }
  };

  const handleResetSubtitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources);
    controller.updateWidget(widgetId, { subtitle: inferred.subtitle, subtitleMode: 'auto' });
    setSubtitle(inferred.subtitle);
  };

  return (
    <Stack spacing={2}>
      {widget?.kind === 'kpi' && (
        <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
          control={
            <Switch
              size="small"
              checked={widget.config.kpiCompact ?? true}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, { kpiCompact: event.target.checked })
              }
            />
          }
          label="Compact numbers"
        />
      )}
      <TextField
        label="Widget title"
        size="small"
        fullWidth
        helperText="Shown in the widget header"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={handleTitleBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            handleTitleBlur();
          }
        }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                {isAutoTitle && title === (widget?.title ?? '') ? (
                  <Tooltip title="Auto-generated title">
                    <BoltIcon fontSize="small" color="action" />
                  </Tooltip>
                ) : !isAutoTitle ? (
                  <Tooltip title="Reset to auto-generated title">
                    <IconButton size="small" onClick={handleResetTitle} edge="end">
                      <AutorenewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null}
              </InputAdornment>
            ),
          },
        }}
      />
      <TextField
        label="Subtitle"
        size="small"
        fullWidth
        helperText="Optional line shown beneath the title"
        value={subtitle}
        placeholder={isAutoSubtitle ? '' : 'No subtitle'}
        onChange={(event) => setSubtitle(event.target.value)}
        onBlur={handleSubtitleBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            handleSubtitleBlur();
          }
        }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                {isAutoSubtitle && subtitle === (widget?.subtitle ?? '') ? (
                  <Tooltip title="Auto-generated subtitle">
                    <BoltIcon fontSize="small" color="action" />
                  </Tooltip>
                ) : !isAutoSubtitle ? (
                  <Tooltip title="Reset to auto-generated subtitle">
                    <IconButton size="small" onClick={handleResetSubtitle} edge="end">
                      <AutorenewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null}
              </InputAdornment>
            ),
          },
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
    <div>
      <Tabs
        value={tab}
        onChange={(_event, v) => setTab(v)}
        variant="fullWidth"
        sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab label="Setup" />
        <Tab label="Format" />
      </Tabs>

      <TabPanel value={tab} index={0}>
        {widget.kind === 'text' && <TextSetupPanel widgetId={widgetId} />}
        {widget.kind === 'grid' && <GridSetupPanel widgetId={widgetId} />}
        {widget.kind === 'chart' && <ChartSetupPanel widgetId={widgetId} />}
        {widget.kind === 'kpi' && <KpiSetupPanel widgetId={widgetId} />}
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

// ── Page config panel ─────────────────────────────────────────────────────────

/** Stable empty theme used as fallback so the selector never returns a new object reference. */
const EMPTY_PAGE_THEME: StudioPageTheme = {};

/** Inline colour swatch + hex text field. Uses native <input type="color"> for the picker. */
function ColorInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box
        component="input"
        type="color"
        value={value || '#ffffff'}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        sx={{
          width: 32,
          height: 32,
          p: 0,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          cursor: 'pointer',
          flexShrink: 0,
        }}
        aria-label={`${label} colour picker`}
      />
      <TextField
        size="small"
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? '#rrggbb'}
        helperText="Hex colour code"
        sx={{ flexGrow: 1 }}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
    </Box>
  );
}

// ── Chart palette UI helpers ──────────────────────────────────────────────────

/** Hard-coded light-mode swatches for each named palette (first 6 colors). */
const NAMED_PALETTES: { id: StudioChartPaletteName; label: string; swatches: string[] }[] = [
  {
    id: 'blueberryTwilight',
    label: 'Blueberry Twilight',
    swatches: ['#02B2AF', '#2E96FF', '#B800D8', '#60009B', '#2731C8', '#03008D'],
  },
  {
    id: 'mangoFusion',
    label: 'Mango Fusion',
    swatches: ['#173A5E', '#00A3A0', '#C91B63', '#EF5350', '#FFA726', '#B800D8'],
  },
  {
    id: 'cheerfulFiesta',
    label: 'Cheerful Fiesta',
    swatches: ['#003A75', '#007FFF', '#FFC24C', '#FF9D09', '#CA6C00', '#127D94'],
  },
  {
    id: 'rainbowSurge',
    label: 'Rainbow Surge',
    swatches: ['#4254FB', '#FFB422', '#FA4F58', '#0DBEFF', '#22BF75', '#FA83B4'],
  },
];

function PaletteSwatches({ colors }: { colors: string[] }) {
  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      {colors.map((color, i) => (
        <Box
          key={`${color}-${i}`}
          sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: color, flexShrink: 0 }}
        />
      ))}
    </Box>
  );
}

function ChartPalettePanel({
  pageTheme,
  update,
}: {
  pageTheme: StudioPageTheme;
  update: (changes: Partial<StudioPageTheme>) => void;
}) {
  const selected = pageTheme.chartPalette;

  const handleSelect = (id: StudioChartPaletteName | undefined) => {
    update({ chartPalette: id, chartCustomColors: undefined });
  };

  const customColors = pageTheme.chartCustomColors ?? [];

  const handleCustomColorChange = (index: number, value: string) => {
    const next = [...customColors];
    next[index] = value;
    update({ chartCustomColors: next });
  };

  const handleAddCustomColor = () => {
    update({ chartCustomColors: [...customColors, '#2196f3'] });
  };

  const handleRemoveCustomColor = (index: number) => {
    const next = customColors.filter((_, i) => i !== index);
    update({ chartCustomColors: next.length ? next : undefined });
  };

  const handleSelectCustom = () => {
    if (selected !== 'custom') {
      // Seed custom colors from the currently-selected named palette, or a default set
      const currentPalette = NAMED_PALETTES.find((p) => p.id === selected);
      const seed = currentPalette
        ? currentPalette.swatches
        : NAMED_PALETTES[0].swatches;
      update({ chartPalette: 'custom', chartCustomColors: [...seed] });
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Chart colours</Typography>

      <Stack spacing={0.5}>
        {/* "Default" (no override) option */}
        <Box
          onClick={() => handleSelect(undefined)}
          sx={{
            px: 1.5,
            py: 1,
            borderRadius: 1,
            cursor: 'pointer',
            border: 1,
            borderColor: !selected ? 'primary.main' : 'divider',
            bgcolor: !selected ? 'action.selected' : 'transparent',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              Theme default
            </Typography>
            {!selected && (
              <Typography variant="caption" color="primary">✓</Typography>
            )}
          </Box>
        </Box>

        {NAMED_PALETTES.map((p) => (
          <Box
            key={p.id}
            onClick={() => handleSelect(p.id)}
            sx={{
              px: 1.5,
              py: 1,
              borderRadius: 1,
              cursor: 'pointer',
              border: 1,
              borderColor: selected === p.id ? 'primary.main' : 'divider',
              bgcolor: selected === p.id ? 'action.selected' : 'transparent',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.75 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                {p.label}
              </Typography>
              {selected === p.id && (
                <Typography variant="caption" color="primary">✓</Typography>
              )}
            </Box>
            <PaletteSwatches colors={p.swatches} />
          </Box>
        ))}

        {/* Custom option */}
        <Box
          onClick={handleSelectCustom}
          sx={{
            px: 1.5,
            py: 1,
            borderRadius: 1,
            cursor: selected === 'custom' ? 'default' : 'pointer',
            border: 1,
            borderColor: selected === 'custom' ? 'primary.main' : 'divider',
            bgcolor: selected === 'custom' ? 'action.selected' : 'transparent',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', mb: customColors.length ? 0.75 : 0 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              Custom
            </Typography>
            {selected === 'custom' && (
              <Typography variant="caption" color="primary">✓</Typography>
            )}
          </Box>
          {customColors.length > 0 && (
            <PaletteSwatches colors={customColors} />
          )}
        </Box>
      </Stack>

      {selected === 'custom' && (
        <Stack spacing={1}>
          {customColors.map((color, index) => (
            <Box key={index} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {/* Native color picker */}
              <Box
                component="input"
                type="color"
                value={color}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  handleCustomColorChange(index, e.target.value)
                }
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  border: 1,
                  borderColor: 'divider',
                  padding: 0,
                  cursor: 'pointer',
                  flexShrink: 0,
                  '&::-webkit-color-swatch-wrapper': { padding: 0 },
                  '&::-webkit-color-swatch': { borderRadius: '50%', border: 'none' },
                }}
              />
              <TextField
                size="small"
                value={color}
                onChange={(e) => handleCustomColorChange(index, e.target.value)}
                sx={{ flex: 1 }}
                slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } }}
              />
              <IconButton
                size="small"
                onClick={() => handleRemoveCustomColor(index)}
                disabled={customColors.length <= 1}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
          <Box>
            <IconButton size="small" onClick={handleAddCustomColor}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Box>
        </Stack>
      )}
    </Stack>
  );
}

function PageConfigPanel() {
  const controller = useStudioController();
  const pageTheme =
    useStudioSelector((state) => state.pages[state.dashboard.activePageId]?.theme) ??
    EMPTY_PAGE_THEME;

  const update = (changes: Partial<StudioPageTheme>) => {
    controller.updateActivePage({ theme: { ...pageTheme, ...changes } });
  };

  const cardBorder = pageTheme.cardBorder !== false; // default true

  const PADDING_OPTIONS = [
    { value: 0, label: 'None' },
    { value: 1, label: 'Small (8px)' },
    { value: 2, label: 'Medium (16px)' },
    { value: 3, label: 'Large (24px)' },
  ];

  return (
    <Stack spacing={2.5} sx={{ pt: 1 }}>
      <Typography variant="subtitle2">Page</Typography>

      <ColorInput
        label="Background colour"
        value={pageTheme.pageBackground ?? ''}
        onChange={(v) => update({ pageBackground: v || undefined })}
        placeholder="e.g. #f5f5f5"
      />

      <Divider />

      <Typography variant="subtitle2">Cards</Typography>

      <ColorInput
        label="Card background"
        value={pageTheme.cardBackground ?? ''}
        onChange={(v) => update({ cardBackground: v || undefined })}
        placeholder="e.g. #ffffff"
      />

      <FormControl size="small" fullWidth>
        <InputLabel>Padding</InputLabel>
        <Select
          label="Padding"
          value={pageTheme.cardPadding ?? 2}
          onChange={(event) => update({ cardPadding: event.target.value as number })}
        >
          {PADDING_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <NumberField
        size="small"
        label="Corner radius (px)"
        value={pageTheme.cardRadius ?? null}
        min={0}
        max={64}
        onValueChange={(v) => update({ cardRadius: v ?? undefined })}
      />

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            checked={cardBorder}
            onChange={(event) => update({ cardBorder: event.target.checked })}
            size="small"
          />
        }
        label="Card border"
      />

      {cardBorder && (
        <React.Fragment>
          <ColorInput
            label="Border colour"
            value={pageTheme.cardBorderColor ?? ''}
            onChange={(v) => update({ cardBorderColor: v || undefined })}
            placeholder="e.g. #e0e0e0"
          />
          <NumberField
            size="small"
            label="Border width (px)"
            value={pageTheme.cardBorderWidth ?? null}
            min={1}
            max={16}
            onValueChange={(v) => update({ cardBorderWidth: v ?? undefined })}
          />
        </React.Fragment>
      )}

      <Divider />

      <ChartPalettePanel pageTheme={pageTheme} update={update} />
    </Stack>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function StudioComposeDrawer() {
  const [mainTab, setMainTab] = React.useState(0);
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);

  if (selectedWidgetId) {
    return <WidgetConfigView widgetId={selectedWidgetId} />;
  }

  const widgetsContent = (() => {
    if (selectedFieldId) {
      return <FieldDetailView />;
    }
    return <AddWidgetView />;
  })();

  return (
    <div>
      <Tabs
        value={mainTab}
        onChange={(_event, v) => setMainTab(v)}
        variant="fullWidth"
        sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab label="Widgets" />
        <Tab label="Page" />
      </Tabs>

      <TabPanel value={mainTab} index={0}>
        {widgetsContent}
      </TabPanel>
      <TabPanel value={mainTab} index={1}>
        <PageConfigPanel />
      </TabPanel>
    </div>
  );
}
