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
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import FilterListIcon from '@mui/icons-material/FilterList';
import LinkIcon from '@mui/icons-material/Link';
import RedoIcon from '@mui/icons-material/Redo';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import SettingsIcon from '@mui/icons-material/Settings';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';
import UndoIcon from '@mui/icons-material/Undo';
import type { StudioMode, StudioPage } from '@mui/x-studio';
import { StudioWordmark } from '@mui/x-studio';

export interface AppToolbarProps {
  title: string;
  mode: StudioMode;
  onModeChange: SwitchProps['onChange'];
  onSave: () => void;
  onLoad: () => void;
  pages: StudioPage[];
  activePageId: string;
  onPageChange: (event: React.SyntheticEvent, pageId: string) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onComposeOpen?: () => void;
  onDataOpen?: () => void;
  onFiltersOpen?: () => void;
  chatOpen?: boolean;
  onChatToggle?: () => void;
  onAddPage?: () => void;
  onPageClose?: (pageId: string) => void;
  onPageReorder?: (pageIds: string[]) => void;
  hasEmptyPage?: boolean;
  onRefresh?: () => void;
  onReset?: () => void;
  onCopyLink?: () => void;
  onSettingsOpen?: () => void;
}

export function AppToolbar(props: AppToolbarProps) {
  const {
    title,
    mode,
    onModeChange,
    onSave,
    onLoad,
    pages,
    activePageId,
    onPageChange,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onComposeOpen,
    onDataOpen,
    onFiltersOpen,
    chatOpen,
    onChatToggle,
    onAddPage,
    onPageClose,
    onPageReorder,
    hasEmptyPage,
    onRefresh,
    onReset,
    onCopyLink,
    onSettingsOpen,
  } = props;

  const [linkCopied, setLinkCopied] = React.useState(false);
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
    newOrder.splice(dropIndex, 0, moved);
    onPageReorder?.(newOrder);
    setTabDragIndex(null);
    setTabDragOverIndex(null);
  }

  const handleCopyLink = React.useCallback(() => {
    if (onCopyLink) {
      onCopyLink();
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [onCopyLink]);

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
      {(pages.length > 1 || mode === 'edit') && (
        <Box sx={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0 }}>
          <Tabs
            value={activePageId}
            onChange={onPageChange}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            sx={{ minWidth: 0 }}
          >
            {pages.map((page, index) => (
              <Tab
                key={page.id}
                value={page.id}
                draggable={showDragHandles}
                onDragStart={showDragHandles ? () => setTabDragIndex(index) : undefined}
                onDragOver={showDragHandles ? (e) => { e.preventDefault(); setTabDragOverIndex(index); } : undefined}
                onDrop={showDragHandles ? () => handleTabDrop(index) : undefined}
                onDragEnd={showDragHandles ? () => { setTabDragIndex(null); setTabDragOverIndex(null); } : undefined}
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
                  ) : page.title
                }
              />
            ))}
          </Tabs>
          {mode === 'edit' && onAddPage && !hasEmptyPage && (
            <Tooltip title="Add page">
              <IconButton size="small" onClick={onAddPage} aria-label="Add page" sx={{ ml: 0.5 }}>
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      )}
      {pages.length <= 1 && mode !== 'edit' && <Box sx={{ flexGrow: 1 }} />}

      {/* Confirmation dialog for page removal */}
      <Dialog open={Boolean(confirmPage)} onClose={() => setConfirmPageId(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove page?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Remove &ldquo;{confirmPage?.title}&rdquo; and all its widgets? This action can be undone.
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
          {onDataOpen && (
            <Tooltip title="Data sources">
              <IconButton size="small" onClick={onDataOpen} aria-label="Data sources">
                <StorageIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {onComposeOpen && (
            <Tooltip title="Configure widget">
              <IconButton size="small" onClick={onComposeOpen} aria-label="Configure widget">
                <TuneIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {onFiltersOpen && (
            <Tooltip title="Filters">
              <IconButton size="small" onClick={onFiltersOpen} aria-label="Filters">
                <FilterListIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
        </React.Fragment>
      )}
      {onChatToggle && (
        <Tooltip title={chatOpen ? 'Close AI assistant' : 'Open AI assistant'}>
          <IconButton
            size="small"
            onClick={onChatToggle}
            color={chatOpen ? 'primary' : 'default'}
            aria-label={chatOpen ? 'Close AI assistant' : 'Open AI assistant'}
          >
            <AutoAwesomeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {onRefresh && (
        <Tooltip title="Refresh data">
          <IconButton size="small" onClick={onRefresh} aria-label="Refresh data">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title={linkCopied ? 'Copied!' : 'Copy link'}>
        <IconButton size="small" onClick={handleCopyLink} aria-label="Copy link">
          <LinkIcon fontSize="small" />
        </IconButton>
      </Tooltip>
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
        <Tooltip title="Reset to demo">
          <IconButton size="small" onClick={onReset} aria-label="Reset to demo">
            <RestoreIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {onSettingsOpen && (
        <Tooltip title="Settings">
          <IconButton size="small" onClick={onSettingsOpen} aria-label="Settings">
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
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
