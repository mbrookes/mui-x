'use client';
import * as React from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { useStudioController } from '../context';
import type { StudioDataSource, StudioRelationship } from '../models';

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

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change, react-doctor/no-derived-state-effect -- form is intentionally buffered locally and synced when dialog re-opens or initial value changes
  React.useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- locally buffered form; sync on external change is intentional
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
      (form.junctionSourceId && form.junctionSourceField && form.junctionTargetField));

  const field = (key: keyof RelationshipFormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{initial ? 'Edit relationship' : 'Add relationship'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Type</InputLabel>
            <Select label="Type" value={form.type} onChange={(e) => field('type')(e.target.value)}>
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
                onChange={(e) => {
                  field('sourceId')(e.target.value);
                  field('sourceField')('');
                }}
              >
                {sourceList.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.label}
                  </MenuItem>
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
                  <MenuItem key={f.id} value={f.id}>
                    {f.label}
                  </MenuItem>
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
                onChange={(e) => {
                  field('targetId')(e.target.value);
                  field('targetField')('');
                }}
              >
                {sourceList.flatMap((s) =>
                  s.id !== form.sourceId
                    ? [
                        <MenuItem key={s.id} value={s.id}>
                          {s.label}
                        </MenuItem>,
                      ]
                    : [],
                )}
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
                  <MenuItem key={f.id} value={f.id}>
                    {f.label}
                  </MenuItem>
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
                  {sourceList.flatMap((s) =>
                    s.id !== form.sourceId && s.id !== form.targetId
                      ? [
                          <MenuItem key={s.id} value={s.id}>
                            {s.label}
                          </MenuItem>,
                        ]
                      : [],
                  )}
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
                      <MenuItem key={f.id} value={f.id}>
                        {f.label}
                      </MenuItem>
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
                      <MenuItem key={f.id} value={f.id}>
                        {f.label}
                      </MenuItem>
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

export function RelationshipPanel(props: {
  relationships: StudioRelationship[];
  dataSources: Record<string, StudioDataSource>;
}) {
  const { relationships, dataSources } = props;
  const controller = useStudioController();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingRel, setEditingRel] = React.useState<
    { id: string; form: RelationshipFormState } | undefined
  >(undefined);

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
          onClick={() => {
            setEditingRel(undefined);
            setDialogOpen(true);
          }}
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
                  <Chip
                    label={typeLabel}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: 10, height: 16 }}
                  />
                  {jctLabel && (
                    <Chip
                      label={`via ${jctLabel}`}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: 10, height: 16 }}
                    />
                  )}
                </Stack>
              </Box>
              <Tooltip title="Edit">
                <IconButton size="small" sx={{ flexShrink: 0 }} onClick={() => handleEdit(rel)}>
                  <EditIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Remove">
                <IconButton
                  size="small"
                  sx={{ flexShrink: 0 }}
                  onClick={() => controller.removeRelationship(rel.id)}
                >
                  <DeleteIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Stack>
          );
        })}
      </Stack>

      <RelationshipDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditingRel(undefined);
        }}
        onSave={editingRel ? handleUpdate : handleAdd}
        initial={editingRel?.form}
        dataSources={dataSources}
      />
    </Box>
  );
}
