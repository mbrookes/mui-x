'use client';
import * as React from 'react';
import { Alert, Box, Paper, Stack, Typography } from '@mui/material';
import { CanvasScrollContext, useStudioController, useStudioSelector } from '../context';
import { createDefaultWidget, WIDGET_TYPES, widgetKindRequiresDataSource } from '../internals/widgetUtils';
import type { StudioWidgetKind } from '../models';

function getCursor(isDragging: boolean) {
  return isDragging ? 'grabbing' : 'grab';
}

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

export function AddWidgetView() {
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
