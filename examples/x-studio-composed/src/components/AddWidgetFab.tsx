import * as React from 'react';
import { Fab, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import {
  CanvasScrollContext,
  WIDGET_TYPES,
  createDefaultWidget,
  useStudioController,
} from '@mui/x-studio';
import type { StudioWidgetKind } from '@mui/x-studio';

export interface AddWidgetFabProps {
  /** Called after a widget is added — use to open the ComposeDialog for configuration. */
  onWidgetAdded?: () => void;
}

/**
 * AddWidgetFab — floating action button (edit mode only) that lets users pick
 * a widget type from a menu and adds it to the active page.
 * Place this inside CanvasScrollContext.Provider so it can scroll the canvas
 * after adding a widget. Pass onWidgetAdded to open the config dialog.
 */
export function AddWidgetFab({ onWidgetAdded }: AddWidgetFabProps) {
  const controller = useStudioController();
  const canvasScrollRef = React.useContext(CanvasScrollContext);

  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);

  const handleOpen = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  }, []);

  const handleClose = React.useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handleSelect = React.useCallback(
    (kind: StudioWidgetKind) => {
      setAnchorEl(null);
      const widget = createDefaultWidget(kind);
      controller.addWidget(widget);
      // Scroll canvas to bottom so the new widget is visible
      requestAnimationFrame(() => {
        canvasScrollRef?.current?.scrollTo({
          top: canvasScrollRef.current.scrollHeight,
          behavior: 'smooth',
        });
      });
      onWidgetAdded?.();
    },
    [controller, canvasScrollRef, onWidgetAdded],
  );

  return (
    <React.Fragment>
      <Tooltip title="Add widget" placement="left">
        <Fab
          color="primary"
          size="medium"
          aria-label="Add widget"
          aria-controls={open ? 'add-widget-menu' : undefined}
          aria-haspopup="true"
          aria-expanded={open ? 'true' : undefined}
          onClick={handleOpen}
          sx={{ position: 'absolute', bottom: 24, right: 24, zIndex: 10 }}
        >
          <AddIcon />
        </Fab>
      </Tooltip>
      <Menu
        id="add-widget-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        transformOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'top' }}
      >
        {WIDGET_TYPES.map(({ kind, label, description, icon }) => (
          <MenuItem key={kind} onClick={() => handleSelect(kind)}>
            <ListItemIcon sx={{ minWidth: 36 }}>{icon}</ListItemIcon>
            <ListItemText primary={label} secondary={description} />
          </MenuItem>
        ))}
      </Menu>
    </React.Fragment>
  );
}
