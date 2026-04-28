import { Box, IconButton, Switch, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import type { SwitchProps } from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import RedoIcon from '@mui/icons-material/Redo';
import UndoIcon from '@mui/icons-material/Undo';
import type { StudioMode, StudioPage } from '@mui/x-studio';

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
}

export function AppToolbar(props: AppToolbarProps) {
  const { title, mode, onModeChange, onSave, onLoad, pages, activePageId, onPageChange, canUndo, canRedo, onUndo, onRedo } = props;

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
      <Typography variant="h6" noWrap sx={{ color: 'text.primary', mr: 2, flexShrink: 0 }}>
        {title}
      </Typography>
      {pages.length > 1 && (
        <Tabs
          value={activePageId}
          onChange={onPageChange}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ flexGrow: 1, minWidth: 0 }}
        >
          {pages.map((page) => (
            <Tab key={page.id} label={page.title} value={page.id} sx={{ minHeight: 48 }} />
          ))}
        </Tabs>
      )}
      {pages.length <= 1 && <Box sx={{ flexGrow: 1 }} />}
      <Tooltip title="Load dashboard">
        <IconButton size="small" onClick={onLoad} aria-label="Load dashboard">
          <FileUploadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Save dashboard">
        <IconButton size="small" onClick={onSave} aria-label="Save dashboard">
          <FileDownloadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {mode === 'edit' && (
        <>
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
        </>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1 }}>
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
