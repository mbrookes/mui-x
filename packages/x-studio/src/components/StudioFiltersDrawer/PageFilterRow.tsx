'use client';
import * as React from 'react';
import {
  Box,
  Collapse,
  FormControl,
  IconButton,
  InputLabel,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useStudioController } from '../../context';
import type { StudioFilterState } from '../../models';
import type { FieldOption, SimpleField } from './filterDrawerTypes';
import { getOperators, summarizeFilter, defaultValueForMode } from './filterDrawerUtils';
import { useFieldValues } from './useFieldValues';
import { FilterModeToggle } from './FilterModeToggle';
import { FilterBody } from './FilterBody';

export interface PageFilterRowProps {
  filter: StudioFilterState;
  fields: SimpleField[];
  fieldOptions: FieldOption[];
  onRemove: (id: string) => void;
}

export function PageFilterRow(props: PageFilterRowProps) {
  const { fields, fieldOptions, filter, onRemove } = props;
  const controller = useStudioController();
  const [expanded, setExpanded] = React.useState(true);

  const hasField = !!filter.field;
  const currentField = fields.find((f) => f.id === filter.field);
  const fieldType = filter.fieldType ?? currentField?.fieldType;
  const operators = getOperators(fieldType);
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;
  const activeOperator2 =
    filter.operator2 && operators.find((o) => o.value === filter.operator2)
      ? filter.operator2
      : operators[0].value;
  const fieldValues = useFieldValues(filter.field, fieldType);
  const fieldLabel = currentField?.label ?? filter.field;

  const handleChange = (changes: Partial<StudioFilterState>) => {
    controller.addFilter({ ...filter, ...changes });
  };

  // Phase 1: no field selected yet — show mode toggle then picker grouped by source
  if (!hasField) {
    const currentMode = filter.filterMode ?? 'condition';
    const pickableOptions =
      currentMode === 'rank' ? fieldOptions.filter((o) => o.fieldType === 'number') : fieldOptions;
    const groups = pickableOptions.reduce<Record<string, FieldOption[]>>((acc, opt) => {
      (acc[opt.sourceLabel] ??= []).push(opt);
      return acc;
    }, {});

    const handleModeChange = (newMode: typeof currentMode) => {
      handleChange({
        filterMode: newMode,
        value: defaultValueForMode(newMode),
        rankDirection: newMode === 'rank' ? 'top' : undefined,
        operator2: undefined,
        value2: undefined,
        conjunction: undefined,
      });
    };

    return (
      <Stack spacing={1}>
        <FilterModeToggle mode={currentMode} onChange={handleModeChange} />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <FormControl size="small" sx={{ flexGrow: 1 }}>
            <InputLabel>Select a field…</InputLabel>
            <Select
              label="Select a field…"
              value=""
              onChange={(event) => {
                const opt = pickableOptions.find(
                  (o) => `${o.sourceId}:${o.id}` === event.target.value,
                );
                if (opt) {
                  handleChange({
                    field: opt.id,
                    fieldType: opt.fieldType,
                    value: defaultValueForMode(currentMode),
                    operator: 'equals',
                  });
                }
              }}
            >
              {Object.entries(groups).map(([sourceLabel, opts]) => [
                <ListSubheader key={`hdr-${sourceLabel}`}>{sourceLabel}</ListSubheader>,
                ...opts.map((o) => (
                  <MenuItem key={`${o.sourceId}:${o.id}`} value={`${o.sourceId}:${o.id}`}>
                    {o.label}
                  </MenuItem>
                )),
              ])}
            </Select>
          </FormControl>
          <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Stack>
    );
  }

  // Phase 2: field selected — collapsible filter card
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 0.5,
          py: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 'medium' }}>
            {fieldLabel}
          </Typography>
          {!expanded && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {summarizeFilter(filter)}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(filter.id);
          }}
          aria-label="Remove filter"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <FilterBody
          filter={filter}
          fieldType={fieldType}
          operators={operators}
          activeOperator={activeOperator}
          activeOperator2={activeOperator2}
          fieldValues={fieldValues}
          onChange={handleChange}
        />
      </Collapse>
    </Box>
  );
}
