import { Dialog, DialogContent, DialogTitle, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import StorageIcon from '@mui/icons-material/Storage';
import { StudioDataDrawer } from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export interface DataDialogProps {
  open: boolean;
  onClose: () => void;
}

export function DataDialog({ open, onClose }: DataDialogProps) {
  const t = useAppLocaleText();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      slotProps={{ paper: { sx: { height: '80vh' } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
        <StorageIcon fontSize="small" color="action" />
        {t.dataSourcesTitle}
        <IconButton
          autoFocus
          aria-label={t.closeDataDialogAriaLabel}
          onClick={onClose}
          size="small"
          sx={{ ml: 'auto' }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 3, overflow: 'auto' }}>
        <StudioDataDrawer />
      </DialogContent>
    </Dialog>
  );
}
