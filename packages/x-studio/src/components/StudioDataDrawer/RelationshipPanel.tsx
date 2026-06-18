'use client';
import * as React from 'react';
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { useStudioController, useStudioLocaleText } from '../../context';
import type { StudioDataSource, StudioRelationship } from '../../models';
import { RelationshipDialog, type RelationshipFormState } from './RelationshipDialog';

function generateRelId() {
  return `rel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

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
          const srcLabel = dataSources[rel.sourceId]?.label ?? rel.sourceId;
          const tgtLabel = dataSources[rel.targetId]?.label ?? rel.targetId;
          const jctLabel = rel.junctionSourceId
            ? (dataSources[rel.junctionSourceId]?.label ?? rel.junctionSourceId)
            : null;
          const typeLabel = relationshipTypeLabels[rel.type] ?? rel.type;
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
