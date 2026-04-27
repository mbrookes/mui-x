'use client';
import * as React from 'react';
import { Box, Checkbox, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

export function SelectionFilterInput({
  values,
  selected,
  onChange,
}: {
  values: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [search, setSearch] = React.useState('');
  const filtered = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));

  const toggle = (v: string) => {
    if (selected.includes(v)) {
      onChange(selected.filter((s) => s !== v));
    } else {
      onChange([...selected, v]);
    }
  };

  return (
    <Stack spacing={0.5}>
      <TextField
        size="small"
        placeholder="Search values…"
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
            No values found.
          </Typography>
        ) : (
          filtered.map((v) => (
            <Box
              key={v}
              sx={{ display: 'flex', alignItems: 'center', px: 0.5, cursor: 'pointer' }}
              onClick={() => toggle(v)}
            >
              <Checkbox
                size="small"
                checked={selected.includes(v)}
                onChange={() => toggle(v)}
                onClick={(event) => event.stopPropagation()}
                sx={{ p: 0.5 }}
              />
              <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0, ml: 0.5 }}>
                {v}
              </Typography>
            </Box>
          ))
        )}
      </Box>
      {selected.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          {selected.length} selected
        </Typography>
      )}
    </Stack>
  );
}
