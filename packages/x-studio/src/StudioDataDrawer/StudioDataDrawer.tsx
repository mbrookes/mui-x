'use client';
import * as React from 'react';
import {
  Alert,
  Box,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

import {
  useStudioController,
  useStudioSelector,
  selectShell,
  selectDataSources,
  selectExpressionFields,
  selectRelationships,
  selectMode,
} from '../context';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';
import { FieldTypeIcon } from '../internals/FieldTypeIcon';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';
import { enrichRowsWithExpressions, evaluateMeasure } from '../utils/expressionEvaluator';

// ─── Field preview tooltip ────────────────────────────────────────────────────

const PREVIEW_ROWS = 5;

function FieldPreviewTooltip({
  field,
  rows,
  children,
}: {
  field: { id: string; label: string };
  rows?: Record<string, unknown>[];
  children: React.ReactElement;
}) {
  if (!rows || rows.length === 0) {
    return children;
  }

  const values = rows.slice(0, PREVIEW_ROWS).map((row) => {
    const v = row[field.id];
    if (v === null || v === undefined) {return '—';}
    return String(v);
  });

  const title = (
    <Stack spacing={0.25}>
      <Typography variant="caption" sx={{ fontWeight: 600, opacity: 0.8 }}>
        {field.label}
      </Typography>
      {values.map((v, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- display-only list of enum values, ordering is stable
        <Typography key={`val-${i}`} variant="caption" sx={{ fontFamily: 'monospace', opacity: 0.9 }}>
          {v}
        </Typography>
      ))}
      {rows.length > PREVIEW_ROWS && (
        <Typography variant="caption" sx={{ opacity: 0.5 }}>
          +{rows.length - PREVIEW_ROWS} more
        </Typography>
      )}
    </Stack>
  );

  return (
    <Tooltip title={title} placement="right" arrow>
      {children}
    </Tooltip>
  );
}

// ─── Data source preview tooltip ─────────────────────────────────────────────

const DS_PREVIEW_ROWS = 5;
const DS_PREVIEW_COLS = 4;

function DataSourcePreviewTooltip({
  source,
  children,
}: {
  source: StudioDataSource;
  children: React.ReactElement;
}) {
  const rows = source.rows;
  if (!rows || rows.length === 0) {
    return children;
  }

  const visibleFields = source.fields.filter((f) => !f.hidden).slice(0, DS_PREVIEW_COLS);
  const previewRows = rows.slice(0, DS_PREVIEW_ROWS);

  const title = (
    <Stack spacing={0.5}>
      <Typography variant="caption" sx={{ fontWeight: 600, opacity: 0.8 }}>
        {source.label}
      </Typography>
      <Box
        component="table"
        sx={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', display: 'table' }}
      >
        <thead>
          <tr>
            {visibleFields.map((f) => (
              <Box
                key={f.id}
                component="th"
                sx={{
                  px: 0.75,
                  py: 0.25,
                  opacity: 0.6,
                  textAlign: 'left',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  maxWidth: 80,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontSize: 11,
                }}
              >
                {f.label}
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>
          {previewRows.map((row, ri) => (
            <tr key={ri}>
              {visibleFields.map((f) => {
                const v = row[f.id];
                const display = v === null || v === undefined ? '—' : String(v);
                return (
                  <Box
                    key={f.id}
                    component="td"
                    sx={{
                      px: 0.75,
                      py: 0.125,
                      opacity: 0.85,
                      whiteSpace: 'nowrap',
                      maxWidth: 80,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontSize: 11,
                    }}
                  >
                    {display}
                  </Box>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Box>
      {rows.length > DS_PREVIEW_ROWS && (
        <Typography variant="caption" sx={{ opacity: 0.5 }}>
          +{rows.length - DS_PREVIEW_ROWS} more rows
        </Typography>
      )}
      {source.fields.filter((f) => !f.hidden).length > DS_PREVIEW_COLS && (
        <Typography variant="caption" sx={{ opacity: 0.5 }}>
          +{source.fields.filter((f) => !f.hidden).length - DS_PREVIEW_COLS} more columns
        </Typography>
      )}
    </Stack>
  );

  return (
    <Tooltip
      title={title}
      placement="right"
      arrow
      slotProps={{ tooltip: { sx: { maxWidth: 340 } } }}
    >
      {children}
    </Tooltip>
  );
}

// ─── Expression field row ─────────────────────────────────────────────────────

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

function ExpressionFieldRow({
  field,
  isEditMode,
  onEdit,
  onDelete,
  enrichedRows,
  measureValue,
}: ExpressionFieldRowProps) {
  const type = field.type ?? (field.isMeasure ? 'number' : 'string');

  // For measure fields show the aggregate value; for columns use the enriched rows
  let previewRows: Record<string, unknown>[] | undefined;
  if (field.isMeasure) {
    previewRows = measureValue !== undefined ? [{ [field.id]: measureValue }] : undefined;
  } else {
    previewRows = enrichedRows;
  }

  return (
    <FieldPreviewTooltip field={field} rows={previewRows}>
      <ListItemButton
        sx={{ borderRadius: 1, py: 0.25, px: 0.75 }}
        disableRipple={!isEditMode}
        onClick={isEditMode ? onEdit : undefined}
      >
        <ListItemText
          primary={
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <FieldTypeIcon type={type} generated size={15} />
              <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
                {field.label}
              </Typography>
            </Stack>
          }
        />
        {isEditMode && (
          <Stack direction="row" spacing={0}>
            <Tooltip title="Edit">
              <IconButton
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit();
                }}
              >
                <EditIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton
                size="small"
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

// ─── Data source section ──────────────────────────────────────────────────────

function DataSourceSection(props: {
  source: StudioDataSource;
  expressionFields: StudioExpressionField[];
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  isEditMode: boolean;
}) {
  const { source, expressionFields, dataSources, relationships, isEditMode } = props;
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

  return (
    <div>
      <DataSourcePreviewTooltip source={source}>
        <ListItemButton onClick={() => setOpen((prev) => !prev)} sx={{ pl: 2, pr: 1, py: 0.5 }}>
          <ListItemText
            primary={
              <Typography variant="subtitle2" noWrap>
                {source.label}
              </Typography>
            }
            secondary={
              <Typography variant="caption" color="text.secondary">
                {visibleFieldCount} field{visibleFieldCount !== 1 ? 's' : ''} ·{' '}
                {source.rows?.length ?? 0} rows
              </Typography>
            }
          />
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </ListItemButton>
      </DataSourcePreviewTooltip>

      <Collapse in={open}>
        <List dense disablePadding sx={{ pl: 1 }}>
          {/* Physical fields */}
          {source.fields.flatMap((field) => {
            if (field.hidden) {return [];}
            const isSelected = selectedSourceId === source.id && selectedFieldId === field.id;
            return [
              <FieldPreviewTooltip key={field.id} field={field} rows={source.rows}>
                <ListItemButton
                  selected={isSelected}
                  onClick={() => controller.selectField(source.id, field.id)}
                  sx={{ borderRadius: 1, py: 0.25, px: 0.75 }}
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <FieldTypeIcon type={field.type} generated={field.generated} size={15} />
                        <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
                          {field.label}
                        </Typography>
                      </Stack>
                    }
                  />
                </ListItemButton>
              </FieldPreviewTooltip>,
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

// ─── Drawer ───────────────────────────────────────────────────────────────────

export function StudioDataDrawer() {
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const relationships = useStudioSelector(selectRelationships);
  const mode = useStudioSelector(selectMode);
  const sourceList = Object.values(dataSources).filter((s) => !s.hidden);

  if (sourceList.length === 0) {
    return (
      <Alert severity="info" sx={{ mt: 1 }}>
        No data sources configured. Add a widget from the canvas to load sample data.
      </Alert>
    );
  }

  return (
    <Stack spacing={0}>
      {sourceList.map((source) => (
        <DataSourceSection
          key={source.id}
          source={source}
          expressionFields={expressionFields}
          dataSources={dataSources}
          relationships={relationships}
          isEditMode={mode === 'edit'}
        />
      ))}
    </Stack>
  );
}
