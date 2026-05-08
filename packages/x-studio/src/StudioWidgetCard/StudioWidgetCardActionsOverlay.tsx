'use client';
import * as React from 'react';
import { IconButton, Stack, Tooltip } from '@mui/material';
import type { SxProps } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';

export interface StudioWidgetCardActionsOverlayProps {
  mode: 'edit' | 'view';
  canExport: boolean;
  isChart: boolean;
  exportLabel: string;
  showEditActions: boolean;
  showViewExport: boolean;
  showViewExpand: boolean;
  overlayTopSx: SxProps;
  onExport: (event: React.MouseEvent) => void;
  onExpand: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const actionButtonSx = { width: 24, height: 24, padding: 0, '& svg': { fontSize: 16 } } as const;

export function StudioWidgetCardActionsOverlay(props: StudioWidgetCardActionsOverlayProps) {
  const {
    mode,
    canExport,
    isChart,
    exportLabel,
    showEditActions,
    showViewExport,
    showViewExpand,
    overlayTopSx,
    onExport,
    onExpand,
    onEdit,
    onDuplicate,
    onDelete,
  } = props;

  if (mode === 'edit') {
    return (
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          position: 'absolute',
          ...overlayTopSx,
          right: 6,
          zIndex: 1,
          alignItems: 'center',
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          boxShadow: '0 2px 4px rgba(0,0,0,0.10)',
          px: 0.5,
          py: 0.25,
          visibility: showEditActions ? 'visible' : 'hidden',
          pointerEvents: showEditActions ? 'auto' : 'none',
        }}
      >
        {canExport && (
          <Tooltip title={exportLabel}>
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={onExport}
              aria-label={exportLabel}
              tabIndex={showEditActions ? 0 : -1}
            >
              <DownloadIcon />
            </IconButton>
          </Tooltip>
        )}
        {isChart && (
          <Tooltip title="Expand chart">
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                onExpand();
              }}
              aria-label="Expand chart"
              tabIndex={showEditActions ? 0 : -1}
            >
              <OpenInFullIcon />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Edit widget">
          <IconButton
            size="small"
            sx={actionButtonSx}
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
            aria-label="Edit widget"
            tabIndex={showEditActions ? 0 : -1}
          >
            <EditIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Duplicate widget">
          <IconButton
            size="small"
            sx={actionButtonSx}
            onClick={(event) => {
              event.stopPropagation();
              onDuplicate();
            }}
            aria-label="Duplicate widget"
            tabIndex={showEditActions ? 0 : -1}
          >
            <ContentCopyIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete widget">
          <IconButton
            size="small"
            sx={actionButtonSx}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            aria-label="Delete widget"
            tabIndex={showEditActions ? 0 : -1}
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>
    );
  }

  if (mode === 'view' && (canExport || isChart)) {
    return (
      <Stack
        direction="row"
        sx={{
          position: 'absolute',
          ...overlayTopSx,
          right: 6,
          zIndex: 1,
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          boxShadow: '0 2px 6px rgba(0,0,0,0.10)',
          visibility: showViewExport || showViewExpand ? 'visible' : 'hidden',
          pointerEvents: showViewExport || showViewExpand ? 'auto' : 'none',
        }}
      >
        {canExport && (
          <Tooltip title={exportLabel}>
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={onExport}
              aria-label={exportLabel}
              tabIndex={showViewExport ? 0 : -1}
            >
              <DownloadIcon />
            </IconButton>
          </Tooltip>
        )}
        {isChart && (
          <Tooltip title="Expand chart">
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                onExpand();
              }}
              aria-label="Expand chart"
              tabIndex={showViewExpand ? 0 : -1}
            >
              <OpenInFullIcon />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    );
  }

  return null;
}
