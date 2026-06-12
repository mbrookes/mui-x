'use client';
import * as React from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { useDrag } from 'react-dnd';
import { getEmptyImage } from 'react-dnd-html5-backend';

import { useStudioLocaleText } from '../../context';
import type { StudioWidgetKind } from '../../models';
import {
  DRAG_TYPE_COMPOSE_WIDGET,
  type ComposeWidgetDragItem,
} from '../StudioCanvas/studioWidgetDndTypes';

// ── Widget type cards ────────────────────────────────────────────────────────

export interface WidgetTypeEntry {
  kind: StudioWidgetKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}

export interface WidgetTypeCardProps {
  wt: WidgetTypeEntry;
  canAdd: boolean;
  onSelect: (kind: StudioWidgetKind) => void;
}

export function WidgetTypeCard({ wt, canAdd, onSelect }: WidgetTypeCardProps) {
  const localeText = useStudioLocaleText();
  const [{ isDragging }, dragRef, preview] = useDrag<
    ComposeWidgetDragItem,
    void,
    { isDragging: boolean }
  >({
    type: DRAG_TYPE_COMPOSE_WIDGET,
    item: { type: DRAG_TYPE_COMPOSE_WIDGET, kind: wt.kind },
    canDrag: () => canAdd,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  React.useEffect(() => {
    preview(getEmptyImage(), { captureDraggingState: true });
  }, [preview]);

  React.useEffect(() => {
    if (isDragging) {
      document.documentElement.classList.add('x-studio-dnd-active');
    } else {
      document.documentElement.classList.remove('x-studio-dnd-active');
    }
  }, [isDragging]);

  return (
    <Paper
      ref={(el) => {
        dragRef(el as HTMLElement | null);
      }}
      variant="outlined"
      onClick={() => {
        if (canAdd) {
          onSelect(wt.kind);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={localeText.addWidgetGroupAriaLabel(wt.label)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (canAdd) {
            onSelect(wt.kind);
          }
        }
      }}
      sx={{
        p: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        cursor: canAdd ? (isDragging ? 'grabbing' : 'default') : 'not-allowed',
        opacity: canAdd ? 1 : 0.5,
        transition: 'border-color 0.15s, background-color 0.15s',
        '&:hover': canAdd ? { borderColor: 'primary.main', bgcolor: 'action.hover' } : {},
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
        boxShadow: isDragging ? 4 : undefined,
      }}
    >
      <Box sx={{ color: 'primary.main', display: 'flex', flexShrink: 0 }}>{wt.icon}</Box>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="subtitle2">{wt.label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {wt.description}
        </Typography>
      </Box>
    </Paper>
  );
}
