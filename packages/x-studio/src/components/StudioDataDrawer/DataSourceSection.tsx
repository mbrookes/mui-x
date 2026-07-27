'use client';
import * as React from 'react';
import {
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItemButton,
  Stack,
  Typography,
} from '@mui/material';
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
import {
  getDataSourceRowState,
  isAwaitingDataSourceRows,
} from '../../internals/dataSourceRowState';
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

  // H7: `StudioController.removeExpressionField`'s JSDoc documents that the reference count is
  // "exposed so the UI layer (`DataSourceSection`) can surface a 'used by N places — delete
  // anyway?' confirmation" — but the count was read and discarded here, and the row deleted on a
  // single click. In production the controller doesn't even emit its dev `console.warn`, so
  // deleting a field used by a chart's yField silently blanked that chart with no way to relate
  // cause to effect. Ask first whenever the field is still referenced; an unreferenced field
  // still deletes in one click, because there is nothing to warn about.
  const [pendingDelete, setPendingDelete] = React.useState<{
    field: StudioExpressionField;
    referenceCount: number;
  } | null>(null);

  const handleDeleteExpressionField = (field: StudioExpressionField) => {
    const referenceCount = controller.getExpressionFieldReferenceCount(field.id);
    if (referenceCount > 0) {
      setPendingDelete({ field, referenceCount });
      return;
    }
    controller.removeExpressionField(field.id);
  };

  const handleConfirmDelete = () => {
    if (pendingDelete) {
      controller.removeExpressionField(pendingDelete.field.id);
    }
    setPendingDelete(null);
  };

  const visibleFieldCount = source.fields.filter((f) => !f.hidden).length + sourceExprFields.length;
  // H1: `source.rows` is `undefined` — not `[]` — for an adapter-backed source until the host
  // imperatively calls `setDataSourceRows`; the adapter path resolves rows per-widget into
  // `studioRequestCache` and never writes them back here. `?? 0` therefore reported a confident
  // "0 rows" for a source that had simply never been counted. Print the count only when the rows
  // were actually delivered.
  const rowState = getDataSourceRowState(source);
  const awaitingRows = isAwaitingDataSourceRows(source);
  let rowCountText: string;
  if (rowState !== 'unavailable') {
    rowCountText = `${source.rows!.length} ${localeText.dataDrawerRowsLabel}`;
  } else if (awaitingRows) {
    // An adapter is on its way with the real count.
    rowCountText = localeText.widgetLoadingLabel;
  } else {
    // No rows, no adapter to deliver any — the count is simply unknown from here.
    rowCountText = localeText.dataDrawerRowsUnknown;
  }
  const sectionSecondaryText = `${visibleFieldCount} ${localeText.dataDrawerFieldsLabel} · ${rowCountText}`;

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
                awaitingRows={awaitingRows}
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
                onDelete={() => handleDeleteExpressionField(ef)}
                enrichedRows={enrichedRows}
                measureValue={measureValue}
                awaitingRows={awaitingRows}
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

      {/* H7: the "used by N places — delete anyway?" confirmation the controller documents. */}
      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        aria-labelledby="studio-delete-expression-field-title"
        aria-describedby="studio-delete-expression-field-desc"
      >
        <DialogTitle id="studio-delete-expression-field-title">
          {localeText.dataDrawerDeleteFieldConfirmTitle}
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="studio-delete-expression-field-desc">
            {pendingDelete
              ? localeText.dataDrawerDeleteFieldConfirmMessage(
                  pendingDelete.field.label,
                  pendingDelete.referenceCount,
                )
              : null}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)} autoFocus>
            {localeText.exprCancel}
          </Button>
          <Button onClick={handleConfirmDelete} color="error">
            {localeText.dataDrawerDeleteTooltip}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
