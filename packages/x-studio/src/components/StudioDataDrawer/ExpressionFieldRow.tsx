'use client';
import { IconButton, ListItemButton, Stack, Tooltip, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { useStudioLocaleText } from '../../context';
import type { StudioExpressionField } from '../../models';
import { FieldTypeIcon } from '../../internals/FieldTypeIcon';
import FieldPreviewTooltip from './FieldPreviewTooltip';

interface ExpressionFieldRowProps {
  field: StudioExpressionField;
  isEditMode: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Enriched rows (with calculated columns) for the field preview tooltip. */
  enrichedRows?: Record<string, unknown>[];
  /** Single aggregate value for measure fields. */
  measureValue?: unknown;
}

export default function ExpressionFieldRow({
  field,
  isEditMode,
  onEdit,
  onDelete,
  enrichedRows,
  measureValue,
}: ExpressionFieldRowProps) {
  const localeText = useStudioLocaleText();
  const type = field.type ?? (field.isMeasure ? 'number' : 'string');

  // For measure fields show the aggregate value; for columns use the enriched rows
  let previewRows: Record<string, unknown>[] | undefined;
  if (field.isMeasure) {
    previewRows = measureValue !== undefined ? [{ [field.id]: measureValue }] : undefined;
  } else {
    previewRows = enrichedRows;
  }

  const primaryContent = (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexGrow: 1, minWidth: 0 }}>
      <FieldTypeIcon type={type} generated size={15} />
      <Typography variant="body2" noWrap sx={{ flexGrow: 1, userSelect: 'none' }}>
        {field.label}
      </Typography>
    </Stack>
  );

  return (
    <FieldPreviewTooltip field={field} rows={previewRows}>
      <ListItemButton
        sx={{
          borderRadius: 1,
          py: 0.25,
          px: 0.75,
          ...(!isEditMode && {
            cursor: 'default',
            '&:hover': { bgcolor: 'transparent' },
          }),
        }}
        disableRipple={!isEditMode}
        onClick={isEditMode ? onEdit : undefined}
      >
        {primaryContent}
        {isEditMode && (
          <Stack direction="row" sx={{ gap: '2px' }}>
            <Tooltip title={localeText.dataDrawerEditTooltip}>
              <IconButton
                size="small"
                sx={{ p: '2px' }}
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit();
                }}
              >
                <EditIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title={localeText.dataDrawerDeleteTooltip}>
              <IconButton
                size="small"
                sx={{ p: '2px' }}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
              >
                <DeleteIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Stack>
        )}
      </ListItemButton>
    </FieldPreviewTooltip>
  );
}
