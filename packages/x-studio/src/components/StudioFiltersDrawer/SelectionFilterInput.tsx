'use client';
import * as React from 'react';
import {
  Box,
  Checkbox,
  Divider,
  FormControlLabel,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { FIELD_VALUES_CAP } from './useFieldValues';

export function SelectionFilterInput({
  values,
  selected,
  onChange,
  exclude = false,
  onExcludeChange,
}: {
  values: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  /**
   * Whether the stored `operator` is `not_in` — i.e. the checked values are EXCLUDED.
   *
   * This editor used to render a plain checkbox list that never read or wrote `operator`,
   * while `summarizeFilter` branches on `not_in` and `compileRowTest` excludes on it. A
   * `not_in` selection filter therefore rendered with its values CHECKED — looking exactly
   * like an include list — above its own summary chip reading "is not: …", with the pipeline
   * excluding them and no control anywhere to see or change it.
   *
   * That state is reachable without `StudioFilterWidget`: `screenFilters` accepts it from a
   * host `initialState` or persisted doc, the wire `addFilter` mutation and both
   * `controller.addFilter`/`updateFilter` apply zero operator/mode validation, and
   * `applyFilterPreset` re-stamps preset filters into page scope with `operator` carried
   * through verbatim. The mode-switch reset (`buildModeReset`) deliberately leaves `operator`
   * untouched, and the operator self-repair effect bails out unless the mode is `condition`,
   * so nothing repaired it away either.
   */
  exclude?: boolean;
  /** Omit to render the toggle read-only-free (no exclude affordance at all). */
  onExcludeChange?: (next: boolean) => void;
}) {
  const localeText = useStudioLocaleText();
  const [search, setSearch] = React.useState('');
  const filtered = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));
  // `useFieldValues` caps distinct values at `FIELD_VALUES_CAP`. A length equal
  // to the cap means the field is high-cardinality and the list is truncated — nudge the user
  // to type in the search box to narrow it, since the truncated tail isn't shown otherwise.
  const isCapped = values.length >= FIELD_VALUES_CAP;

  const toggle = (v: string) => {
    if (selected.includes(v)) {
      onChange(selected.filter((s) => s !== v));
    } else {
      onChange([...selected, v]);
    }
  };

  const selectedSet = new Set(selected);
  const filteredSelectedCount = filtered.filter((v) => selectedSet.has(v)).length;
  const allFilteredSelected = filtered.length > 0 && filteredSelectedCount === filtered.length;
  const someFilteredSelected = filteredSelectedCount > 0 && !allFilteredSelected;

  const handleSelectAll = () => {
    if (allFilteredSelected || someFilteredSelected) {
      // Deselect all currently visible values
      const filteredSet = new Set(filtered);
      onChange(selected.filter((s) => !filteredSet.has(s)));
    } else {
      // Select all visible values (merge with already-selected)
      const next = new Set(selected);
      for (const v of filtered) {
        next.add(v);
      }
      onChange(Array.from(next));
    }
  };

  return (
    <Stack spacing={0.5}>
      <TextField
        size="small"
        placeholder={localeText.filterSearchValues}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        slotProps={{
          // A placeholder is only a last-resort accessible-name source — name the input
          // explicitly, the same way `MultiSelectControl`'s identical search box does.
          htmlInput: { 'aria-label': localeText.filterSearchValues },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 16 }} />
              </InputAdornment>
            ),
          },
        }}
      />
      {isCapped && (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="selection-filter-cap-hint"
        >
          {localeText.filterSelectionCapHint(FIELD_VALUES_CAP)}
        </Typography>
      )}
      <Box
        sx={{
          maxHeight: 180,
          overflowY: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
        }}
      >
        {filtered.length === 0 ? (
          <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
            {localeText.filterSelectionNoValues}
          </Typography>
        ) : (
          <React.Fragment>
            {/* Select All row */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                px: 0.5,
                cursor: 'default',
                borderBottom: 1,
                borderColor: 'divider',
              }}
              onClick={handleSelectAll}
            >
              {/* The adjacent Typography is not a <label>, so `role="checkbox"` would take its
                  name from nowhere. Name each checkbox explicitly — the select-all row from the
                  shared "Select all" key, each value row from the value it toggles. */}
              <Checkbox
                size="small"
                checked={allFilteredSelected}
                indeterminate={someFilteredSelected}
                onChange={handleSelectAll}
                onClick={(event) => event.stopPropagation()}
                slotProps={{ input: { 'aria-label': localeText.filterWidgetSelectAllLabel } }}
                sx={{ p: 0.5 }}
              />
              <Typography
                variant="body2"
                sx={{ ml: 0.5, color: 'text.secondary', fontStyle: 'italic' }}
              >
                {localeText.filterSelectionAll}
              </Typography>
            </Box>
            <Divider />
            {filtered.map((v) => (
              <Box
                key={v}
                sx={{ display: 'flex', alignItems: 'center', px: 0.5, cursor: 'default' }}
                onClick={() => toggle(v)}
              >
                <Checkbox
                  size="small"
                  checked={selectedSet.has(v)}
                  onChange={() => toggle(v)}
                  onClick={(event) => event.stopPropagation()}
                  slotProps={{ input: { 'aria-label': v } }}
                  sx={{ p: 0.5 }}
                />
                <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0, ml: 0.5 }}>
                  {v}
                </Typography>
              </Box>
            ))}
          </React.Fragment>
        )}
      </Box>
      {/* Surface the include/exclude sense of the checked values. Without it a `not_in`
          filter is indistinguishable from an `in` one in this editor, while the card's own
          summary and the pipeline both treat it as an exclusion. Rendered whenever the caller
          can write `operator` back; `MultiSelectControl` uses the same two labels. */}
      {onExcludeChange && (
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={exclude}
              onChange={(event) => onExcludeChange(event.target.checked)}
            />
          }
          label={
            <Typography variant="caption" color={exclude ? 'error.main' : 'text.secondary'}>
              {exclude
                ? localeText.filterWidgetExcludingLabel
                : localeText.filterWidgetExcludeLabel}
            </Typography>
          }
          sx={{ ml: 0 }}
        />
      )}
      {selected.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          {localeText.filterSelectionSelectedCount(selected.length)}
        </Typography>
      )}
    </Stack>
  );
}
