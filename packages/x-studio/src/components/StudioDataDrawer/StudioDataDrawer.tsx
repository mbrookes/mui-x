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
import {
  useStudioSelector,
  selectDataSources,
  selectExpressionFields,
  selectRelationships,
  selectMode,
  useStudioLocaleText,
} from '../../context';
import type { StudioDataSource } from '../../models';
import { lookup } from '../../utils/safeLookup';
import {
  getDataSourceRowState,
  isAwaitingDataSourceRows,
} from '../../internals/dataSourceRowState';
import { DataSourceSection } from './DataSourceSection';
import { RelationshipPanel } from './RelationshipPanel';
import { DataLineageGraph } from './DataLineageGraph';
import { DataSourcePreview } from './DataSourcePreview';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { StudioDrawerErrorBoundary } from '../../internals/StudioDrawerErrorBoundary';

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

  // `lineageSourceId`/`previewSourceId` originate from ids in the doc-authored `dataSources`
  // record, so index it through the prototype-chain-safe `lookup` (the `utils/safeLookup`
  // convention) rather than a bare bracket read: a key named after an `Object.prototype` member
  // resolves an inherited function that `?? null` cannot catch, and `.fields.filter` below would
  // then throw inside a dialog title.
  const selectedSource = lookup(dataSources, lineageSourceId) ?? null;
  const previewSource = lookup(dataSources, previewSourceId) ?? null;

  /**
   * Row/field counts for a source-preview dialog title.
   *
   * H1: `rows?.length ?? 0` claimed "0 rows" for any adapter-backed source, whose `rows` stays
   * `undefined` until the host imperatively calls `setDataSourceRows` — the adapter path resolves
   * rows per-widget into `studioRequestCache` and never writes them back here. A row count that
   * was never taken is reported as unavailable (or as loading while an adapter is expected to
   * deliver it), never as a number.
   *
   * @param source The data source being previewed.
   * @returns The localized "N rows · M fields" caption for that source.
   */
  const describeSourceCounts = (source: StudioDataSource): string => {
    const fieldCount =
      source.fields.filter((f) => !f.hidden).length +
      expressionFields.filter((ef) => ef.sourceId === source.id && !ef.hidden && !ef.isMeasure)
        .length;
    let rowsText: string;
    if (getDataSourceRowState(source) !== 'unavailable') {
      rowsText = `${source.rows!.length} ${localeText.dataDrawerRowsLabel}`;
    } else if (isAwaitingDataSourceRows(source)) {
      rowsText = localeText.widgetLoadingLabel;
    } else {
      rowsText = localeText.dataDrawerRowsUnknown;
    }
    return `${rowsText} · ${fieldCount} ${localeText.dataDrawerFieldsLabel}`;
  };

  const selectedSourceCounts = selectedSource ? describeSourceCounts(selectedSource) : null;
  const previewSourceCounts = previewSource ? describeSourceCounts(previewSource) : null;

  // Defense-in-depth (this drawer had no error boundary at all, unlike
  // `StudioComposeDrawer`/`StudioFiltersDrawer`, which self-wrap their own content in
  // `StudioDrawerErrorBoundary`): a render throw from any section below (the data-source
  // list, relationship panel, or lineage graph — e.g. reached through a hostile/malformed
  // doc-authored source or relationship) previously had no boundary to stop at and
  // unmounted the entire `<Studio>` tree. `resetKey` tracks the current set of source ids,
  // so removing/editing the data source that caused the crash clears the fallback instead
  // of latching it.
  const resetKey = sourceList.map((source) => source.id).join('|');

  return (
    <StudioDrawerErrorBoundary resetKey={resetKey}>
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
                      {selectedSourceCounts}
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
                {previewSourceCounts}
              </Typography>
              <IconButton
                aria-label={localeText.dataDrawerCloseAriaLabel}
                onClick={handlePreviewClose}
                sx={{ position: 'absolute', right: 8, top: 8 }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </DialogTitle>
            <DialogContent
              dividers
              sx={{
                display: 'flex',
                alignItems: 'stretch',
                justifyContent: 'stretch',
                overflow: 'auto',
                p: 0,
              }}
            >
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
    </StudioDrawerErrorBoundary>
  );
}
