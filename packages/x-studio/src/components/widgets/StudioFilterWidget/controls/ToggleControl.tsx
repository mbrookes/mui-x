'use client';
import * as React from 'react';
import {
  Box,
  Chip,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import { useStudioLocaleText } from '../../../../internals/StudioUIConfigContext';

export interface StudioFilterToggleControlProps {
  label: string;
  values: string[];
  selected: string[];
  onApply: (v: string[]) => void;
  onClear: () => void;
}

const TOGGLE_SEARCH_THRESHOLD = 12;

export function ToggleControl(props: StudioFilterToggleControlProps) {
  const { label, values, selected, onApply, onClear } = props;
  const localeText = useStudioLocaleText();
  const isActive = selected.length > 0;
  const showSearch = values.length > TOGGLE_SEARCH_THRESHOLD;
  const [search, setSearch] = React.useState('');

  const filtered = search
    ? values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : values;

  // M10: a selected value the search term excludes is still ACTIVE — it is filtering the whole
  // page — so it has to stay on screen and stay deselectable. Append those chips after the
  // matches rather than dropping them, so narrowing the search can never hide a live selection.
  const hiddenSelected = selected.filter((v) => !filtered.includes(v));

  // Only "no options" when there genuinely are none. When the field has values and the search
  // simply matches nothing, `filterWidgetNoOptionsLabel` is a false statement about the data.
  const hasNoOptions = values.length === 0;
  const hasNoMatches = !hasNoOptions && filtered.length === 0;

  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v];
    if (next.length === 0) {
      onClear();
    } else {
      onApply(next);
    }
  };

  return (
    <Stack spacing={1} role="group" aria-label={label}>
      {showSearch && (
        <TextField
          size="small"
          fullWidth
          placeholder={localeText.filterSearchValues}
          value={search}
          onChange={(evt) => setSearch(evt.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
            },
          }}
        />
      )}
      {/* M10: the chip row and the Clear button are rendered UNCONDITIONALLY. They used to live
          inside a `filtered.length > 0` branch, so typing a search term that matched nothing
          replaced the selected chips AND the only Clear affordance with an italic "No options" —
          stranding a filter that was still filtering the whole page, with no control left to
          remove it without first clearing the search. `MultiSelectControl` never had this
          problem because its Clear lives in an always-rendered `ListSubheader`. */}
      {hasNoMatches && (
        <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          {localeText.filterWidgetNoSearchMatchesLabel}
        </Typography>
      )}
      {hasNoOptions ? (
        <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          {localeText.filterWidgetNoOptionsLabel}
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
          {[...filtered, ...hiddenSelected].map((v) => (
            <Chip
              key={v}
              label={v}
              size="small"
              color={selected.includes(v) ? 'primary' : 'default'}
              onClick={() => toggle(v)}
              aria-pressed={selected.includes(v)}
            />
          ))}
          {/* Clear sits inline as the last item so it wraps with the chips and never
              adds a dedicated row (which would make the widget taller). */}
          {isActive && (
            <Tooltip title={localeText.filterWidgetClearAriaLabel}>
              <IconButton
                size="small"
                aria-label={localeText.filterWidgetClearAriaLabel}
                onClick={onClear}
                sx={{ color: 'text.secondary', p: 0.25 }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      )}
    </Stack>
  );
}
