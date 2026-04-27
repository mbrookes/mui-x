'use client';
import * as React from 'react';
import {
  Box,
  Collapse,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useStudioController } from '../../context';
import type { StudioDataSource, StudioFilterState } from '../../models';
import type { FieldOption, SimpleField } from './filterDrawerTypes';
import { PageFilterRow } from './PageFilterRow';
import { WidgetFilterRow } from './WidgetFilterRow';

// ─── Collapsible section ──────────────────────────────────────────────────────

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  onAdd: () => void;
  addDisabled?: boolean;
}

function CollapsibleSection(props: CollapsibleSectionProps) {
  const { title, children, onAdd, addDisabled } = props;
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div>
      <Box
        sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        <Tooltip title="Add filter">
          <span>
            <IconButton
              size="small"
              disabled={addDisabled}
              onClick={(event) => {
                event.stopPropagation();
                onAdd();
              }}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ pl: 0.5 }}>{children}</Box>
      </Collapse>
    </div>
  );
}

// ─── Page filter section ──────────────────────────────────────────────────────

export interface FilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  fields: SimpleField[];
  fieldOptions: FieldOption[];
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
}

export function FilterSection(props: FilterSectionProps) {
  const { fields, fieldOptions, filters, onAddFilter, onRemoveFilter, title } = props;

  return (
    <CollapsibleSection title={title} onAdd={onAddFilter} addDisabled={fields.length === 0}>
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
          No filters applied.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {filters.map((filter) => (
            <PageFilterRow
              key={filter.id}
              filter={filter}
              fields={fields}
              fieldOptions={fieldOptions}
              onRemove={onRemoveFilter}
            />
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

// ─── Widget filter section ────────────────────────────────────────────────────

export interface WidgetFilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  widgetSourceId?: string;
  fieldOptions: FieldOption[];
  dataSources: Record<string, StudioDataSource>;
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
  chartXField?: string;
  chartYFieldLabel?: string;
}

export function WidgetFilterSection(props: WidgetFilterSectionProps) {
  const {
    filters,
    widgetSourceId,
    fieldOptions,
    dataSources,
    onAddFilter,
    onRemoveFilter,
    title,
    chartXField,
    chartYFieldLabel,
  } = props;
  const hasAnySources = Object.keys(dataSources).length > 0;

  return (
    <CollapsibleSection title={title} onAdd={onAddFilter} addDisabled={!hasAnySources}>
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
          No filters applied.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {filters.map((filter) => (
            <WidgetFilterRow
              key={filter.id}
              filter={filter}
              widgetSourceId={widgetSourceId}
              fieldOptions={fieldOptions}
              onRemove={onRemoveFilter}
              chartXField={chartXField}
              chartYFieldLabel={chartYFieldLabel}
            />
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

// ─── Cross-filter section ─────────────────────────────────────────────────────

export function CrossFilterSection({ filters }: { filters: StudioFilterState[] }) {
  const controller = useStudioController();
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div>
      <Box
        sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Cross-filters
        </Typography>
        {filters.length > 0 && (
          <Tooltip title="Clear all cross-filters">
            <IconButton
              size="small"
              color="inherit"
              onClick={(event) => {
                event.stopPropagation();
                controller.clearAllCrossFilters();
              }}
              aria-label="Clear all cross-filters"
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Collapse in={expanded}>
        <Box sx={{ pl: 0.5 }}>
          {filters.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1, pb: 1 }}>
              No cross-filters active. Click on chart elements or select grid rows to create
              cross-filters.
            </Typography>
          ) : (
            <Stack spacing={1} sx={{ pb: 0.5 }}>
              {filters.map((filter: StudioFilterState) => (
                <Box
                  key={filter.id}
                  sx={{
                    position: 'relative',
                    p: 1,
                    pr: 4,
                    borderRadius: 1,
                    border: 1,
                    borderColor: 'divider',
                  }}
                >
                  <Typography variant="body2">
                    {filter.field} = {String(filter.value)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    From widget: {filter.sourceWidgetId}
                  </Typography>
                  <Tooltip title="Remove cross-filter">
                    <IconButton
                      size="small"
                      onClick={() => controller.removeFilter(filter.id)}
                      aria-label="Remove cross-filter"
                      sx={{ position: 'absolute', top: 2, right: 2 }}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </Collapse>
    </div>
  );
}
