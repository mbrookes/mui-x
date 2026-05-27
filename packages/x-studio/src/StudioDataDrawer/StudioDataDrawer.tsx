'use client';
import * as React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
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
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- display-only list of enum values, ordering is stable
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
            if (field.hidden) {
              return [];
            }
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

// ─── Relationship editor ──────────────────────────────────────────────────────

const RELATIONSHIP_TYPE_LABELS: Record<string, string> = {
  'many-to-one': 'Many-to-one',
  'one-to-one': 'One-to-one',
  'many-to-many': 'Many-to-many',
};

function generateRelId() {
  return `rel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface RelationshipFormState {
  sourceId: string;
  sourceField: string;
  targetId: string;
  targetField: string;
  type: 'many-to-one' | 'one-to-one' | 'many-to-many';
  junctionSourceId: string;
  junctionSourceField: string;
  junctionTargetField: string;
}

function emptyRelForm(): RelationshipFormState {
  return {
    sourceId: '',
    sourceField: '',
    targetId: '',
    targetField: '',
    type: 'many-to-one',
    junctionSourceId: '',
    junctionSourceField: '',
    junctionTargetField: '',
  };
}

function RelationshipDialog(props: {
  open: boolean;
  onClose: () => void;
  onSave: (form: RelationshipFormState) => void;
  initial?: RelationshipFormState;
  dataSources: Record<string, StudioDataSource>;
}) {
  const { open, onClose, onSave, initial, dataSources } = props;
  const [form, setForm] = React.useState<RelationshipFormState>(initial ?? emptyRelForm());

  React.useEffect(() => {
    setForm(initial ?? emptyRelForm());
  }, [initial, open]);

  const sourceList = Object.values(dataSources).filter((s) => !s.hidden);
  const sourceFields = dataSources[form.sourceId]?.fields ?? [];
  const targetFields = dataSources[form.targetId]?.fields ?? [];
  const junctionFields = dataSources[form.junctionSourceId]?.fields ?? [];
  const isManyToMany = form.type === 'many-to-many';
  const isValid =
    form.sourceId &&
    form.sourceField &&
    form.targetId &&
    form.targetField &&
    form.sourceId !== form.targetId &&
    (!isManyToMany ||
      (form.junctionSourceId &&
        form.junctionSourceField &&
        form.junctionTargetField));

  const field = (key: keyof RelationshipFormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{initial ? 'Edit relationship' : 'Add relationship'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Type</InputLabel>
            <Select
              label="Type"
              value={form.type}
              onChange={(e) => field('type')(e.target.value)}
            >
              <MenuItem value="many-to-one">Many-to-one</MenuItem>
              <MenuItem value="one-to-one">One-to-one</MenuItem>
              <MenuItem value="many-to-many">Many-to-many</MenuItem>
            </Select>
          </FormControl>

          <Divider />

          <Stack direction="row" spacing={1}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>{isManyToMany ? 'Source' : 'Many side'}</InputLabel>
              <Select
                label={isManyToMany ? 'Source' : 'Many side'}
                value={form.sourceId}
                onChange={(e) => { field('sourceId')(e.target.value); field('sourceField')(''); }}
              >
                {sourceList.map((s) => (
                  <MenuItem key={s.id} value={s.id}>{s.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>Join field</InputLabel>
              <Select
                label="Join field"
                value={form.sourceField}
                onChange={(e) => field('sourceField')(e.target.value)}
                disabled={!form.sourceId}
              >
                {sourceFields.map((f) => (
                  <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <Stack direction="row" spacing={1}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>{isManyToMany ? 'Target' : 'One side'}</InputLabel>
              <Select
                label={isManyToMany ? 'Target' : 'One side'}
                value={form.targetId}
                onChange={(e) => { field('targetId')(e.target.value); field('targetField')(''); }}
              >
                {sourceList.filter((s) => s.id !== form.sourceId).map((s) => (
                  <MenuItem key={s.id} value={s.id}>{s.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>Join field</InputLabel>
              <Select
                label="Join field"
                value={form.targetField}
                onChange={(e) => field('targetField')(e.target.value)}
                disabled={!form.targetId}
              >
                {targetFields.map((f) => (
                  <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          {isManyToMany && (
            <React.Fragment>
              <Divider />
              <Typography variant="caption" color="text.secondary">
                Junction (bridge) table
              </Typography>
              <FormControl size="small" fullWidth>
                <InputLabel>Junction source</InputLabel>
                <Select
                  label="Junction source"
                  value={form.junctionSourceId}
                  onChange={(e) => {
                    field('junctionSourceId')(e.target.value);
                    field('junctionSourceField')('');
                    field('junctionTargetField')('');
                  }}
                >
                  {sourceList
                    .filter((s) => s.id !== form.sourceId && s.id !== form.targetId)
                    .map((s) => (
                      <MenuItem key={s.id} value={s.id}>{s.label}</MenuItem>
                    ))}
                </Select>
              </FormControl>
              <Stack direction="row" spacing={1}>
                <FormControl size="small" sx={{ flex: 1 }}>
                  <InputLabel>→ Source FK</InputLabel>
                  <Select
                    label="→ Source FK"
                    value={form.junctionSourceField}
                    onChange={(e) => field('junctionSourceField')(e.target.value)}
                    disabled={!form.junctionSourceId}
                  >
                    {junctionFields.map((f) => (
                      <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ flex: 1 }}>
                  <InputLabel>→ Target FK</InputLabel>
                  <Select
                    label="→ Target FK"
                    value={form.junctionTargetField}
                    onChange={(e) => field('junctionTargetField')(e.target.value)}
                    disabled={!form.junctionSourceId}
                  >
                    {junctionFields.map((f) => (
                      <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            </React.Fragment>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!isValid} onClick={() => onSave(form)}>
          {initial ? 'Update' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RelationshipPanel(props: {
  relationships: StudioRelationship[];
  dataSources: Record<string, StudioDataSource>;
}) {
  const { relationships, dataSources } = props;
  const controller = useStudioController();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingRel, setEditingRel] = React.useState<{ id: string; form: RelationshipFormState } | undefined>(undefined);

  const handleAdd = (form: RelationshipFormState) => {
    const isManyToMany = form.type === 'many-to-many';
    controller.addRelationship({
      id: generateRelId(),
      sourceId: form.sourceId,
      sourceField: form.sourceField,
      targetId: form.targetId,
      targetField: form.targetField,
      type: form.type,
      ...(isManyToMany
        ? {
            junctionSourceId: form.junctionSourceId,
            junctionSourceField: form.junctionSourceField,
            junctionTargetField: form.junctionTargetField,
          }
        : {}),
    });
    setDialogOpen(false);
  };

  const handleUpdate = (form: RelationshipFormState) => {
    if (!editingRel) {
      return;
    }
    const isManyToMany = form.type === 'many-to-many';
    controller.updateRelationship(editingRel.id, {
      sourceId: form.sourceId,
      sourceField: form.sourceField,
      targetId: form.targetId,
      targetField: form.targetField,
      type: form.type,
      junctionSourceId: isManyToMany ? form.junctionSourceId : undefined,
      junctionSourceField: isManyToMany ? form.junctionSourceField : undefined,
      junctionTargetField: isManyToMany ? form.junctionTargetField : undefined,
    });
    setEditingRel(undefined);
    setDialogOpen(false);
  };

  const handleEdit = (rel: StudioRelationship) => {
    setEditingRel({
      id: rel.id,
      form: {
        sourceId: rel.sourceId,
        sourceField: rel.sourceField,
        targetId: rel.targetId,
        targetField: rel.targetField,
        type: rel.type,
        junctionSourceId: rel.junctionSourceId ?? '',
        junctionSourceField: rel.junctionSourceField ?? '',
        junctionTargetField: rel.junctionTargetField ?? '',
      },
    });
    setDialogOpen(true);
  };

  return (
    <Box sx={{ px: 1.5, pb: 1.5 }}>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, fontWeight: 600 }}>
          Relationships
        </Typography>
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          onClick={() => { setEditingRel(undefined); setDialogOpen(true); }}
          sx={{ fontSize: 11 }}
        >
          Add
        </Button>
      </Stack>

      {relationships.length === 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
          No relationships configured.
        </Typography>
      )}

      <Stack spacing={0.5}>
        {relationships.map((rel) => {
          const srcLabel = dataSources[rel.sourceId]?.label ?? rel.sourceId;
          const tgtLabel = dataSources[rel.targetId]?.label ?? rel.targetId;
          const jctLabel = rel.junctionSourceId
            ? (dataSources[rel.junctionSourceId]?.label ?? rel.junctionSourceId)
            : null;
          const typeLabel = RELATIONSHIP_TYPE_LABELS[rel.type] ?? rel.type;
          return (
            <Stack
              key={rel.id}
              direction="row"
              spacing={0.5}
              sx={{ alignItems: 'center', py: 0.25 }}
            >
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="caption" noWrap>
                  {srcLabel} → {tgtLabel}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.25 }}>
                  <Chip label={typeLabel} size="small" variant="outlined" sx={{ fontSize: 10, height: 16 }} />
                  {jctLabel && (
                    <Chip label={`via ${jctLabel}`} size="small" variant="outlined" sx={{ fontSize: 10, height: 16 }} />
                  )}
                </Stack>
              </Box>
              <Tooltip title="Edit">
                <IconButton size="small" onClick={() => handleEdit(rel)}>
                  <EditIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Remove">
                <IconButton size="small" onClick={() => controller.removeRelationship(rel.id)}>
                  <DeleteIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Stack>
          );
        })}
      </Stack>

      <RelationshipDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingRel(undefined); }}
        onSave={editingRel ? handleUpdate : handleAdd}
        initial={editingRel?.form}
        dataSources={dataSources}
      />
    </Box>
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
      {mode === 'edit' && sourceList.length >= 2 && (
        <React.Fragment>
          <Divider />
          <RelationshipPanel relationships={relationships} dataSources={dataSources} />
        </React.Fragment>
      )}
    </Stack>
  );
}
