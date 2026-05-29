'use client';
import * as React from 'react';
import { IconButton, Menu, MenuItem, Stack, Tooltip } from '@mui/material';
import type { SxProps } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
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
  /** Pages the widget can be moved to (excludes the current page). */
  moveToPageOptions: Array<{ id: string; title: string }>;
  onExport: (event: React.MouseEvent) => void;
  onExpand: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveToPage: (pageId: string) => void;
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
    moveToPageOptions,
    onExport,
    onExpand,
    onEdit,
    onDuplicate,
    onDelete,
    onMoveToPage,
  } = props;

  const [moveMenuAnchor, setMoveMenuAnchor] = React.useState<HTMLElement | null>(null);

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
        {moveToPageOptions.length > 0 && (
          <React.Fragment>
            <Tooltip title="Move to page">
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={(event) => {
                  event.stopPropagation();
                  setMoveMenuAnchor(event.currentTarget);
                }}
                aria-label="Move to page"
                tabIndex={showEditActions ? 0 : -1}
              >
                <DriveFileMoveOutlinedIcon />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={moveMenuAnchor}
              open={Boolean(moveMenuAnchor)}
              onClose={() => setMoveMenuAnchor(null)}
              onClick={(e) => e.stopPropagation()}
            >
              {moveToPageOptions.map((page) => (
                <MenuItem
                  key={page.id}
                  dense
                  onClick={() => {
                    onMoveToPage(page.id);
                    setMoveMenuAnchor(null);
                  }}
                >
                  {page.title}
                </MenuItem>
              ))}
            </Menu>
          </React.Fragment>
        )}
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
