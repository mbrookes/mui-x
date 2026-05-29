'use client';
import * as React from 'react';
import { Alert, Divider, Stack, Typography } from '@mui/material';
import {
  useStudioSelector,
  selectDataSources,
  selectExpressionFields,
  selectRelationships,
  selectMode,
} from '../context';
import { DataSourceSection } from './DataSourceSection';
import { RelationshipPanel } from './RelationshipPanel';
import { DataLineageGraph } from './DataLineageGraph';
import { CollapsibleSection } from '../internals/CollapsibleSection';

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
      {sourceList.length >= 2 && (
        <React.Fragment>
          <Divider />
          <CollapsibleSection title="Data lineage" defaultExpanded={false}>
            <Stack spacing={0.5} sx={{ pt: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Click an edge to inspect the join key fields.
              </Typography>
              <DataLineageGraph sources={dataSources} relationships={relationships} />
            </Stack>
          </CollapsibleSection>
        </React.Fragment>
      )}
    </Stack>
  );
}
