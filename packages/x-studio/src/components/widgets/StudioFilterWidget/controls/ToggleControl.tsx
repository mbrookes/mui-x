'use client';
import * as React from 'react';
import { Box, Chip, InputAdornment, Stack, TextField, Tooltip, Typography } from '@mui/material';
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
      {isActive && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title={localeText.filterWidgetClearAriaLabel}>
            <Box
              component="span"
              role="button"
              tabIndex={0}
              aria-label={localeText.filterWidgetClearAriaLabel}
              onClick={onClear}
              onKeyDown={(evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  onClear();
                }
              }}
              sx={{
                cursor: 'default',
                color: 'text.secondary',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </Box>
          </Tooltip>
        </Box>
      )}
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
      {filtered.length > 0 ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {filtered.map((v) => (
            <Chip
              key={v}
              label={v}
              size="small"
              color={selected.includes(v) ? 'primary' : 'default'}
              onClick={() => toggle(v)}
              aria-pressed={selected.includes(v)}
            />
          ))}
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          {localeText.filterWidgetNoOptionsLabel}
        </Typography>
      )}
    </Stack>
  );
}
