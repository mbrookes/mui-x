'use client';
import * as React from 'react';
import { Box, Paper, Typography } from '@mui/material';

import { useStudioController, useStudioSelector, selectMode, selectActivePage } from '../context';
import { StudioWidgetCard } from '../StudioWidgetCard';
import { createDefaultWidget, widgetKindRequiresDataSource } from '../internals/widgetUtils';

// Plain JS DnD insertion point component — must live at module level
function InsertionPoint({
  rowIndex: _rowIndex,
  colIndex: _colIndex,
  onDrop,
  orientation,
  mode,
}: {
  rowIndex: number;
  colIndex: number;
  onDrop: (data: any) => void;
  orientation: 'vertical' | 'horizontal';
  mode: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = React.useState(false);
  React.useEffect(() => {
    // No-op in view mode
    if (mode !== 'edit') {
      return undefined;
    }
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    function handleDragOver(event: DragEvent) {
      event.preventDefault();
      setIsOver(true);
    }
    function handleDragLeave(event: DragEvent) {
      // Ignore if the pointer moved to a child element (e.g. the indicator line)
      if (node?.contains(event.relatedTarget as Node)) {
        return;
      }
      setIsOver(false);
    }
    function handleDropEvent(event: DragEvent) {
      setIsOver(false);
      try {
        const data = JSON.parse(event.dataTransfer?.getData('application/json') || '{}');
        onDrop(data);
      } catch {
        /* ignore invalid JSON */
      }
    }
    node.addEventListener('dragover', handleDragOver);
    node.addEventListener('dragleave', handleDragLeave);
    node.addEventListener('drop', handleDropEvent);
    return () => {
      node.removeEventListener('dragover', handleDragOver);
      node.removeEventListener('dragleave', handleDragLeave);
      node.removeEventListener('drop', handleDropEvent);
    };
  }, [onDrop, mode]);
  // Only show the line when hovered, otherwise invisible and non-interfering
  return (
    <Box
      ref={ref}
      sx={{
        position: 'relative',
        ...(orientation === 'vertical'
          ? {
              width: 8,
              minWidth: 8,
              alignSelf: 'stretch',
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: 'center',
            }
          : {
              width: '100%',
              height: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'stretch',
            }),
        zIndex: isOver ? 2 : 1,
      }}
    >
      {isOver && orientation === 'vertical' && (
        <Box
          sx={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: 2,
            bgcolor: 'primary.main',
            borderRadius: 1,
            transform: 'translateX(-50%)',
            boxShadow: 2,
          }}
        />
      )}
      {isOver && orientation === 'horizontal' && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: 8,
            right: 8,
            height: 2,
            bgcolor: 'primary.main',
            borderRadius: 1,
            transform: 'translateY(-50%)',
            boxShadow: 2,
          }}
        />
      )}
    </Box>
  );
}

export const StudioCanvas = React.memo(function StudioCanvas() {
  const mode = useStudioSelector(selectMode);
  const activePage = useStudioSelector(selectActivePage);
  const widgetRows = activePage?.widgetRows;
  const pageTheme = activePage?.theme;
  const controller = useStudioController();

  // Drop handler for insertion points.
  // orientation='horizontal' → insert a brand-new row at rowIndex.
  // orientation='vertical'   → insert into the existing row at colIndex.
  const handleDrop =
    (rowIndex: number, colIndex: number, orientation: 'horizontal' | 'vertical') => (data: any) => {
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
        if (widgetKindRequiresDataSource(data.kind) && sources.length === 0) {
          return;
        }
        const newWidget = createDefaultWidget(data.kind, sources[0]);
        // Build the target row layout first, then commit once (widget + layout + selection
        // in a single store update so there's only one React render).
        const rows = widgetRows.map((r) => [...r]);
        if (orientation === 'horizontal') {
          rows.splice(rowIndex, 0, [newWidget.id]);
        } else {
          const row = rows[rowIndex] ?? [];
          row.splice(colIndex, 0, newWidget.id);
          rows[rowIndex] = row;
        }
        const state = controller.getState();
        const activePage = state.pages[activePageId];
        controller.updateState({
          widgets: { ...state.widgets, [newWidget.id]: newWidget },
          pages: {
            ...state.pages,
            [activePageId]: { ...activePage, widgetRows: rows },
          },
          shell: { ...state.shell, selectedWidgetId: newWidget.id },
        });
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
      <Box sx={{ p: mode === 'edit' ? 0 : '8px' }}>
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
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            {mode === 'edit'
              ? 'Use the Compose panel to add widgets or drag them here.'
              : 'Switch to Edit mode to add widgets.'}
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: '100%',
        p: mode === 'edit' ? 0 : '8px',
        backgroundColor: pageTheme?.pageBackground ?? undefined,
        minHeight: '100%',
      }}
      onMouseDown={(event) => {
        // Deselect when clicking the canvas background (not a widget card)
        const target = event.target as HTMLElement;
        if (!target.closest('[data-widget-card]')) {
          controller.setSelectedWidget(null);
        }
      }}
    >
      {/* Insertion point above the first row — inset by the vertical drop zone width (16px) on each side */}
      {mode === 'edit' && (
        <InsertionPoint
          rowIndex={0}
          colIndex={0}
          onDrop={handleDrop(0, 0, 'horizontal')}
          orientation="horizontal"
          mode={mode}
        />
      )}
      {widgetRows.map((row, rowIndex) => (
        <Box key={rowIndex} sx={rowIndex > 0 && mode !== 'edit' ? { mt: 1 } : undefined}>
          <Box
            sx={{
              display: 'flex',
              flexWrap: mode === 'edit' ? 'nowrap' : 'wrap',
              gap: mode === 'edit' ? 0 : 1,
              width: '100%',
              alignItems: 'stretch',
            }}
          >
            {/* Insertion point before first widget in row */}
            {mode === 'edit' && (
              <InsertionPoint
                rowIndex={rowIndex}
                colIndex={0}
                onDrop={handleDrop(rowIndex, 0, 'vertical')}
                orientation="vertical"
                mode={mode}
              />
            )}
            {row.map((widgetId, colIndex) => (
              <React.Fragment key={widgetId}>
                <Box sx={{ flex: 1, minWidth: mode === 'edit' ? 0 : 280, display: 'flex', flexDirection: 'column' }}>
                  <StudioWidgetCard
                    widgetId={widgetId}
                    isFirstRow={rowIndex === 0}
                    pageTheme={pageTheme}
                  />
                </Box>
                {/* Insertion point after this widget */}
                {mode === 'edit' && (
                  <InsertionPoint
                    rowIndex={rowIndex}
                    colIndex={colIndex + 1}
                    onDrop={handleDrop(rowIndex, colIndex + 1, 'vertical')}
                    orientation="vertical"
                    mode={mode}
                  />
                )}
              </React.Fragment>
            ))}
          </Box>
          {/* Insertion point below this row */}
          {mode === 'edit' && (
            <InsertionPoint
              rowIndex={rowIndex + 1}
              colIndex={0}
              onDrop={handleDrop(rowIndex + 1, 0, 'horizontal')}
              orientation="horizontal"
              mode={mode}
            />
          )}
        </Box>
      ))}
    </Box>
  );
});
