import * as React from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  Switch,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import type { SwitchProps } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import RedoIcon from '@mui/icons-material/Redo';
import RestoreIcon from '@mui/icons-material/Restore';
import SettingsIcon from '@mui/icons-material/Settings';
import UndoIcon from '@mui/icons-material/Undo';
import type { StudioMode, StudioPage } from '@mui/x-studio';
import { StudioWordmark } from '@mui/x-studio';

export interface AppToolbarProps {
  title: string;
  mode: StudioMode;
  onModeChange: SwitchProps['onChange'];
  onSave: () => void;
  onLoad: () => void;
  onReset?: () => void;
  onOpenSettings: () => void;
  pages: StudioPage[];
  activePageId: string;
  onPageChange: (event: React.SyntheticEvent, pageId: string) => void;
  onPageClose?: (pageId: string) => void;
  onPageReorder?: (pageIds: string[]) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

export function AppToolbar(props: AppToolbarProps) {
  const {
    title,
    mode,
    onModeChange,
    onSave,
    onLoad,
    onReset,
    onOpenSettings,
    pages,
    activePageId,
    onPageChange,
    onPageClose,
    onPageReorder,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
  } = props;

  const [confirmPageId, setConfirmPageId] = React.useState<string | null>(null);
  const confirmPage = confirmPageId ? pages.find((p) => p.id === confirmPageId) : null;
  const showCloseButtons = mode === 'edit' && pages.length > 1 && Boolean(onPageClose);
  const [tabDragIndex, setTabDragIndex] = React.useState<number | null>(null);
  const [tabDragOverIndex, setTabDragOverIndex] = React.useState<number | null>(null);
  const showDragHandles = mode === 'edit' && pages.length > 1 && Boolean(onPageReorder);

  function handleTabDrop(dropIndex: number) {
    if (tabDragIndex === null || tabDragIndex === dropIndex) {
      setTabDragIndex(null);
      setTabDragOverIndex(null);
      return;
    }
    const newOrder = pages.map((p) => p.id);
    const [moved] = newOrder.splice(tabDragIndex, 1);
    // After removing the dragged tab, the target index shifts left when dragging forward
    const adjustedIndex = tabDragIndex < dropIndex ? dropIndex - 1 : dropIndex;
    newOrder.splice(adjustedIndex, 0, moved);
    onPageReorder?.(newOrder);
    setTabDragIndex(null);
    setTabDragOverIndex(null);
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        px: 2,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        gap: 1,
        minHeight: 48,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
        <StudioWordmark height={30} />
        {title && (
          <React.Fragment>
            <Box sx={{ width: '1px', height: 20, bgcolor: 'divider', flexShrink: 0 }} aria-hidden />
            <Typography
              variant="body1"
              sx={{
                fontSize: 18,
                color: 'text.secondary',
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </Typography>
          </React.Fragment>
        )}
      </Box>
      {pages.length > 1 && (
        <Tabs
          value={activePageId}
          onChange={onPageChange}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ flexGrow: 1, minWidth: 0 }}
        >
          {pages.map((page, index) => (
            <Tab
              key={page.id}
              value={page.id}
              draggable={showDragHandles}
              onDragStart={
                showDragHandles
                  ? (e) => {
                      setTabDragIndex(index);
                      e.dataTransfer.setData('text/x-studio-tab', page.id);
                    }
                  : undefined
              }
              onDragOver={
                showDragHandles
                  ? (e) => {
                      if (!Array.from(e.dataTransfer.types).includes('text/x-studio-tab')) return;
                      e.preventDefault();
                      setTabDragOverIndex(index);
                    }
                  : undefined
              }
              onDrop={
                showDragHandles
                  ? (e) => {
                      if (!Array.from(e.dataTransfer.types).includes('text/x-studio-tab')) return;
                      handleTabDrop(index);
                    }
                  : undefined
              }
              onDragEnd={
                showDragHandles
                  ? () => {
                      setTabDragIndex(null);
                      setTabDragOverIndex(null);
                    }
                  : undefined
              }
              sx={{
                minHeight: 48,
                opacity: tabDragIndex === index ? 0.4 : 1,
                borderLeft: tabDragOverIndex === index && tabDragIndex !== index ? 2 : 0,
                borderColor: 'primary.main',
                cursor: showDragHandles ? 'grab' : undefined,
              }}
              label={
                showCloseButtons ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <span>{page.title}</span>
                    <IconButton
                      size="small"
                      aria-label={`Remove page ${page.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmPageId(page.id);
                      }}
                      sx={{ p: 0.25, ml: 0.25 }}
                    >
                      <CloseIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Box>
                ) : (
                  page.title
                )
              }
            />
          ))}
        </Tabs>
      )}
      {pages.length <= 1 && <Box sx={{ flexGrow: 1 }} />}

      {/* Confirmation dialog for page removal */}
      <Dialog
        open={Boolean(confirmPage)}
        onClose={() => setConfirmPageId(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Remove page?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Remove &ldquo;{confirmPage?.title}&rdquo; and all its widgets? This action can be
            undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmPageId(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (confirmPageId) {
                onPageClose?.(confirmPageId);
              }
              setConfirmPageId(null);
            }}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>
      {mode === 'edit' && (
        <React.Fragment>
          <Tooltip title="Undo (⌘Z)">
            <span>
              <IconButton size="small" onClick={onUndo} disabled={!canUndo} aria-label="Undo">
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Redo (⌘⇧Z)">
            <span>
              <IconButton size="small" onClick={onRedo} disabled={!canRedo} aria-label="Redo">
                <RedoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
        </React.Fragment>
      )}
      <Tooltip title="Download dashboard">
        <IconButton size="small" onClick={onSave} aria-label="Download dashboard">
          <FileDownloadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Upload dashboard">
        <IconButton size="small" onClick={onLoad} aria-label="Upload dashboard">
          <FileUploadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {onReset && (
        <Tooltip title="Reset demo">
          <IconButton size="small" onClick={onReset} aria-label="Reset to demo">
            <RestoreIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="Settings">
        <IconButton size="small" onClick={onOpenSettings} aria-label="Settings">
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="body2" color={mode === 'view' ? 'text.primary' : 'text.secondary'}>
          View
        </Typography>
        <Switch
          checked={mode === 'edit'}
          onChange={onModeChange}
          size="small"
          slotProps={{ input: { 'aria-label': 'Toggle edit mode' } }}
        />
        <Typography variant="body2" color={mode === 'edit' ? 'text.primary' : 'text.secondary'}>
          Edit
        </Typography>
      </Box>
    </Box>
  );
}
