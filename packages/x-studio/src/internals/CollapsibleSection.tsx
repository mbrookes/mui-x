'use client';
import * as React from 'react';
import { Box, Collapse, IconButton, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

export interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  /** When provided, renders an "+" icon button on the right. */
  onAdd?: () => void;
  addDisabled?: boolean;
  addTooltip?: string;
  /** Optional secondary action shown to the left of the "+" button. */
  secondaryAction?: React.ReactNode;
  defaultExpanded?: boolean;
}

export function CollapsibleSection(props: CollapsibleSectionProps) {
  const {
    title,
    children,
    onAdd,
    addDisabled,
    addTooltip = 'Add',
    secondaryAction,
    defaultExpanded = true,
  } = props;
  const [expanded, setExpanded] = React.useState(defaultExpanded);

  return (
    <div>
      <Box
        sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        {secondaryAction}
        {onAdd != null && (
          <Tooltip title={addTooltip}>
            <span>
              <IconButton
                size="small"
                disabled={addDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onAdd();
                }}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ pl: 0.5 }}>{children}</Box>
      </Collapse>
    </div>
  );
}
