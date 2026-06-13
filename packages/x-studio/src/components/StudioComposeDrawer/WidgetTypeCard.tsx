'use client';
import * as React from 'react';
import { Box, Paper, Typography } from '@mui/material';

import { useStudioLocaleText } from '../../context';
import type { StudioWidgetKind } from '../../models';
import {
  DRAG_TYPE_COMPOSE_WIDGET,
  type ComposeWidgetDragItem,
} from '../StudioCanvas/studioWidgetDndTypes';
import { useStudioDraggable } from '../StudioCanvas/useStudioDraggable';

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
  const ref = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  const getData = React.useCallback(
    (): ComposeWidgetDragItem => ({ type: DRAG_TYPE_COMPOSE_WIDGET, kind: wt.kind }),
    [wt.kind],
  );

  useStudioDraggable({
    ref,
    canDrag: canAdd,
    getData,
    onDragStart: () => setIsDragging(true),
    onDrop: () => setIsDragging(false),
  });

  return (
    <Paper
      ref={ref}
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
