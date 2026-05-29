'use client';
import * as React from 'react';
import { Alert, Box, Button, Dialog, DialogContent, DialogTitle, Divider, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
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

// ─── Drawer ───────────────────────────────────────────────────────────────────

export function StudioDataDrawer() {
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const relationships = useStudioSelector(selectRelationships);
  const mode = useStudioSelector(selectMode);
  const sourceList = Object.values(dataSources).filter((s) => !s.hidden);

  const [lineageOpen, setLineageOpen] = React.useState(false);

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
          <Box sx={{ px: 2, py: 1.5 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<AccountTreeIcon fontSize="small" />}
              onClick={() => setLineageOpen(true)}
              fullWidth
            >
              View data lineage
            </Button>
          </Box>
          <Dialog
            open={lineageOpen}
            onClose={() => setLineageOpen(false)}
            maxWidth="lg"
            fullWidth
            slotProps={{ paper: { sx: { height: '80vh' } } }}
          >
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
              <AccountTreeIcon fontSize="small" />
              Data lineage
              <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                Click an edge to inspect join key fields.
              </Typography>
              <IconButton
                aria-label="Close data lineage"
                onClick={() => setLineageOpen(false)}
                sx={{ position: 'absolute', right: 8, top: 8 }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </DialogTitle>
            <DialogContent dividers sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
              <DataLineageGraph sources={dataSources} relationships={relationships} />
            </DialogContent>
          </Dialog>
        </React.Fragment>
      )}
    </Stack>
  );
}
