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
import { useStudioController, useStudioLocaleText } from '../../context';
import type { StudioDataSource, StudioRelationship } from '../../models';

// ─── Relationship editor ──────────────────────────────────────────────────────

function generateRelId() {
  return `rel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface RelationshipFormState {
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

export function RelationshipDialog(props: {
  open: boolean;
  onClose: () => void;
  onSave: (form: RelationshipFormState) => void;
  initial?: RelationshipFormState;
  dataSources: Record<string, StudioDataSource>;
}) {
  const { open, onClose, onSave, initial, dataSources } = props;
  const localeText = useStudioLocaleText();
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
      <DialogTitle>
        {initial ? localeText.relationshipEditTitle : localeText.relationshipAddTitle}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>{localeText.relationshipTypeLabel}</InputLabel>
            <Select
              label={localeText.relationshipTypeLabel}
              value={form.type}
              onChange={(event) => field('type')(event.target.value)}
            >
              <MenuItem value="many-to-one">{localeText.relationshipTypeManyToOne}</MenuItem>
              <MenuItem value="one-to-one">{localeText.relationshipTypeOneToOne}</MenuItem>
              <MenuItem value="many-to-many">{localeText.relationshipTypeManyToMany}</MenuItem>
            </Select>
          </FormControl>

          <Divider />

          <Stack direction="row" spacing={1}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>
                {isManyToMany
                  ? localeText.relationshipSourceLabel
                  : localeText.relationshipSourceManyLabel}
              </InputLabel>
              <Select
                label={
                  isManyToMany
                    ? localeText.relationshipSourceLabel
                    : localeText.relationshipSourceManyLabel
                }
                value={form.sourceId}
                onChange={(event) => {
                  field('sourceId')(event.target.value);
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
              <InputLabel>{localeText.relationshipJoinFieldLabel}</InputLabel>
              <Select
                label={localeText.relationshipJoinFieldLabel}
                value={form.sourceField}
                onChange={(event) => field('sourceField')(event.target.value)}
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
              <InputLabel>
                {isManyToMany
                  ? localeText.relationshipTargetLabel
                  : localeText.relationshipTargetOneLabel}
              </InputLabel>
              <Select
                label={
                  isManyToMany
                    ? localeText.relationshipTargetLabel
                    : localeText.relationshipTargetOneLabel
                }
                value={form.targetId}
                onChange={(event) => {
                  field('targetId')(event.target.value);
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
              <InputLabel>{localeText.relationshipJoinFieldLabel}</InputLabel>
              <Select
                label={localeText.relationshipJoinFieldLabel}
                value={form.targetField}
                onChange={(event) => field('targetField')(event.target.value)}
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
                {localeText.relationshipJunctionTableLabel}
              </Typography>
              <FormControl size="small" fullWidth>
                <InputLabel>{localeText.relationshipJunctionSourceLabel}</InputLabel>
                <Select
                  label={localeText.relationshipJunctionSourceLabel}
                  value={form.junctionSourceId}
                  onChange={(event) => {
                    field('junctionSourceId')(event.target.value);
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
                  <InputLabel>{localeText.relationshipJunctionSourceFkLabel}</InputLabel>
                  <Select
                    label={localeText.relationshipJunctionSourceFkLabel}
                    value={form.junctionSourceField}
                    onChange={(event) => field('junctionSourceField')(event.target.value)}
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
                  <InputLabel>{localeText.relationshipJunctionTargetFkLabel}</InputLabel>
                  <Select
                    label={localeText.relationshipJunctionTargetFkLabel}
                    value={form.junctionTargetField}
                    onChange={(event) => field('junctionTargetField')(event.target.value)}
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
        <Button onClick={onClose}>{localeText.relationshipCancel}</Button>
        <Button variant="contained" disabled={!isValid} onClick={() => onSave(form)}>
          {initial ? localeText.relationshipUpdate : localeText.relationshipAdd}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
