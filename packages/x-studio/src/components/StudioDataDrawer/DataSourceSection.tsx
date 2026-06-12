'use client';
import * as React from 'react';
import { Box, Collapse, List, ListItemButton, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useStudioController, useStudioSelector, selectShell } from '../../context/index.ts';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioRelationship,
} from '../../models/index.ts';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';
import { enrichRowsWithExpressions, evaluateMeasure } from '../../utils/expressionEvaluator.ts';
import DataSourcePreviewTooltip from './DataSourcePreviewTooltip.tsx';
import PhysicalFieldRow from './PhysicalFieldRow.tsx';
import ExpressionFieldRow from './ExpressionFieldRow.tsx';

export function DataSourceSection(props: {
  source: StudioDataSource;
  expressionFields: StudioExpressionField[];
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  isEditMode: boolean;
  onOpenPreview?: (sourceId: string) => void;
}) {
  const { source, expressionFields, dataSources, relationships, isEditMode, onOpenPreview } = props;
  const [open, setOpen] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingField, setEditingField] = React.useState<StudioExpressionField | undefined>(
    undefined,
  );
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const selectedFieldId = shell.selectedFieldId;
  const selectedSourceId = shell.selectedSourceId;

  const sourceExprFields = expressionFields.filter((ef) => ef.sourceId === source.id && !ef.hidden);

  // Enrich source rows with calculated column values for preview tooltips
  const enrichedRows = React.useMemo(() => {
    if (!source.rows || source.rows.length === 0) {
      return source.rows;
    }
    return enrichRowsWithExpressions(
      source.rows,
      expressionFields,
      source.id,
      dataSources,
      relationships,
    );
  }, [source.rows, source.id, expressionFields, dataSources, relationships]);

  const handleAddExpressionField = () => {
    setEditingField(undefined);
    setDialogOpen(true);
  };

  const handleEditExpressionField = (field: StudioExpressionField) => {
    setEditingField(field);
    setDialogOpen(true);
  };

  const handleDeleteExpressionField = (fieldId: string) => {
    controller.removeExpressionField(fieldId);
  };

  const visibleFieldCount = source.fields.filter((f) => !f.hidden).length + sourceExprFields.length;
  const sectionSecondaryText = `${visibleFieldCount} field${visibleFieldCount !== 1 ? 's' : ''} · ${source.rows?.length ?? 0} rows`;

  return (
    <div>
      <DataSourcePreviewTooltip source={source} onOpenPreview={onOpenPreview}>
        <ListItemButton onClick={() => setOpen((prev) => !prev)} sx={{ pl: 2, pr: 1, py: 0.5 }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" noWrap sx={{ userSelect: 'none' }}>
              {source.label}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ userSelect: 'none' }}>
              {sectionSecondaryText}
            </Typography>
          </Box>
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </ListItemButton>
      </DataSourcePreviewTooltip>

      <Collapse in={open}>
        <List dense disablePadding sx={{ pl: 1 }}>
          {/* Physical fields */}
          {source.fields.flatMap((field) => {
            if (field.hidden) {
              return [];
            }
            const isSelected = selectedSourceId === source.id && selectedFieldId === field.id;
            return [
              <PhysicalFieldRow
                key={field.id}
                field={field}
                rows={source.rows}
                isSelected={isSelected}
                isEditMode={isEditMode}
                onSelect={() => controller.selectField(source.id, field.id)}
              />,
            ];
          })}

          {/* Expression fields */}
          {sourceExprFields.map((ef) => (
            <ExpressionFieldRow
              key={ef.id}
              field={ef}
              isEditMode={isEditMode}
              onEdit={() => handleEditExpressionField(ef)}
              onDelete={() => handleDeleteExpressionField(ef.id)}
              enrichedRows={enrichedRows}
              measureValue={
                ef.isMeasure && source.rows && source.rows.length > 0
                  ? evaluateMeasure(ef, source.rows, expressionFields)
                  : undefined
              }
            />
          ))}

          {/* Add calculated field button (edit mode only) */}
          {isEditMode && (
            <ListItemButton
              onClick={handleAddExpressionField}
              sx={{ borderRadius: 1, py: 0.25, px: 0.75, color: 'primary.main' }}
            >
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <AddIcon sx={{ fontSize: 15 }} />
                <Typography variant="body2" color="primary">
                  Add calculated field
                </Typography>
              </Stack>
            </ListItemButton>
          )}
        </List>
      </Collapse>

      <StudioExpressionFieldDialog
        key={dialogOpen ? (editingField?.id ?? 'new') : 'closed'}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        dataSource={source}
        expressionFields={expressionFields}
        existingField={editingField}
      />
    </div>
  );
}
