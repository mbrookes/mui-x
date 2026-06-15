'use client';
import * as React from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
} from '@mui/material';
import type { SxProps } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import EditIcon from '@mui/icons-material/Edit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import TroubleshootIcon from '@mui/icons-material/Troubleshoot';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import { useStudioLocaleText } from '../../context';
import type { WidgetMoveDirection } from '../../internals/widgetLayoutMove';

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
  /** Called when the {localeText.widgetAiAssistantTooltip} button is clicked. When omitted, the button is hidden. */
  onAiRequest?: () => void;
  /**
   * Called when the user selects an AI insight type. When provided, an AI Insight
   * button appears in the overlay (visible in both edit and view modes when `aiConfig` is set).
   * @param {'summary' | 'analysis' | 'forecast'} type - The insight type the user selected.
   */
  onInsightRequest?: (type: 'summary' | 'analysis' | 'forecast') => void;
  /** When true, anomaly detection is currently active on this chart widget. */
  anomalyEnabled?: boolean;
  /** Number of anomalies detected. Only meaningful when `anomalyEnabled` is true. */
  anomalyCount?: number;
  /** Called when the user toggles anomaly detection. Only shown for chart widgets. */
  onAnomalyToggle?: () => void;
  /** Called when the user requests an AI explanation of detected anomalies. */
  onAnomalyExplain?: () => void;
  onExport: (event: React.MouseEvent) => void;
  onExpand: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveToPage: (pageId: string) => void;
  /** Keyboard-accessible reorder of the widget within the canvas layout. */
  onMoveWidget?: (direction: WidgetMoveDirection) => void;
  /** Which directional moves are unavailable (widget already at an edge). */
  moveWidgetDisabled?: Record<WidgetMoveDirection, boolean>;
}

const actionButtonSx = { width: 24, height: 24, padding: 0, '& svg': { fontSize: 16 } } as const;

