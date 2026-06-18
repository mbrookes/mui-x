'use client';
import * as React from 'react';
import {
  Box,
  Checkbox,
  Divider,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

export function SelectionFilterInput({
  values,
  selected,
  onChange,
}: {
  values: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const localeText = useStudioLocaleText();
  const [search, setSearch] = React.useState('');
  const filtered = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));

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
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 16 }} />
              </InputAdornment>
            ),
          },
        }}
      />
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
              <Checkbox
                size="small"
                checked={allFilteredSelected}
                indeterminate={someFilteredSelected}
                onChange={handleSelectAll}
                onClick={(event) => event.stopPropagation()}
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
      {selected.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          {localeText.filterSelectionSelectedCount(selected.length)}
        </Typography>
      )}
    </Stack>
  );
}
