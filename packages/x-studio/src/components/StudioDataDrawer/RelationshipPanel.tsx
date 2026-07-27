'use client';
import * as React from 'react';
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { createIdFactory } from '@mui/x-studio-schema';
import { useStudioController, useStudioLocaleText } from '../../context';
import type { StudioDataSource, StudioRelationship } from '../../models';
import { RelationshipDialog, type RelationshipFormState } from './RelationshipDialog';

// Collision-resistant (timestamp + monotonic counter + random suffix) instead of the
// previous ad-hoc `Date.now() + Math.random()` — see `createIdFactory` in `@mui/x-studio-schema`.
const generateRelId = createIdFactory('rel');

export function RelationshipPanel(props: {
  relationships: StudioRelationship[];
  dataSources: Record<string, StudioDataSource>;
}) {
  const { relationships, dataSources } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const relationshipTypeLabels = {
    'many-to-one': localeText.relationshipTypeManyToOne,
    'one-to-one': localeText.relationshipTypeOneToOne,
    'many-to-many': localeText.relationshipTypeManyToMany,
  };
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingRel, setEditingRel] = React.useState<
    { id: string; form: RelationshipFormState } | undefined
  >(undefined);
  // H8: `addRelationship`/`updateRelationship` now RETURN a `StudioMutationResult`, so this
  // panel branches on the controller's verdict — `duplicate-id` on an add, `not-found` when
  // the relationship was removed from another view / by the AI assistant while this dialog was
  // open — instead of re-reading the committed doc and inferring. A value-equal no-op comes
  // back as `ok`, so a deliberate re-save still closes the dialog.
  const [saveRejected, setSaveRejected] = React.useState(false);

  const handleAdd = (form: RelationshipFormState) => {
    const isManyToMany = form.type === 'many-to-many';
    const id = generateRelId();
    const patch = {
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
    };
    if (!controller.addRelationship({ id, ...patch }).ok) {
      setSaveRejected(true);
      return;
    }
    setSaveRejected(false);
    setDialogOpen(false);
  };

  const handleUpdate = (form: RelationshipFormState) => {
    if (!editingRel) {
      return;
    }
    const isManyToMany = form.type === 'many-to-many';
    const patch = {
      sourceId: form.sourceId,
      sourceField: form.sourceField,
      targetId: form.targetId,
      targetField: form.targetField,
      type: form.type,
      junctionSourceId: isManyToMany ? form.junctionSourceId : undefined,
      junctionSourceField: isManyToMany ? form.junctionSourceField : undefined,
      junctionTargetField: isManyToMany ? form.junctionTargetField : undefined,
    };
    if (!controller.updateRelationship(editingRel.id, patch).ok) {
      setSaveRejected(true);
      return;
    }
    setSaveRejected(false);
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
          {localeText.relationshipSectionTitle}
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
          {localeText.relationshipAddButton}
        </Button>
      </Stack>

      {relationships.length === 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
          {localeText.relationshipNone}
        </Typography>
      )}

      <Stack spacing={0.5}>
        {relationships.map((rel) => {
          // `rel.sourceId`/`rel.targetId`/`rel.junctionSourceId`/`rel.type` are doc-authored
          // (host/AI-writable): guard every record index against inherited `Object.prototype`
          // keys ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function
          // off the prototype (truthy, survives `??`) instead of `undefined` — which would
          // otherwise crash `<Chip label>` rendering (prototype-chain key lookup fix).
          const srcLabel =
            (Object.hasOwn(dataSources, rel.sourceId) ? dataSources[rel.sourceId] : undefined)
              ?.label ?? rel.sourceId;
          const tgtLabel =
            (Object.hasOwn(dataSources, rel.targetId) ? dataSources[rel.targetId] : undefined)
              ?.label ?? rel.targetId;
          const jctLabel = rel.junctionSourceId
            ? ((Object.hasOwn(dataSources, rel.junctionSourceId)
                ? dataSources[rel.junctionSourceId]
                : undefined
              )?.label ?? rel.junctionSourceId)
            : null;
          const typeLabel = Object.hasOwn(relationshipTypeLabels, rel.type)
            ? relationshipTypeLabels[rel.type]
            : rel.type;
          return (
            <Stack
              key={rel.id}
              direction="row"
              spacing={0.5}
              sx={{ alignItems: 'flex-end', py: 0.25 }}
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
                      label={localeText.relationshipVia(jctLabel)}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: 10, height: 16 }}
                    />
                  )}
                </Stack>
              </Box>
              {!rel.predefined && (
                <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0, alignItems: 'center' }}>
                  <Tooltip title={localeText.relationshipEditTooltip}>
                    <IconButton
                      size="small"
                      sx={{ flexShrink: 0, p: 0.5 }}
                      onClick={() => handleEdit(rel)}
                    >
                      <EditIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={localeText.relationshipRemoveTooltip}>
                    <IconButton
                      size="small"
                      sx={{ flexShrink: 0, p: 0.5 }}
                      onClick={() => controller.removeRelationship(rel.id)}
                    >
                      <DeleteIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              )}
            </Stack>
          );
        })}
      </Stack>

      <RelationshipDialog
        open={dialogOpen}
        error={saveRejected ? localeText.saveRejectedMessage : null}
        onClose={() => {
          setDialogOpen(false);
          setEditingRel(undefined);
          setSaveRejected(false);
        }}
        onSave={editingRel ? handleUpdate : handleAdd}
        initial={editingRel?.form}
        dataSources={dataSources}
      />
    </Box>
  );
}
