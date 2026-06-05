'use client';
import * as React from 'react';
import {
  Box,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useStudioController, useStudioSelector, selectShell, useStudioLocaleText } from '../context';
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
    if (v === null || v === undefined) {
      return '—';
    }
    return String(v);
  });

  const title = (
    <Stack spacing={0.25}>
      <Typography variant="caption" sx={{ fontWeight: 600, opacity: 0.8 }}>
        {field.label}
      </Typography>
      {values.map((v, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- display-only list of enum values, ordering is stable
        <Typography
          key={`val-${i}`}
          variant="caption"
          sx={{ fontFamily: 'monospace', opacity: 0.9 }}
        >
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
  onOpenPreview,
  children,
}: {
  source: StudioDataSource;
  onOpenPreview?: (sourceId: string) => void;
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
            // react-doctor-disable-next-line react-doctor/no-array-index-key -- preview table rows have no stable IDs
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
      {(rows.length > DS_PREVIEW_ROWS || source.fields.filter((f) => !f.hidden).length > DS_PREVIEW_COLS) && (
        <Typography variant="caption" sx={{ opacity: 0.5 }}>
          {[
            rows.length > DS_PREVIEW_ROWS ? `${rows.length - DS_PREVIEW_ROWS} more rows` : null,
            source.fields.filter((f) => !f.hidden).length > DS_PREVIEW_COLS
              ? `${source.fields.filter((f) => !f.hidden).length - DS_PREVIEW_COLS} more columns`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      )}
      {onOpenPreview && (
        <Typography
          component="span"
          variant="caption"
          onClick={() => onOpenPreview(source.id)}
          sx={{ opacity: 0.8, cursor: 'pointer', '&:hover': { opacity: 1 } }}
        >
          View source data →
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

// ─── Physical field row ───────────────────────────────────────────────────────

interface PhysicalFieldRowProps {
  field: StudioDataSource['fields'][number];
  rows: StudioDataSource['rows'];
  isSelected: boolean;
  isEditMode: boolean;
  onSelect: () => void;
}

function PhysicalFieldRow({
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

// ─── Data source section ──────────────────────────────────────────────────────

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
