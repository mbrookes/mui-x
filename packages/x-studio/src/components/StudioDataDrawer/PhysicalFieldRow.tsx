'use client';
import { ListItemButton, Stack, Typography } from '@mui/material';
import type { StudioDataSource } from '../../models';
import { FieldTypeIcon } from '../../internals/FieldTypeIcon';
import FieldPreviewTooltip from './FieldPreviewTooltip';

interface PhysicalFieldRowProps {
  field: StudioDataSource['fields'][number];
  rows: StudioDataSource['rows'];
  isSelected: boolean;
  isEditMode: boolean;
  onSelect: () => void;
}

export default function PhysicalFieldRow({
  field,
  rows,
  isSelected,
  isEditMode,
  onSelect,
}: PhysicalFieldRowProps) {
  return (
    <FieldPreviewTooltip field={field} rows={rows}>
      <ListItemButton
        selected={isEditMode && isSelected}
        disableRipple={!isEditMode}
        onClick={isEditMode ? onSelect : undefined}
        sx={{
          borderRadius: 1,
          py: 0.25,
          px: 0.75,
          ...(!isEditMode && {
            cursor: 'default',
            '&:hover': { bgcolor: 'transparent' },
          }),
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexGrow: 1, minWidth: 0 }}>
          <FieldTypeIcon type={field.type} generated={field.generated} size={15} />
          <Typography variant="body2" noWrap sx={{ flexGrow: 1, userSelect: 'none' }}>
            {field.label}
          </Typography>
        </Stack>
      </ListItemButton>
    </FieldPreviewTooltip>
  );
}