// react-doctor-disable-next-line react-doctor/no-giant-component -- this component is a single cohesive overlay; splitting it would distribute tightly-coupled action state
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
    onAiRequest,
    onInsightRequest,
    anomalyEnabled,
    anomalyCount,
    onAnomalyToggle,
    onAnomalyExplain,
    onExport,
    onExpand,
    onEdit,
    onDuplicate,
    onMoveWidget,
    moveWidgetDisabled,
    onDelete,
    onMoveToPage,
  } = props;

  const [moveMenuAnchor, setMoveMenuAnchor] = React.useState<HTMLElement | null>(null);
  const [insightMenuAnchor, setInsightMenuAnchor] = React.useState<HTMLElement | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const deleteButtonRef = React.useRef<HTMLButtonElement>(null);
  const localeText = useStudioLocaleText();

  const handleDeleteClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = () => {
    setDeleteConfirmOpen(false);
    onDelete();
  };

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false);
    // Return focus to the delete button so keyboard users don't lose their place.
    requestAnimationFrame(() => deleteButtonRef.current?.focus());
  };

  if (mode === 'edit') {
    return (
      <React.Fragment>
        <Stack
          data-widget-overlay
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
            <Tooltip title={localeText.widgetExpandTooltip}>
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={(event) => {
                  event.stopPropagation();
                  onExpand();
                }}
                aria-label={localeText.widgetExpandTooltip}
                tabIndex={showEditActions ? 0 : -1}
              >
                <OpenInFullIcon />
              </IconButton>
            </Tooltip>
          )}
          {onAiRequest && (
            <Tooltip title={localeText.widgetAiAssistantTooltip}>
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={(event) => {
                  event.stopPropagation();
                  onAiRequest();
                }}
                aria-label={localeText.widgetAiAssistantTooltip}
                tabIndex={showEditActions ? 0 : -1}
              >
                <AutoAwesomeIcon />
              </IconButton>
            </Tooltip>
          )}
          {onInsightRequest && (
            <React.Fragment>
              <Tooltip title={localeText.widgetAiInsightTooltip}>
                <IconButton
                  size="small"
                  sx={actionButtonSx}
                  onClick={(event) => {
                    event.stopPropagation();
                    setInsightMenuAnchor(event.currentTarget);
                  }}
                  aria-label={localeText.widgetAiInsightTooltip}
                  tabIndex={showEditActions ? 0 : -1}
                >
                  <AutoAwesomeIcon sx={{ opacity: 0.7 }} />
                </IconButton>
              </Tooltip>
              <Menu
                anchorEl={insightMenuAnchor}
                open={Boolean(insightMenuAnchor)}
                onClose={() => setInsightMenuAnchor(null)}
                onClick={(event) => event.stopPropagation()}
              >
                {(['summary', 'analysis', 'forecast'] as const).map((type) => (
                  <MenuItem
                    key={type}
                    dense
                    sx={{ textTransform: 'capitalize' }}
                    onClick={() => {
                      onInsightRequest(type);
                      setInsightMenuAnchor(null);
                    }}
                  >
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </MenuItem>
                ))}
              </Menu>
            </React.Fragment>
          )}
          {isChart && onAnomalyToggle && (
            <Tooltip
              title={
                anomalyEnabled
                  ? localeText.widgetHideAnomalyTooltip
                  : localeText.widgetDetectAnomalyTooltip
              }
            >
              <IconButton
                size="small"
                sx={{
                  ...actionButtonSx,
                  color: anomalyEnabled ? 'warning.main' : undefined,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onAnomalyToggle();
                }}
                aria-label={
                  anomalyEnabled
                    ? localeText.widgetHideAnomalyTooltip
                    : localeText.widgetDetectAnomalyTooltip
                }
                tabIndex={showEditActions ? 0 : -1}
              >
                <Badge
                  badgeContent={anomalyEnabled && anomalyCount ? anomalyCount : 0}
                  color="warning"
                  sx={{ '& .MuiBadge-badge': { fontSize: 8, minWidth: 12, height: 12, p: 0 } }}
                >
                  <TroubleshootIcon />
                </Badge>
              </IconButton>
            </Tooltip>
          )}
          {anomalyEnabled && onAnomalyExplain && (
            <Tooltip title={localeText.widgetExplainAnomalyTooltip}>
              <IconButton
                size="small"
                sx={{ ...actionButtonSx }}
                onClick={(event) => {
                  event.stopPropagation();
                  onAnomalyExplain();
                }}
                aria-label={localeText.widgetExplainAnomalyTooltip}
                tabIndex={showEditActions ? 0 : -1}
              >
                <AutoAwesomeIcon sx={{ opacity: 0.7 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={localeText.widgetEditTooltip}>
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
              aria-label={localeText.widgetEditTooltip}
              tabIndex={showEditActions ? 0 : -1}
            >
              <EditIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title={localeText.widgetDuplicateTooltip}>
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                onDuplicate();
              }}
              aria-label={localeText.widgetDuplicateTooltip}
              tabIndex={showEditActions ? 0 : -1}
            >
              <ContentCopyIcon />
            </IconButton>
          </Tooltip>
          {(onMoveWidget || moveToPageOptions.length > 0) && (
            <React.Fragment>
              <Tooltip title={localeText.widgetMoveToPageLabel}>
                <IconButton
                  size="small"
                  sx={actionButtonSx}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMoveMenuAnchor(event.currentTarget);
                  }}
                  aria-label={localeText.widgetMoveToPageLabel}
                  aria-haspopup="menu"
                  tabIndex={showEditActions ? 0 : -1}
                >
                  <DriveFileMoveOutlinedIcon />
                </IconButton>
              </Tooltip>
              <Menu
                anchorEl={moveMenuAnchor}
                open={Boolean(moveMenuAnchor)}
                onClose={() => setMoveMenuAnchor(null)}
                onClick={(event) => event.stopPropagation()}
              >
                {onMoveWidget && [
                  <MenuItem
                    key="move-up"
                    dense
                    disabled={moveWidgetDisabled?.up}
                    onClick={() => {
                      onMoveWidget('up');
                      setMoveMenuAnchor(null);
                    }}
                  >
                    <ListItemIcon>
                      <KeyboardArrowUpIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{localeText.canvasMoveWidgetUpAriaLabel}</ListItemText>
                  </MenuItem>,
                  <MenuItem
                    key="move-down"
                    dense
                    disabled={moveWidgetDisabled?.down}
                    onClick={() => {
                      onMoveWidget('down');
                      setMoveMenuAnchor(null);
                    }}
                  >
                    <ListItemIcon>
                      <KeyboardArrowDownIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{localeText.canvasMoveWidgetDownAriaLabel}</ListItemText>
                  </MenuItem>,
                  <MenuItem
                    key="move-left"
                    dense
                    disabled={moveWidgetDisabled?.left}
                    onClick={() => {
                      onMoveWidget('left');
                      setMoveMenuAnchor(null);
                    }}
                  >
                    <ListItemIcon>
                      <KeyboardArrowLeftIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{localeText.canvasMoveWidgetLeftAriaLabel}</ListItemText>
                  </MenuItem>,
                  <MenuItem
                    key="move-right"
                    dense
                    disabled={moveWidgetDisabled?.right}
                    onClick={() => {
                      onMoveWidget('right');
                      setMoveMenuAnchor(null);
                    }}
                  >
                    <ListItemIcon>
                      <KeyboardArrowRightIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{localeText.canvasMoveWidgetRightAriaLabel}</ListItemText>
                  </MenuItem>,
                ]}
                {onMoveWidget && moveToPageOptions.length > 0 && <Divider key="move-divider" />}
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
          <Tooltip title={localeText.widgetDeleteTooltip}>
            <IconButton
              ref={deleteButtonRef}
              size="small"
              sx={actionButtonSx}
              onClick={handleDeleteClick}
              aria-label={localeText.widgetDeleteTooltip}
              tabIndex={showEditActions ? 0 : -1}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Stack>
        <Dialog
          open={deleteConfirmOpen}
          onClose={handleDeleteCancel}
          onClick={(event) => event.stopPropagation()}
          aria-labelledby="widget-delete-dialog-title"
          aria-describedby="widget-delete-dialog-desc"
        >
          <DialogTitle id="widget-delete-dialog-title">
            {localeText.widgetDeleteConfirmTitle}
          </DialogTitle>
          <DialogContent>
            <DialogContentText id="widget-delete-dialog-desc">
              {localeText.widgetDeleteConfirmMessage}
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleDeleteCancel} autoFocus>
              {localeText.widgetDeleteConfirmCancel}
            </Button>
            <Button onClick={handleDeleteConfirm} color="error">
              {localeText.widgetDeleteConfirmOk}
            </Button>
          </DialogActions>
        </Dialog>
      </React.Fragment>
    );
  }

  if (mode === 'view' && (canExport || isChart || onInsightRequest || onAnomalyToggle)) {
    return (
      <Stack
        data-widget-overlay
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
          visibility:
            showViewExport ||
            showViewExpand ||
            Boolean(onInsightRequest) ||
            Boolean(onAnomalyToggle)
              ? 'visible'
              : 'hidden',
          pointerEvents:
            showViewExport ||
            showViewExpand ||
            Boolean(onInsightRequest) ||
            Boolean(onAnomalyToggle)
              ? 'auto'
              : 'none',
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
          <Tooltip title={localeText.widgetExpandTooltip}>
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                onExpand();
              }}
              aria-label={localeText.widgetExpandTooltip}
              tabIndex={showViewExpand ? 0 : -1}
            >
              <OpenInFullIcon />
            </IconButton>
          </Tooltip>
        )}
        {onInsightRequest && (
          <React.Fragment>
            <Tooltip title={localeText.widgetAiInsightTooltip}>
              <IconButton
                size="small"
                sx={actionButtonSx}
                onClick={(event) => {
                  event.stopPropagation();
                  setInsightMenuAnchor(event.currentTarget);
                }}
                aria-label={localeText.widgetAiInsightTooltip}
              >
                <AutoAwesomeIcon />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={insightMenuAnchor}
              open={Boolean(insightMenuAnchor)}
              onClose={() => setInsightMenuAnchor(null)}
              onClick={(event) => event.stopPropagation()}
            >
              {(['summary', 'analysis', 'forecast'] as const).map((type) => (
                <MenuItem
                  key={type}
                  dense
                  sx={{ textTransform: 'capitalize' }}
                  onClick={() => {
                    onInsightRequest(type);
                    setInsightMenuAnchor(null);
                  }}
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </MenuItem>
              ))}
            </Menu>
          </React.Fragment>
        )}
        {isChart && onAnomalyToggle && (
          <Tooltip
            title={
              anomalyEnabled
                ? localeText.widgetHideAnomalyTooltip
                : localeText.widgetDetectAnomalyTooltip
            }
          >
            <IconButton
              size="small"
              sx={{
                ...actionButtonSx,
                color: anomalyEnabled ? 'warning.main' : undefined,
              }}
              onClick={(event) => {
                event.stopPropagation();
                onAnomalyToggle();
              }}
              aria-label={
                anomalyEnabled
                  ? localeText.widgetHideAnomalyTooltip
                  : localeText.widgetDetectAnomalyTooltip
              }
            >
              <Badge
                badgeContent={anomalyEnabled && anomalyCount ? anomalyCount : 0}
                color="warning"
                sx={{ '& .MuiBadge-badge': { fontSize: 8, minWidth: 12, height: 12, p: 0 } }}
              >
                <TroubleshootIcon />
              </Badge>
            </IconButton>
          </Tooltip>
        )}
        {anomalyEnabled && onAnomalyExplain && (
          <Tooltip title={localeText.widgetExplainAnomalyTooltip}>
            <IconButton
              size="small"
              sx={actionButtonSx}
              onClick={(event) => {
                event.stopPropagation();
                onAnomalyExplain();
              }}
              aria-label={localeText.widgetExplainAnomalyTooltip}
            >
              <AutoAwesomeIcon sx={{ opacity: 0.7 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    );
  }

  return null;
}
