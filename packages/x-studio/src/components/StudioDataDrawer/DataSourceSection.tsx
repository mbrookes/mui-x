'use client';
import * as React from 'react';
import { Box, Collapse, List, ListItemButton, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import {
  useStudioController,
  useStudioSelector,
  selectShell,
  useStudioLocaleText,
} from '../../context';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../../models';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';
import { enrichRowsWithExpressions, evaluateMeasure } from '../../utils/expressionEvaluator';
import { getReachableSourceIds } from '../../internals/dataSourceGraph';
import DataSourcePreviewTooltip from './DataSourcePreviewTooltip';
import PhysicalFieldRow from './PhysicalFieldRow';
import ExpressionFieldRow from './ExpressionFieldRow';

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
  const localeText = useStudioLocaleText();
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

  // Scopes both the dialog's operand picker and its validation to sources that can actually
  // be joined to this one, mirroring the compose-drawer callers. Without it the picker offered
  // expression fields owned by unrelated sources: they pass validation, save, and then
  // evaluate against THIS source's rows — which lack their columns — so every value is
  // null/NaN.
  const reachableSourceIds = React.useMemo(
    () => getReachableSourceIds(source.id, relationships),
    [source.id, relationships],
  );

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
  const sectionSecondaryText = `${visibleFieldCount} ${localeText.dataDrawerFieldsLabel} · ${source.rows?.length ?? 0} ${localeText.dataDrawerRowsLabel}`;

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
          {sourceExprFields.map((ef) => {
            // Tier2 consistency fix: mirrors `ExpressionPreview.tsx`'s try/catch around its
            // equivalent `evaluateMeasure`/`evaluateExpression` call. The evaluator has no
            // throw statements today (and an explicit cycle guard), so this isn't currently
            // exploitable, but without the try/catch a future evaluator change that introduces
            // a throwing path would take down this tooltip preview's render — and everything
            // above it in the tree — instead of just falling back to "no preview".
            let measureValue: unknown;
            if (ef.isMeasure && source.rows && source.rows.length > 0) {
              try {
                measureValue = evaluateMeasure(ef, source.rows, expressionFields);
              } catch {
                measureValue = undefined;
              }
            }
            return (
              <ExpressionFieldRow
                key={ef.id}
                field={ef}
                isEditMode={isEditMode}
                onEdit={() => handleEditExpressionField(ef)}
                onDelete={() => handleDeleteExpressionField(ef.id)}
                enrichedRows={enrichedRows}
                measureValue={measureValue}
              />
            );
          })}

          {/* Add calculated field button (edit mode only) */}
          {isEditMode && (
            <ListItemButton
              onClick={handleAddExpressionField}
              sx={{ borderRadius: 1, py: 0.25, px: 0.75, color: 'primary.main' }}
            >
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <AddIcon sx={{ fontSize: 15 }} />
                <Typography variant="body2" color="primary">
                  {localeText.dataDrawerAddCalculatedField}
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
        reachableSourceIds={reachableSourceIds}
      />
    </div>
  );
}
