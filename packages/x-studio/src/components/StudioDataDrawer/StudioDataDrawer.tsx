'use client';
import * as React from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import type { SxProps, Theme } from '@mui/material/styles';
import { useStudioSelector, selectDataSources, selectExpressionFields, selectRelationships, selectMode, useStudioLocaleText } from '../../context';
import { DataSourceSection } from './DataSourceSection';
import { RelationshipPanel } from './RelationshipPanel';
import { DataLineageGraph } from './DataLineageGraph';
import { DataSourcePreview } from './DataSourcePreview';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';

// ─── Drawer ───────────────────────────────────────────────────────────────────

export interface StudioDataDrawerProps {
  /**
   * System prop that allows defining system overrides and additional CSS styles applied to the
   * root element. Accepts valid CSS properties and MUI system values.
   */
  sx?: SxProps<Theme>;
}

export function StudioDataDrawer({ sx }: StudioDataDrawerProps = {}) {
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const relationships = useStudioSelector(selectRelationships);
  const mode = useStudioSelector(selectMode);
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const sourceList = Object.values(dataSources).filter((s) => !s.hidden);

  const [lineageOpen, setLineageOpen] = React.useState(false);
  // BL-103: track which source node is selected in the lineage graph
  const [lineageSourceId, setLineageSourceId] = React.useState<string | null>(null);
  const [previewSourceId, setPreviewSourceId] = React.useState<string | null>(null);

  function handleLineageClose() {
    setLineageOpen(false);
    setLineageSourceId(null);
  }

  function handlePreviewClose() {
    setPreviewSourceId(null);
  }

  if (sourceList.length === 0) {
    return (
      <Alert severity="info" sx={[{ mt: 1 }, ...(Array.isArray(sx) ? sx : [sx])]}>
        {localeText.dataDrawerNoSources}
      </Alert>
    );
  }

  const selectedSource = lineageSourceId ? dataSources[lineageSourceId] : null;
  const previewSource = previewSourceId ? dataSources[previewSourceId] : null;

  return (
    <Stack spacing={0} sx={sx}>
      {sourceList.map((source) => (
        <DataSourceSection
          key={source.id}
          source={source}
          expressionFields={expressionFields}
          dataSources={dataSources}
          relationships={relationships}
          isEditMode={mode === 'edit'}
          onOpenPreview={setPreviewSourceId}
        />
      ))}
      {mode === 'edit' && sourceList.length >= 2 && features.relationships !== false && (
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
              {localeText.dataDrawerViewLineage}
            </Button>
          </Box>
          <Dialog
            open={lineageOpen}
            onClose={handleLineageClose}
            maxWidth="lg"
            fullWidth
            slotProps={{ paper: { sx: { height: '80vh' } } }}
          >
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
              {selectedSource ? (
                <IconButton
                  size="small"
                  aria-label={localeText.dataDrawerBackAriaLabel}
                  onClick={() => setLineageSourceId(null)}
                  sx={{ mr: 0.5 }}
                >
                  <ArrowBackIcon fontSize="small" />
                </IconButton>
              ) : (
                <AccountTreeIcon fontSize="small" />
              )}
              {selectedSource ? (
                <React.Fragment>
                  <span>{selectedSource.label}</span>
                  <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                    {selectedSource.rows?.length ?? 0} rows ·{' '}
                    {selectedSource.fields.filter((f) => !f.hidden).length +
                      expressionFields.filter(
                        (ef) => ef.sourceId === selectedSource.id && !ef.hidden && !ef.isMeasure,
                      ).length}{' '}
                    fields
                  </Typography>
                </React.Fragment>
              ) : (
                <React.Fragment>
                  {localeText.dataDrawerLineageTitle}
                  <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                    {localeText.dataDrawerLineageHelper}
                  </Typography>
                </React.Fragment>
              )}
              <IconButton
                aria-label={localeText.dataDrawerCloseAriaLabel}
                onClick={handleLineageClose}
                sx={{ position: 'absolute', right: 8, top: 8 }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </DialogTitle>
            <DialogContent
              dividers
              sx={{
                display: 'flex',
                alignItems: selectedSource ? 'stretch' : 'center',
                justifyContent: selectedSource ? 'stretch' : 'center',
                overflow: 'auto',
                p: selectedSource ? 0 : undefined,
              }}
            >
              {selectedSource ? (
                <DataSourcePreview
                  source={selectedSource}
                  expressionFields={expressionFields}
                  dataSources={dataSources}
                  relationships={relationships}
                />
              ) : (
                <DataLineageGraph
                  sources={dataSources}
                  relationships={relationships}
                  onNodeClick={setLineageSourceId}
                />
              )}
            </DialogContent>
          </Dialog>
        </React.Fragment>
      )}
      {previewSource && (
        <Dialog
          open={Boolean(previewSource)}
          onClose={handlePreviewClose}
          maxWidth="lg"
          fullWidth
          slotProps={{ paper: { sx: { height: '80vh' } } }}
        >
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
            <span>{previewSource.label}</span>
            <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
              {previewSource.rows?.length ?? 0} rows ·{' '}
              {previewSource.fields.filter((f) => !f.hidden).length +
                expressionFields.filter(
                  (ef) => ef.sourceId === previewSource.id && !ef.hidden && !ef.isMeasure,
                ).length}{' '}
              fields
            </Typography>
            <IconButton
              aria-label={localeText.dataDrawerCloseAriaLabel}
              onClick={handlePreviewClose}
              sx={{ position: 'absolute', right: 8, top: 8 }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </DialogTitle>
          <DialogContent dividers sx={{ display: 'flex', alignItems: 'stretch', justifyContent: 'stretch', overflow: 'auto', p: 0 }}>
            <DataSourcePreview
              source={previewSource}
              expressionFields={expressionFields}
              dataSources={dataSources}
              relationships={relationships}
            />
          </DialogContent>
        </Dialog>
      )}
    </Stack>
  );
}
