import { Dialog, DialogContent, DialogTitle, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FilterListIcon from '@mui/icons-material/FilterList';
import { StudioFiltersDrawer } from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export interface FiltersDialogProps {
  open: boolean;
  onClose: () => void;
}

export function FiltersDialog({ open, onClose }: FiltersDialogProps) {
  const t = useAppLocaleText();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { height: '80vh' } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
        <FilterListIcon fontSize="small" color="action" />
        {t.filtersTitle}
        <IconButton
          autoFocus
          aria-label={t.closeFiltersDialogAriaLabel}
          onClick={onClose}
          size="small"
          sx={{ ml: 'auto' }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 3, overflow: 'auto' }}>
        <StudioFiltersDrawer />
      </DialogContent>
    </Dialog>
  );
}
