import * as React from 'react';
import * as pragmaticDnd from '@atlaskit/pragmatic-drag-and-drop';
import {
  Box,
  Chip,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

import { useStudioController, useStudioSelector } from '../context';
import type { StudioDataSource, StudioWidgetKind } from '../models';
import { StudioGridWidget } from './StudioGridWidget';
import { StudioChartWidget } from './StudioChartWidget';
import { StudioKpiWidget } from './StudioKpiWidget';
import { createDefaultWidget } from './widgetUtils';

const SALES_SOURCE_ID = 'source-sales';

function createSalesDataSource(): StudioDataSource {
  return {
    id: SALES_SOURCE_ID,
    label: 'Sales',
    fields: [
      { id: 'product', label: 'Product', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'revenue', label: 'Revenue', type: 'number' },
      { id: 'quantity', label: 'Quantity', type: 'number' },
      { id: 'margin', label: 'Margin %', type: 'number' },
    ],
    rows: [
      { id: 1, product: 'Alpha Pro', category: 'Software', region: 'DACH', revenue: 12400, quantity: 8, margin: 62 },
      { id: 2, product: 'Beta Suite', category: 'Hardware', region: 'UK', revenue: 9750, quantity: 5, margin: 38 },
      { id: 3, product: 'Gamma Cloud', category: 'Software', region: 'Nordics', revenue: 18200, quantity: 12, margin: 71 },
      { id: 4, product: 'Delta Device', category: 'Hardware', region: 'DACH', revenue: 6300, quantity: 3, margin: 22 },
      { id: 5, product: 'Epsilon Analytics', category: 'Software', region: 'UK', revenue: 21500, quantity: 15, margin: 68 },
      { id: 6, product: 'Zeta Connect', category: 'Services', region: 'Nordics', revenue: 7800, quantity: 6, margin: 45 },
      { id: 7, product: 'Eta Platform', category: 'Software', region: 'DACH', revenue: 16900, quantity: 11, margin: 74 },
      { id: 8, product: 'Theta Hub', category: 'Hardware', region: 'UK', revenue: 4200, quantity: 2, margin: 18 },
      { id: 9, product: 'Iota Insights', category: 'Services', region: 'DACH', revenue: 9100, quantity: 7, margin: 53 },
      { id: 10, product: 'Kappa Flow', category: 'Software', region: 'Nordics', revenue: 14600, quantity: 9, margin: 66 },
    ],
  };
}

interface WidgetCardProps {
  widgetId: string;
}

function WidgetCard(props: WidgetCardProps) {
  const [hovered, setHovered] = React.useState(false);
  const { widgetId } = props;
  const controller = useStudioController();
  const mode = useStudioSelector((state) => state.mode);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const isSelected = selectedWidgetId === widgetId;
  const source = useStudioSelector((state) =>
    widget?.sourceId ? state.dataSources[widget.sourceId] : undefined,
  );
  const ref = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  React.useEffect(() => {
    if (mode !== 'edit') return;
    const node = ref.current;
    if (!node) return;
    function handleDragStart(e: DragEvent) {
      setIsDragging(true);
      e.dataTransfer?.setData('application/json', JSON.stringify({ type: 'canvas-widget', widgetId }));
      if (node) e.dataTransfer?.setDragImage(node, 0, 0);
    }
    function handleDragEnd() {
      setIsDragging(false);
    }
    node.setAttribute('draggable', 'true');
    node.addEventListener('dragstart', handleDragStart);
    node.addEventListener('dragend', handleDragEnd);
    return () => {
      node.removeAttribute('draggable');
      node.removeEventListener('dragstart', handleDragStart);
      node.removeEventListener('dragend', handleDragEnd);
    };
  }, [widgetId, mode]);

  if (!widget) {
    return null;
  }

  const kindLabel: Record<StudioWidgetKind, string> = { grid: 'Table', chart: 'Chart', kpi: 'KPI' };

  return (
    <Paper
      ref={ref}
      variant="outlined"
      onClick={() => controller.setSelectedWidget(widgetId)}
      aria-selected={isSelected}
      aria-label={`Widget: ${widget.title}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          controller.setSelectedWidget(widgetId);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={{
        borderColor: isSelected ? 'primary.main' : 'divider',
        borderWidth: isSelected ? 2 : 1,
        cursor: isDragging ? 'grabbing' : 'pointer',
        p: 2,
        opacity: isDragging ? 0.5 : 1,
        transition: 'border-color 0.15s',
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
        boxShadow: isDragging ? 4 : undefined,
      }}
    >
      <Stack spacing={2}>
        {/* Widget header */}
        <Stack direction="row" alignItems="flex-start" spacing={1}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle1" noWrap sx={{ flexGrow: 1 }}>
                {widget.title}
              </Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {source?.label ?? 'Unbound source'}
            </Typography>
          </Box>
          {/* Edit/delete buttons on selected card, or on hover if no card is selected. Pill always in edit mode. */}
          {mode === 'edit' && (isSelected || (!isSelected && !selectedWidgetId && hovered)) ? (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Tooltip title="Duplicate widget">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.duplicateWidget(widgetId);
                  }}
                  aria-label="Duplicate widget"
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete widget">
                <IconButton
                  size="small"
                  color="error"
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.removeWidget(widgetId);
                  }}
                  aria-label="Delete widget"
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Chip label={kindLabel[widget.kind]} size="small" variant="outlined" sx={{ ml: 1 }} />
            </Stack>
          ) : (
            mode === 'edit' && (
              <Chip label={kindLabel[widget.kind]} size="small" variant="outlined" />
            )
          )}
        </Stack>
        {/* Widget content */}
        {widget.kind === 'grid' && <StudioGridWidget widget={widget} dataSource={source} />}
        {widget.kind === 'chart' && <StudioChartWidget widget={widget} dataSource={source} />}
        {widget.kind === 'kpi' && <StudioKpiWidget widget={widget} dataSource={source} />}
      </Stack>
    </Paper>
  );
}

export function StudioCanvas() {
  const mode = useStudioSelector((state) => state.mode);
  const widgetRows = useStudioSelector(
    (state) => state.pages[state.dashboard.activePageId].widgetRows,
  );
  const controller = useStudioController();

  // Droppable wrapper for insertion points
  // Plain JS DnD for insertion points
  function InsertionPoint({ rowIndex, colIndex, onDrop, orientation }: { rowIndex: number; colIndex: number; onDrop: (data: any) => void; orientation: 'vertical' | 'horizontal'; }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const [isOver, setIsOver] = React.useState(false);
    React.useEffect(() => {
      // No-op in view mode
      if (mode !== 'edit') return;
      const node = ref.current;
      if (!node) return;
      function handleDragOver(e: DragEvent) {
        e.preventDefault();
        setIsOver(true);
      }
      function handleDragLeave(e: DragEvent) {
        // Ignore if the pointer moved to a child element (e.g. the indicator line)
        if (node?.contains(e.relatedTarget as Node)) return;
        setIsOver(false);
      }
      function handleDropEvent(e: DragEvent) {
        setIsOver(false);
        try {
          const data = JSON.parse(e.dataTransfer?.getData('application/json') || '{}');
          onDrop(data);
        } catch {}
      }
      node.addEventListener('dragover', handleDragOver);
      node.addEventListener('dragleave', handleDragLeave);
      node.addEventListener('drop', handleDropEvent);
      return () => {
        node.removeEventListener('dragover', handleDragOver);
        node.removeEventListener('dragleave', handleDragLeave);
        node.removeEventListener('drop', handleDropEvent);
      };
    }, [onDrop]);
    // Only show the line when hovered, otherwise invisible and non-interfering
    return (
      <Box
        ref={ref}
        sx={{
          position: 'relative',
          ...(orientation === 'vertical'
            ? {
                width: 16,
                minWidth: 16,
                alignSelf: 'stretch',
                display: 'flex',
                alignItems: 'stretch',
                justifyContent: 'center',
              }
            : {
                width: '100%',
                height: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'stretch',
              }),
          zIndex: isOver ? 2 : 1,
        }}
      >
            {isOver && orientation === 'vertical' && (
              <Box sx={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 2,
                bgcolor: 'primary.main',
                borderRadius: 1,
                transform: 'translateX(-50%)',
                boxShadow: 2,
              }} />
            )}
            {isOver && orientation === 'horizontal' && (
              <Box sx={{
                position: 'absolute',
                top: '50%',
                left: 0,
                right: 0,
                height: 2,
                bgcolor: 'primary.main',
                borderRadius: 1,
                transform: 'translateY(-50%)',
                boxShadow: 2,
              }} />
            )}
          </Box>
        );
  }

  // Drop handler for insertion points.
  // orientation='horizontal' → insert a brand-new row at rowIndex.
  // orientation='vertical'   → insert into the existing row at colIndex.
  const handleDrop =
    (rowIndex: number, colIndex: number, orientation: 'horizontal' | 'vertical') =>
    (data: any) => {
      const activePageId = controller.getState().dashboard.activePageId;
      const updateRows = (rows: string[][]) => {
        controller.updateState({
          pages: {
            ...controller.getState().pages,
            [activePageId]: {
              ...controller.getState().pages[activePageId],
              widgetRows: rows,
            },
          },
        });
      };

      if (data?.type === 'compose-widget' && data.kind) {
        const sources = Object.values(controller.getState().dataSources);
        if (sources.length === 0) return;
        const newWidget = createDefaultWidget(data.kind, sources[0]);
        controller.addWidget(newWidget);
        const rows = widgetRows.map((r) => [...r]);
        if (orientation === 'horizontal') {
          // Insert a new row at rowIndex containing only this widget
          rows.splice(rowIndex, 0, [newWidget.id]);
        } else {
          const row = rows[rowIndex] ?? [];
          row.splice(colIndex, 0, newWidget.id);
          rows[rowIndex] = row;
        }
        updateRows(rows);
      } else if (data?.type === 'canvas-widget' && data.widgetId) {
        // Remove the widget from wherever it currently lives
        const rows = widgetRows.map((r) => r.filter((id) => id !== data.widgetId));
        if (orientation === 'horizontal') {
          // Insert a new row at rowIndex containing only this widget
          rows.splice(rowIndex, 0, [data.widgetId]);
        } else {
          const row = rows[rowIndex] ?? [];
          row.splice(colIndex, 0, data.widgetId);
          rows[rowIndex] = row;
        }
        // Remove any rows that became empty after the move
        const cleaned = rows.filter((r) => r.length > 0);
        updateRows(cleaned);
      }
    };

  if (!widgetRows || widgetRows.length === 0) {
    return (
      <Paper
        variant="outlined"
        sx={{
          alignItems: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minHeight: 420,
          p: 4,
          borderStyle: 'dashed',
          justifyContent: 'center',
        }}
      >
        <Typography variant="h6" color="text.secondary">
          Canvas is empty
        </Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center">
          {mode === 'edit'
            ? 'Use the Compose panel to add widgets or drag them here.'
            : 'Switch to Edit mode to add widgets.'}
        </Typography>
      </Paper>
    );
  }

  return (
    <Box sx={{ width: '100%' }}>
      {/* Insertion point above the first row — inset by the vertical drop zone width (16px) on each side */}
      {mode === 'edit' && (
        <Box sx={{ mx: '16px' }}>
          <InsertionPoint rowIndex={0} colIndex={0} onDrop={handleDrop(0, 0, 'horizontal')} orientation="horizontal" />
        </Box>
      )}
      {widgetRows.map((row, rowIndex) => (
        <Box key={rowIndex}>
          <Box sx={{ display: 'flex', gap: 0, width: '100%', alignItems: 'stretch' }}>
            {/* Insertion point before first widget in row */}
            {mode === 'edit' && <InsertionPoint rowIndex={rowIndex} colIndex={0} onDrop={handleDrop(rowIndex, 0, 'vertical')} orientation="vertical" />}
            {row.map((widgetId, colIndex) => (
              <React.Fragment key={widgetId}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <WidgetCard widgetId={widgetId} />
                </Box>
                {/* Insertion point after this widget */}
                {mode === 'edit' && <InsertionPoint rowIndex={rowIndex} colIndex={colIndex + 1} onDrop={handleDrop(rowIndex, colIndex + 1, 'vertical')} orientation="vertical" />}
              </React.Fragment>
            ))}
          </Box>
          {/* Insertion point below this row — inset by the vertical drop zone width (16px) on each side */}
          {mode === 'edit' && (
            <Box sx={{ mx: '16px' }}>
              <InsertionPoint rowIndex={rowIndex + 1} colIndex={0} onDrop={handleDrop(rowIndex + 1, 0, 'horizontal')} orientation="horizontal" />
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
