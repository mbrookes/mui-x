'use client';
import * as React from 'react';
import { Box, Chip, Collapse, IconButton, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  /** When provided, renders an "+" icon button on the right. */
  onAdd?: () => void;
  addDisabled?: boolean;
  addTooltip?: string;
  /** Optional secondary action shown to the left of the "+" button. */
  secondaryAction?: React.ReactNode;
  defaultExpanded?: boolean;
  /**
   * Number of items in this section. When the section is collapsed and count > 0,
   * a small badge is shown next to the title so the user knows filters are active.
   */
  count?: number;
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
    count,
  } = props;
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const regionId = React.useId();

  return (
    <div>
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Box
          component="button"
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-controls={regionId}
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexGrow: 1,
            minWidth: 0,
            border: 0,
            m: 0,
            p: 0,
            background: 'transparent',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            userSelect: 'none',
            borderRadius: 1,
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          {/* Decorative chevron — rendered as a span so it is not a nested button. */}
          <IconButton component="span" size="small" tabIndex={-1} aria-hidden sx={{ pointerEvents: 'none' }}>
            {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>
          <Typography variant="subtitle2" component="span" sx={{ flexGrow: 1 }}>
            {title}
            {!expanded && count != null && count > 0 && (
              <Chip
                component="span"
                label={count}
                size="small"
                sx={{ ml: 0.75, height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
              />
            )}
          </Typography>
        </Box>
        {secondaryAction}
        {onAdd != null && (
          <Tooltip title={addTooltip}>
            <span>
              <IconButton
                size="small"
                disabled={addDisabled}
                aria-label={addTooltip}
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
        <Box id={regionId} sx={{ pl: 0.5 }}>
          {children}
        </Box>
      </Collapse>
    </div>
  );
}
