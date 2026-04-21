import * as React from 'react';
import { Box, IconButton, Switch, Tooltip, Typography } from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import type { StudioMode } from '../../../../packages/x-studio/src';

export interface AppToolbarProps {
  mode: StudioMode;
  onModeChange: (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => void;
  onSave: () => void;
  onLoad: () => void;
}

export function AppToolbar(props: AppToolbarProps) {
  const { mode, onModeChange, onSave, onLoad } = props;

  return (
    <Box
      sx={{
        position: 'fixed',
        top: 8,
        right: 8,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
      }}
    >
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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1 }}>
        <Typography variant="body2" color={mode === 'view' ? 'text.primary' : 'text.secondary'}>
          View
        </Typography>
        <Switch
          checked={mode === 'edit'}
          onChange={onModeChange}
          size="small"
          inputProps={{ 'aria-label': 'Toggle edit mode' }}
        />
        <Typography variant="body2" color={mode === 'edit' ? 'text.primary' : 'text.secondary'}>
          Edit
        </Typography>
      </Box>
    </Box>
  );
}
